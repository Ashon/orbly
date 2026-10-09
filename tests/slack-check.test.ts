import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { missingScopes, REQUIRED_BOT_SCOPES } from '../src/tools/check-slack.js'

/** Reads the oauth_config.scopes.bot list from the manifest. */
function manifestBotScopes(): string[] {
  const lines = readFileSync(
    new URL('../slack-app-manifest.yaml', import.meta.url),
    'utf8'
  ).split('\n')
  const start = lines.findIndex((line) => line === '    bot:')
  const scopes: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (/^\s*#/.test(line)) continue
    const match = /^ {6}- (\S+)$/.exec(line)
    if (!match) break
    scopes.push(match[1]!)
  }
  return scopes
}

describe('REQUIRED_BOT_SCOPES', () => {
  it('matches the manifest', () => {
    expect([...REQUIRED_BOT_SCOPES].sort()).toEqual(manifestBotScopes().sort())
  })

  it('finds missing scopes', () => {
    expect(missingScopes(['a', 'b', 'c'], ['b'])).toEqual(['a', 'c'])
  })
})
