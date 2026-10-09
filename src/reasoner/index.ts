import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  claudeLineToEvents,
  codexLineToEvents,
  lastMessage,
} from '../history/events.js'
import type { RunEvent } from '../history/types.js'
import type { Executor } from './executor.js'
import { ProcessExitError } from './process.js'

export type ReasonerBackend = 'claude' | 'codex'

/**
 * Image passed to the model with the prompt (host path). All must be in the
 * same directory.
 */
export interface ReasonImage {
  path: string
  mimetype: string
}

export interface ReasonRequest {
  system: string
  prompt: string
  images?: ReasonImage[]
  /**
   * Host directory that receives outputs the CLI creates (codex generated
   * images)
   */
  outputDir?: string
  /** Directory to consult read-only. Ignored when canReadFiles is false. */
  readOnlyDir?: string
  signal?: AbortSignal
  /**
   * Called whenever the CLI prints a progress step (message, tool call, usage).
   */
  onEvent?: (event: RunEvent) => void
}

/**
 * Runs one inference with a local CLI (claude, codex) and returns the final
 * text.
 */
export interface Reasoner {
  readonly backend: ReasonerBackend
  /** Where it runs. host or docker sandbox */
  readonly sandbox: Executor['kind']
  /** Whether it can read files in the reference directory */
  readonly canReadFiles: boolean
  /** Names of the attached MCP servers */
  readonly mcpServerNames: string[]
  complete(request: ReasonRequest): Promise<string>
}

/** MCP server to attach to the reasoner CLI (Streamable HTTP) */
export interface McpServerRef {
  name: string
  url: string
}

export interface ReasonerOptions {
  backend: ReasonerBackend
  model?: string
  /**
   * codex model_reasoning_effort. Set explicitly because the sandbox cannot
   * read the host config.
   */
  codexReasoningEffort?: string
  timeoutMs: number
  mcpServers?: McpServerRef[]
}

const READ_ONLY_TOOLS = 'Read,Grep,Glob'

/**
 * claude -p arguments. An isolated run that does not read user settings, hooks,
 * or MCP config. With readOnly, only read tools are allowed and other
 * permission requests are denied automatically (dontAsk). Shell, web, and file
 * write tools are never granted.
 */
export function claudeArgs(options: {
  system: string
  model?: string
  readOnly: boolean
  mcpServers?: McpServerRef[]
  /** With images, passes stdin as stream-json (including image blocks). */
  streamInput?: boolean
}): string[] {
  const mcpServers = options.mcpServers ?? []
  // Output is always stream-json so progress steps can be recorded. The last
  // line is the final result.
  const args = [
    '-p',
    ...(options.streamInput ? ['--input-format', 'stream-json'] : []),
    '--output-format',
    'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--effort',
    'medium',
    '--system-prompt',
    options.system,
  ]
  if (options.model) args.push('--model', options.model)
  args.push('--tools', options.readOnly ? READ_ONLY_TOOLS : '')

  // Only allowlisted tools are used, and other permission requests are denied
  // automatically (dontAsk).
  const allowed = [
    ...(options.readOnly ? [READ_ONLY_TOOLS] : []),
    ...mcpServers.map((server) => `mcp__${server.name}`),
  ]
  if (allowed.length > 0) {
    args.push(
      '--allowedTools',
      allowed.join(','),
      '--permission-mode',
      'dontAsk'
    )
  }
  if (mcpServers.length > 0) {
    const config = Object.fromEntries(
      mcpServers.map((server) => [
        server.name,
        { type: 'http', url: server.url },
      ])
    )
    args.push('--mcp-config', JSON.stringify({ mcpServers: config }))
  }
  return args
}

