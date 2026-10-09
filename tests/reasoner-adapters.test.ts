import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { RunEvent } from '../src/history/types.js'
import { claudeAdapter } from '../src/reasoners/claude.js'
import { CliReasoner, createReasoner } from '../src/reasoners/cli.js'
import { codexAdapter } from '../src/reasoners/codex.js'
import type { ReasonerOptions } from '../src/reasoners/types.js'
import { DockerSandbox } from '../src/sandbox/docker.js'
import { HostSandbox } from '../src/sandbox/host.js'
import { ProcessExitError, type RunResult } from '../src/sandbox/process.js'
import type { Sandbox, SandboxRun } from '../src/sandbox/runtime.js'

const docker = new DockerSandbox({
  dockerBin: 'docker',
  image: 'img:1',
  network: 'sbx',
  proxyUrl: 'http://egress-proxy:8888',
  memory: '2g',
  cpus: '2',
})
const host = new HostSandbox()

const dir = mkdtempSync(path.join(tmpdir(), 'pacenote-adapters-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const image = path.join(dir, 'shot.png')
writeFileSync(image, 'png')

const claudeOptions: ReasonerOptions = {
  backend: 'claude',
  timeoutMs: 1000,
  auth: { env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok' } },
}
const codexOptions: ReasonerOptions = {
  backend: 'codex',
  timeoutMs: 1000,
  auth: { file: '/home/me/.codex/auth.json' },
}

describe('claude adapter', () => {
  it('reads files in any sandbox and works in the reference directory', async () => {
    expect(claudeAdapter.canReadFiles(docker)).toBe(true)
    const run = await claudeAdapter.invocation(
      { system: 's', prompt: 'p' },
      { sandbox: docker, options: claudeOptions, readOnlyDir: '/repo' }
    )
    expect(run.command).toBe('claude')
    expect(run.cwd).toEqual({ host: '/repo', at: '/workspace' })
    expect(run.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'tok' })
    expect(run.mounts ?? []).toEqual([])
    expect(run.input).toBe('p')
  })

  it('gives images on stdin as stream-json, without a mount', async () => {
    const run = await claudeAdapter.invocation(
      {
        system: 's',
        prompt: 'p',
        images: [{ path: image, mimetype: 'image/png' }],
      },
      { sandbox: docker, options: claudeOptions }
    )
    expect(run.args).toContain('stream-json')
    expect(JSON.parse(run.input).message.content[0].source.data).toBe(
      Buffer.from('png').toString('base64')
    )
    expect(run.mounts ?? []).toEqual([])
  })

  it('reads the cause of a failed run from its result line', () => {
    const stdout =
      '{"type":"result","subtype":"success","is_error":true,"result":"Invalid API key"}'
    expect(claudeAdapter.failure(stdout)).toMatch(/Invalid API key/)
    expect(claudeAdapter.failure('crashed')).toBeUndefined()
  })
})

describe('codex adapter', () => {
  it('does not read files in an isolated sandbox, and does on the host', () => {
    expect(codexAdapter.canReadFiles(docker)).toBe(false)
    expect(codexAdapter.canReadFiles(host)).toBe(true)
  })

  it('in a container gets its login, the attachments, and /out as mounts', async () => {
    const out = path.join(dir, 'out')
    const run = await codexAdapter.invocation(
      {
        system: 's',
        prompt: 'p',
        images: [{ path: image, mimetype: 'image/png' }],
        outputDir: out,
      },
      { sandbox: docker, options: codexOptions }
    )
    expect(run.mounts).toEqual([
      { host: '/home/me/.codex/auth.json', at: '/run/secrets/codex-auth.json' },
      { host: dir, at: '/attachments' },
      { host: out, at: '/out', writable: true },
    ])
    expect(run.args).toContain('--image=/attachments/shot.png')
    expect(run.input).toBe('<instructions>\ns\n</instructions>\n\np')
    expect(run.after).toBeUndefined()
  })

  it('on the host uses host paths and collects generated images afterwards', async () => {
    const run = await codexAdapter.invocation(
      {
        system: 's',
        prompt: 'p',
        images: [{ path: image, mimetype: 'image/png' }],
        outputDir: path.join(dir, 'out'),
      },
      { sandbox: host, options: { ...codexOptions, auth: undefined } }
    )
    expect(run.args).toContain(`--image=${image}`)
    expect(run.mounts?.some((mount) => mount.at === '/out')).toBe(false)
    expect(run.after).toBeTypeOf('function')
  })

  it('names the error event of a failed run', () => {
    const stdout = JSON.stringify({ type: 'error', message: 'quota exceeded' })
    expect(codexAdapter.failure(stdout)).toBe(
      'codex run failed: quota exceeded'
    )
    expect(codexAdapter.failure('')).toBeUndefined()
  })
})

/** Records what it is asked to run and answers with a canned result */
class FakeSandbox implements Sandbox {
  readonly kind = 'docker' as const
  readonly isolated = true
  runs: SandboxRun[] = []
  constructor(private readonly result: (run: SandboxRun) => RunResult) {}
  pathIn(mount: { at: string }, hostFile: string): string {
    return `${mount.at}/${path.basename(hostFile)}`
  }
  async run(run: SandboxRun): Promise<RunResult> {
    this.runs.push(run)
    return this.result(run)
  }
  async extractPdfText(): Promise<string> {
    return ''
  }
  async verify(): Promise<string[]> {
    return []
  }
}

const claudeResult = (text: string) =>
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    result: text,
    usage: { output_tokens: 3 },
  })

