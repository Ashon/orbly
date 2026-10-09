import { describe, expect, it, vi } from 'vitest'
import {
  ClaudeTokenSetup,
  findClaudeToken,
  plainText,
} from '../apps/desktop/src/claude-token.js'

const TOKEN = `sk-ant-oat01-${'Ab3_-'.repeat(20)}`

describe('claude setup-token for the sandbox', () => {
  it('finds the token in terminal output with escape codes and spinner frames', () => {
    // The start of a real run under script(1), then the token as a terminal
    // would draw it
    const output =
      '\x1b[?25l\x1b[>4;2mWelcome to Claude Code v2.1.295\r\n' +
      '\x1b]0;claude\x07· Opening browser to sign in…\r\x1b[2K✢\r\n' +
      `\x1b[1mYour OAuth token:\x1b[22m\r\n\x1b[32m${TOKEN}\x1b[39m\r\n`
    expect(plainText(output)).toContain('Welcome to Claude Code')
    expect(findClaudeToken(output)).toBe(TOKEN)
    expect(findClaudeToken('Opening browser to sign in…')).toBeUndefined()
  })

  it('saves the token it reads and reports success without handing the token back', async () => {
    const save = vi.fn(() => [])
    const setup = new ClaudeTokenSetup({
      toolPath: () => process.env.PATH ?? '',
      save,
      platform: 'darwin',
      command: [
        '/bin/sh',
        ['-c', `printf 'token:\\n${TOKEN}\\n'; exec sleep 30`],
      ],
    })
    expect(await setup.run()).toEqual({ ok: true })
    expect(save).toHaveBeenCalledWith(TOKEN)
    expect(setup.running).toBe(false)
  })

  it('reports why it ended without a token, and stops when cancelled', async () => {
    const save = vi.fn(() => [])
    const ended = new ClaudeTokenSetup({
      toolPath: () => process.env.PATH ?? '',
      save,
      platform: 'darwin',
      command: [
        '/bin/sh',
        ['-c', "printf 'Claude subscription required.\\n'; exit 1"],
      ],
    })
    expect(await ended.run()).toEqual({
      ok: false,
      error:
        'claude setup-token ended without a token: Claude subscription required.',
    })

    const waiting = new ClaudeTokenSetup({
      toolPath: () => process.env.PATH ?? '',
      save,
      platform: 'darwin',
      command: [
        '/bin/sh',
        ['-c', "printf 'Opening browser to sign in\\n'; exec sleep 30"],
      ],
    })
    const run = waiting.run()
    await vi.waitFor(() => expect(waiting.running).toBe(true))
    waiting.cancel()
    expect(await run).toEqual({ ok: false, error: 'Cancelled.' })
    expect(save).not.toHaveBeenCalled()

    const linux = new ClaudeTokenSetup({
      toolPath: () => '',
      save,
      platform: 'linux',
    })
    expect(await linux.run()).toMatchObject({
      ok: false,
      error: expect.stringContaining('terminal'),
    })
  })
})