/**
 * codex exec arguments. The prompt goes through stdin (-) and progress events
 * (JSONL) come back on stdout. App connectors linked to the ChatGPT account
 * (codex_apps, e.g. GitHub) are disabled. Their permission scope differs and
 * data leaves through another path, so external systems are queried only with
 * ops-broker tools. codex cannot disable its shell tool, so it is restricted
 * with the read-only sandbox (no writes, no network) and approval_policy=never
 * (no escalation requests).
 */
export function codexArgs(options: {
  model?: string
  reasoningEffort?: string
  mcpServers?: McpServerRef[]
  /** Image paths as seen from the container (or host) */
  images?: string[]
}): string[] {
  const args = [
    'exec',
    '--skip-git-repo-check',
    '--ephemeral',
    '--sandbox',
    'read-only',
    '-c',
    'approval_policy="never"',
    '--color',
    'never',
    '--json',
    '--disable',
    'apps',
  ]
  if (options.model) args.push('--model', options.model)
  if (options.reasoningEffort) {
    args.push('-c', `model_reasoning_effort="${options.reasoningEffort}"`)
  }
  for (const server of options.mcpServers ?? []) {
    args.push(
      '-c',
      `mcp_servers.${server.name}.url=${JSON.stringify(server.url)}`
    )
    // With approval_policy=never, MCP tools that are not read-only are
    // rejected. The broker's policy check decides allow/deny, so this server's
    // tools are approved automatically.
    args.push(
      '-c',
      `mcp_servers.${server.name}.default_tools_approval_mode="approve"`
    )
  }
  // --image takes multiple values, so each is passed in = form to keep it from
  // consuming the trailing -.
  for (const image of options.images ?? []) args.push(`--image=${image}`)
  args.push('-')
  return args
}

interface ClaudeJsonResult {
  type?: string
  subtype?: string
  is_error?: boolean
  result?: string
}

export function parseClaudeOutput(stdout: string): string {
  let parsed: ClaudeJsonResult
  try {
    // Reads the last result line for stream-json, or the whole output for json.
    const lines = stdout.trim().split('\n')
    const resultLine =
      lines.length > 1
        ? lines.reverse().find((line) => line.includes('"type":"result"'))
        : lines[0]
    parsed = JSON.parse(resultLine ?? '') as ClaudeJsonResult
  } catch {
    throw new Error(`claude output is not JSON: ${stdout.slice(0, 200)}`)
  }
  if (
    parsed.is_error ||
    parsed.subtype !== 'success' ||
    typeof parsed.result !== 'string'
  ) {
    const kind =
      parsed.subtype && parsed.subtype !== 'success'
        ? ` (${parsed.subtype})`
        : ''
    throw new Error(`claude run failed${kind}: ${parsed.result ?? ''}`)
  }
  return parsed.result.trim()
}

class ClaudeCliReasoner implements Reasoner {
  readonly backend = 'claude' as const
  readonly sandbox: Executor['kind']
  readonly canReadFiles: boolean
  readonly mcpServerNames: string[]

  constructor(
    private readonly options: ReasonerOptions,
    private readonly executor: Executor
  ) {
    this.sandbox = executor.kind
    this.mcpServerNames = (options.mcpServers ?? []).map(
      (server) => server.name
    )
    this.canReadFiles = executor.canReadFiles('claude')
  }

  async complete(request: ReasonRequest): Promise<string> {
    const referenceDir = this.canReadFiles ? request.readOnlyDir : undefined
    const images = request.images ?? []
    const onEvent = request.onEvent
    const run = this.executor.run({
      tool: 'claude',
      args: claudeArgs({
        system: request.system,
        model: this.options.model,
        readOnly: referenceDir !== undefined,
        mcpServers: this.options.mcpServers,
        streamInput: images.length > 0,
      }),
      // Images are passed as base64 blocks on stdin, without a mount.
      input:
        images.length > 0
          ? await claudeStreamInput(request.prompt, images)
          : request.prompt,
      referenceDir,
      timeoutMs: this.options.timeoutMs,
      signal: request.signal,
      onOutputLine: onEvent
        ? (line) => claudeLineToEvents(line).forEach((event) => onEvent(event))
        : undefined,
    })
    try {
      return parseClaudeOutput((await run).stdout)
    } catch (err) {
      // Failures such as auth errors exit with code 1 and put the result JSON
      // on stdout. Shows the cause from it.
      if (
        err instanceof ProcessExitError &&
        err.stdout.includes('"type":"result"')
      ) {
        parseClaudeOutput(err.stdout)
      }
      throw err
    }
  }
}