describe('CliReasoner', () => {
  it("runs the adapter's invocation in the sandbox and reports progress steps", async () => {
    const box = new FakeSandbox((run) => {
      const line = claudeResult('hello')
      run.onOutputLine?.(line)
      return { stdout: line, stderr: '' }
    })
    const reasoner = createReasoner(
      {
        ...claudeOptions,
        mcpServers: [{ name: 'ops', url: 'http://ops-broker:8080/mcp' }],
      },
      box
    )
    expect(reasoner).toMatchObject({
      backend: 'claude',
      sandbox: 'docker',
      canReadFiles: true,
      mcpServerNames: ['ops'],
    })
    const events: RunEvent[] = []
    const answer = await reasoner.complete({
      system: 's',
      prompt: 'p',
      readOnlyDir: '/repo',
      onEvent: (event) => events.push(event),
    })
    expect(answer).toBe('hello')
    expect(events.map((event) => event.kind)).toEqual(['usage'])
    expect(box.runs[0]).toMatchObject({ command: 'claude', timeoutMs: 1000 })
    expect(box.runs[0]?.cwd).toEqual({ host: '/repo', at: '/workspace' })
  })

  it('drops the reference directory when the CLI cannot read files there', async () => {
    const box = new FakeSandbox(() => ({
      stdout: JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'ok' },
      }),
      stderr: '',
    }))
    const reasoner = new CliReasoner(codexAdapter, codexOptions, box)
    expect(reasoner.canReadFiles).toBe(false)
    await expect(
      reasoner.complete({ system: 's', prompt: 'p', readOnlyDir: '/repo' })
    ).resolves.toBe('ok')
    expect(box.runs[0]?.cwd).toBeUndefined()
  })

  it("turns a failed run into the adapter's reason, keeping the exit as the cause", async () => {
    const stdout = JSON.stringify({
      type: 'turn.failed',
      error: { message: 'usage limit' },
    })
    const box = new FakeSandbox(() => {
      throw new ProcessExitError('exit 1', 1, stdout, '')
    })
    const reasoner = new CliReasoner(codexAdapter, codexOptions, box)
    const failure = await reasoner
      .complete({ system: 's', prompt: 'p' })
      .catch((err) => err)
    expect(failure.message).toBe('codex run failed: usage limit')
    expect(failure.cause).toBeInstanceOf(ProcessExitError)
  })

  it('passes other errors through unchanged', async () => {
    const box = new FakeSandbox(() => {
      throw new Error('docker is not running')
    })
    const reasoner = new CliReasoner(claudeAdapter, claudeOptions, box)
    await expect(
      reasoner.complete({ system: 's', prompt: 'p' })
    ).rejects.toThrow('docker is not running')
  })
})
