import { describe, expect, it } from 'vitest'
import { claudeArgs, parseClaudeOutput } from '../src/reasoners/claude.js'
import { codexArgs } from '../src/reasoners/codex.js'

describe('claudeArgs', () => {
  it('by default has no tools and does not read user settings or MCP config', () => {
    const args = claudeArgs({
      system: 'sys',
      model: 'claude-opus-5-5',
      readOnly: false,
    })
    expect(args).toEqual(expect.arrayContaining(['-p', '--strict-mcp-config']))
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('')
    expect(args[args.indexOf('--tools') + 1]).toBe('')
    expect(args[args.indexOf('--model') + 1]).toBe('claude-opus-5-5')
    // Output is always stream-json so progress steps can be recorded.
    expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json')
    expect(args).toContain('--verbose')
    expect(args).not.toContain('--input-format')
  })

  it('in read-only mode allows only read tools and denies the rest automatically', () => {
    const args = claudeArgs({ system: 'sys', readOnly: true })
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Grep,Glob')
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk')
    expect(args).not.toContain('--model')
  })
})

describe('MCP server connection', () => {
  const ops = [{ name: 'ops', url: 'http://ops-broker:8080/mcp' }]

  it('claude attaches servers with --mcp-config and allows only their tools', () => {
    const args = claudeArgs({ system: 's', readOnly: false, mcpServers: ops })
    expect(args[args.indexOf('--tools') + 1]).toBe('')
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('mcp__ops')
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk')
    expect(JSON.parse(args[args.indexOf('--mcp-config') + 1]!)).toEqual({
      mcpServers: { ops: { type: 'http', url: 'http://ops-broker:8080/mcp' } },
    })
  })

  it('claude can allow read-only tools and MCP tools together', () => {
    const args = claudeArgs({ system: 's', readOnly: true, mcpServers: ops })
    expect(args[args.indexOf('--allowedTools') + 1]).toBe(
      'Read,Grep,Glob,mcp__ops'
    )
  })

  it('codex attaches servers with -c mcp_servers.<name>.url', () => {
    const args = codexArgs({ mcpServers: ops })
    expect(args).toContain('mcp_servers.ops.url="http://ops-broker:8080/mcp"')
    expect(args).toContain(
      'mcp_servers.ops.default_tools_approval_mode="approve"'
    )
    expect(args.at(-1)).toBe('-')
  })
})

describe('codexArgs', () => {
  it('runs with the read-only sandbox, no approval requests, an ephemeral session, and the prompt on stdin', () => {
    const args = codexArgs({})
    expect(args[0]).toBe('exec')
    expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only')
    expect(args).toContain('approval_policy="never"')
    expect(args).toContain('--ephemeral')
    expect(args).toContain('--json')
    expect(args[args.indexOf('--disable') + 1]).toBe('apps')
    expect(args).not.toContain('--model')
    expect(args.at(-1)).toBe('-')
  })

  it('can pass the model and reasoning effort', () => {
    const args = codexArgs({ model: 'm1', reasoningEffort: 'medium' })
    expect(args[args.indexOf('--model') + 1]).toBe('m1')
    expect(args).toContain('model_reasoning_effort="medium"')
  })
})

describe('parseClaudeOutput', () => {
  it('returns text only for successful results', () => {
    expect(
      parseClaudeOutput(
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: ' yes \n',
        })
      )
    ).toBe('yes')
    expect(() =>
      parseClaudeOutput(
        JSON.stringify({ subtype: 'success', is_error: true, result: 'boom' })
      )
    ).toThrow(/boom/)
    expect(() => parseClaudeOutput('not json')).toThrow(/JSON/)
  })
})
