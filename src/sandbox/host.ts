import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runProcess, type RunResult } from './process.js'
import {
  PDFTOTEXT_ARGS,
  type Mount,
  type Sandbox,
  type SandboxRun,
} from './runtime.js'

/**
 * Runs the CLI directly on this computer, with the user's own login and files.
 * No isolation: mounts are only the host paths themselves, and the CLI's own
 * sandboxing (read-only tools, codex's read-only mode) is all there is.
 */
export class HostSandbox implements Sandbox {
  readonly kind = 'host' as const
  readonly isolated = false

  /**
   * commands: binary paths by CLI name (CLAUDE_BIN, CODEX_BIN); others run by
   * name from PATH
   */
  constructor(private readonly commands: Record<string, string> = {}) {}

  pathIn(_mount: Mount, hostFile: string): string {
    return hostFile
  }

  async extractPdfText(pdfPath: string): Promise<string> {
    const { stdout } = await runProcess(
      'pdftotext',
      [...PDFTOTEXT_ARGS, pdfPath, '-'],
      {
        cwd: path.dirname(pdfPath),
        input: '',
        timeoutMs: 60_000,
      }
    )
    return stdout
  }

  async run(run: SandboxRun): Promise<RunResult> {
    const exec = (cwd: string) =>
      runProcess(this.commands[run.command] ?? run.command, run.args, {
        cwd,
        input: run.input,
        timeoutMs: run.timeoutMs,
        signal: run.signal,
        env: run.env ? { ...process.env, ...run.env } : undefined,
        onStdoutLine: run.onOutputLine,
      })
    if (run.cwd) return exec(run.cwd.host)
    // Without a reference directory, runs in an empty temporary directory.
    const scratch = await mkdtemp(path.join(tmpdir(), 'pacenote-'))
    try {
      return await exec(scratch)
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  }

  async verify(): Promise<string[]> {
    return []
  }
}
