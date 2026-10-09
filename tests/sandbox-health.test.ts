import { describe, expect, it, vi } from 'vitest'
import { createLogger, type LogLevel } from '../src/logger.js'
import { SandboxHealth } from '../src/runtime/sandbox-health.js'

/** A logger that keeps its lines, to check what the bot log would say */
function recordingLogger() {
  const lines: string[] = []
  const log = createLogger('info', 'pacenote', [
    (_level: LogLevel, line: string) =>
      void lines.push(line.replace(/^\S+ /, '')),
  ])
  return { log, lines }
}

describe('sandbox health while the bot runs', () => {
  it('reports only changes, and says when the issues are resolved', async () => {
    const results = [
      ['The egress proxy is not running. (pnpm sandbox:up)'],
      ['The egress proxy is not running. (pnpm sandbox:up)'],
      [],
    ]
    const onChange = vi.fn()
    const { log, lines } = recordingLogger()
    const health = new SandboxHealth(
      async () => results.shift() ?? [],
      onChange,
      log
    )

    await health.check()
    expect(health.current).toEqual([
      'The egress proxy is not running. (pnpm sandbox:up)',
    ])
    await health.check() // unchanged: no report
    await health.check() // the proxy came up
    expect(onChange.mock.calls).toEqual([
      [['The egress proxy is not running. (pnpm sandbox:up)']],
      [[]],
    ])
    expect(lines).toEqual([
      'ERROR [pacenote] Sandbox: The egress proxy is not running. (pnpm sandbox:up)',
      'INFO  [pacenote] Sandbox ready: the earlier check issues are resolved.',
    ])
  })

  it('joins a check already in progress and survives a failing check', async () => {
    let release!: (problems: string[]) => void
    const verify = vi.fn(
      () => new Promise<string[]>((resolve) => (release = resolve))
    )
    const health = new SandboxHealth(
      verify,
      () => undefined,
      recordingLogger().log
    )
    const first = health.check()
    const second = health.check()
    expect(verify).toHaveBeenCalledTimes(1)
    release([])
    await Promise.all([first, second])

    const failing = new SandboxHealth(
      async () => {
        throw new Error('docker not found')
      },
      () => undefined,
      recordingLogger().log
    )
    await failing.check()
    expect(failing.current).toEqual(['Sandbox check failed: docker not found'])
  })
})