class CodexCliReasoner implements Reasoner {
  readonly backend = 'codex' as const
  readonly sandbox: Executor['kind']
  readonly canReadFiles: boolean
  readonly mcpServerNames: string[]

  constructor(
    private readonly options: ReasonerOptions,
    private readonly executor: Executor
  ) {
    this.sandbox = executor.kind
    this.mcpServerNames = (options.mcpServers ?? []).map(
      (server) => server.name
    )
    this.canReadFiles = executor.canReadFiles('codex')
  }

  async complete(request: ReasonRequest): Promise<string> {
    const images = request.images ?? []
    const attachmentsDir = images[0] ? path.dirname(images[0].path) : undefined
    const onEvent = request.onEvent
    const run = this.executor.run({
      tool: 'codex',
      args: codexArgs({
        model: this.options.model,
        reasoningEffort: this.options.codexReasoningEffort,
        mcpServers: this.options.mcpServers,
        images: images.map((image) => this.executor.attachmentPath(image.path)),
      }),
      attachmentsDir,
      outputDir: request.outputDir,
      // codex exec has no separate system prompt option, so the instructions
      // are prepended.
      input: `<instructions>\n${request.system}\n</instructions>\n\n${request.prompt}`,
      referenceDir: this.canReadFiles ? request.readOnlyDir : undefined,
      timeoutMs: this.options.timeoutMs,
      signal: request.signal,
      onOutputLine: onEvent
        ? (line) => codexLineToEvents(line).forEach((event) => onEvent(event))
        : undefined,
    })
    let stdout: string
    try {
      ;({ stdout } = await run)
    } catch (err) {
      // The failure cause is in the error events on stdout.
      const reason =
        err instanceof ProcessExitError ? codexError(err.stdout) : undefined
      if (reason) throw new Error(`codex run failed: ${reason}`, { cause: err })
      throw err
    }
    return parseCodexOutput(stdout)
  }
}

/** Reads the last agent_message in codex --json output as the final answer. */
export function parseCodexOutput(stdout: string): string {
  const events = stdout.split('\n').flatMap((line) => codexLineToEvents(line))
  const answer = lastMessage(events)
  if (answer) return answer
  const reason = codexError(stdout)
  throw new Error(
    reason ? `codex run failed: ${reason}` : 'codex returned an empty response.'
  )
}

function codexError(stdout: string): string | undefined {
  const errors = stdout
    .split('\n')
    .flatMap((line) => codexLineToEvents(line))
    .flatMap((event) => (event.kind === 'error' ? [event.message] : []))
  return errors.at(-1)
}

/**
 * claude stream-json input: one user message line with the image blocks
 * followed by the text prompt
 */
export async function claudeStreamInput(
  prompt: string,
  images: ReasonImage[]
): Promise<string> {
  const blocks = await Promise.all(
    images.map(async (image) => ({
      type: 'image',
      source: {
        type: 'base64',
        media_type: image.mimetype,
        data: (await readFile(image.path)).toString('base64'),
      },
    }))
  )
  const message = {
    role: 'user',
    content: [...blocks, { type: 'text', text: prompt }],
  }
  return `${JSON.stringify({ type: 'user', message })}\n`
}

export function createReasoner(
  options: ReasonerOptions,
  executor: Executor
): Reasoner {
  return options.backend === 'codex'
    ? new CodexCliReasoner(options, executor)
    : new ClaudeCliReasoner(options, executor)
}
