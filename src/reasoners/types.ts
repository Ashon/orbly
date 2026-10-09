import type { RunEvent } from '../history/types.js'
import type { Sandbox, SandboxKind, SandboxRun } from '../sandbox/runtime.js'
import type { ReasonerId } from './ids.js'

/**
 * What the mention pipeline needs from a reasoner: one inference, with progress
 * steps along the way. Each CLI is an adapter (src/reasoners/<id>.ts) behind
 * one runner (cli.ts), and runs in whatever Sandbox it is given
 * (src/sandbox/runtime.ts), so a new CLI is a new adapter and a new kind of
 * isolation is a new sandbox.
 */

export type { ReasonerId }

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

/** Runs one inference with a local CLI and returns the final text. */
export interface Reasoner {
  readonly backend: ReasonerId
  /** Where it runs */
  readonly sandbox: SandboxKind
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

/**
 * Credentials for a CLI that cannot reach the host's login (in an isolated
 * sandbox): values for its environment (claude's token), or a file it reads
 * (codex's auth.json).
 */
export interface ReasonerAuth {
  env?: Record<string, string>
  file?: string
}

export interface ReasonerOptions {
  backend: ReasonerId
  model?: string
  /** For CLIs that take it (codex's model_reasoning_effort) */
  reasoningEffort?: string
  timeoutMs: number
  mcpServers?: McpServerRef[]
  auth?: ReasonerAuth
}

/** What an adapter asks the sandbox to run for one request */
export interface CliInvocation extends Omit<
  SandboxRun,
  'timeoutMs' | 'signal' | 'onOutputLine'
> {
  /**
   * Runs after the process ends, success or not: for outputs the CLI leaves
   * outside the mounts
   */
  after?: () => Promise<void>
}

/**
 * One CLI's specifics: how to call it, what it can do, and how to read what it
 * prints
 */
export interface CliAdapter {
  readonly id: ReasonerId
  /** Whether it can read the reference directory in this sandbox */
  canReadFiles(sandbox: Sandbox): boolean
  invocation(
    request: ReasonRequest,
    context: {
      sandbox: Sandbox
      options: ReasonerOptions
      readOnlyDir?: string
    }
  ): Promise<CliInvocation>
  /** Progress steps in one line of its output */
  events(line: string): RunEvent[]
  /**
   * The final answer in its output. Throws with the cause when there is none.
   */
  answer(stdout: string): string
  /**
   * Why a run that exited with an error failed, from its output, as the error
   * message
   */
  failure(stdout: string): string | undefined
}
