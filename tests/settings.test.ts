import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { checkConfig, EnvSchema } from '../src/config.js'
import { BrokerEnvSchema } from '../src/sandbox/env.js'
import {
  envKeys,
  formatEnvValue,
  readEnvFile,
  readEnvValues,
  updateEnvText,
  writeEnvFile,
} from '../src/settings/env-file.js'
import { MESSENGER_IDS } from '../src/messengers/ids.js'
import {
  maskSecret,
  SETTING_FIELDS,
  SETTING_GROUPS,
  setupSettingsRoute,
} from '../src/settings/fields.js'
import { checkSlackTokens } from '../src/messengers/slack/check.js'

const root = mkdtempSync(path.join(tmpdir(), 'pacenote-settings-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const ENV = `# Personal LLM settings
LLM_API_URL=https://llm.example.com
LLM_API_KEY=secret-value

# ---- Slack ----
SLACK_BOT_TOKEN=xoxb-old
SLACK_APP_TOKEN=xapp-1-A1-old
REASONER=codex
REASONER=claude
LOG_LEVEL=info
`

describe('.env editing', () => {
  it('changes only values and keeps comments, order, and unhandled entries', () => {
    const next = updateEnvText(ENV, {
      SLACK_BOT_TOKEN: 'xoxb-new',
      REASONER: 'codex',
      LOG_LEVEL: null,
      MENTION_ALLOWED_USERS: 'U1, U2',
    })
    expect(next).toBe(`# Personal LLM settings
LLM_API_URL=https://llm.example.com
LLM_API_KEY=secret-value

# ---- Slack ----
SLACK_BOT_TOKEN=xoxb-new
SLACK_APP_TOKEN=xapp-1-A1-old
REASONER=codex
LOG_LEVEL=

# Added from the Pacenote app settings screen
MENTION_ALLOWED_USERS='U1, U2'
`)
    expect(readEnvValues(next)).toMatchObject({
      LLM_API_KEY: 'secret-value',
      REASONER: 'codex',
      LOG_LEVEL: '',
      MENTION_ALLOWED_USERS: 'U1, U2',
    })
    expect(envKeys(next)).toContain('LLM_API_URL')
    expect(updateEnvText('', { A: '1' })).toBe(
      '# Added from the Pacenote app settings screen\nA=1\n'
    )
  })

  it('quotes special characters and reads back the same value as node', () => {
    for (const value of [
      'a "b" c',
      'x#y',
      'back\\slash',
      '~/.codex/auth.json',
      'Asia/Seoul',
    ]) {
      expect(readEnvValues(`K=${formatEnvValue(value)}\n`).K).toBe(value)
    }
    expect(formatEnvValue('xoxb-1-abc')).toBe('xoxb-1-abc')
    expect(formatEnvValue('~/.codex/auth.json')).toBe('~/.codex/auth.json')
    expect(() => formatEnvValue('a\nb')).toThrow(/line break/)
  })

  it('keeps the existing mode and writes new files as 600', () => {
    const file = path.join(root, '.env')
    writeEnvFile(file, 'A=1\n')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    writeFileSync(file, 'A=1\n', { mode: 0o640 })
    writeEnvFile(file, 'A=2\n')
    expect(readEnvFile(file)).toBe('A=2\n')
    expect(readEnvFile(path.join(root, 'missing'))).toBe('')
  })
})

describe('setting fields', () => {
  it('puts every field in the bot or broker config with matching defaults', () => {
    // Slack credentials depend on SLACK_CONNECTION, so the schema itself
    // requires none of them.
    const botDefaults = EnvSchema.parse({}) as Record<string, unknown>
    const brokerDefaults = BrokerEnvSchema.parse({}) as Record<string, unknown>
    for (const field of SETTING_FIELDS) {
      const inBot = field.key in EnvSchema.shape
      const inBroker = field.key in BrokerEnvSchema.shape
      expect([field.key, inBot || inBroker]).toEqual([field.key, true])
      // Values the broker reads are applied by recreating the broker.
      expect([field.key, field.applies === 'broker']).toEqual([
        field.key,
        inBroker,
      ])
      if (field.required) continue
      const value = (inBot ? botDefaults : brokerDefaults)[field.key]
      // An empty comma list is read as [].
      const unset =
        value === undefined || (Array.isArray(value) && value.length === 0)
      expect([field.key, unset ? undefined : String(value)]).toEqual([
        field.key,
        field.default,
      ])
    }
  })

  it("keeps every messenger's groups in the Messengers section, which setup opens first", () => {
    const messengerGroups = SETTING_GROUPS.filter((group) => group.messenger)
    expect(messengerGroups.map((group) => group.section)).toEqual(
      messengerGroups.map(() => 'messengers')
    )
    expect(
      MESSENGER_IDS.every((id) =>
        messengerGroups.some((g) => g.messenger === id)
      )
    ).toBe(true)
    expect(setupSettingsRoute()).toBe('#/settings/messengers')
    expect(setupSettingsRoute([{ key: 'MENTION_ALLOWED_USERS' }])).toBe(
      '#/settings/messengers'
    )
    expect(setupSettingsRoute([{ key: 'OPS_TOOLS' }])).toBe('#/settings/ops')
  })

  it('shows only the prefix and last 4 characters of secrets', () => {
    expect(maskSecret('xoxb-1234-5678-abcd')).toBe('xoxb-...abcd')
    expect(maskSecret('xapp-1-A1-zzzz9999')).toBe('xapp-...9999')
  })

  it('returns validation issues per environment variable', () => {
    const base = { SLACK_BOT_TOKEN: 'xoxb-1', SLACK_APP_TOKEN: 'xapp-1' }
    expect(checkConfig(base)).toEqual([])
    expect(
      checkConfig({
        ...base,
        SLACK_BOT_TOKEN: 'xoxp-1',
        MENTION_CONCURRENCY: '0',
      })
    ).toEqual([
      { key: 'SLACK_BOT_TOKEN', message: expect.stringContaining('xoxb-') },
      expect.objectContaining({ key: 'MENTION_CONCURRENCY' }),
    ])
    expect(
      checkConfig({ ...base, OPS_TOOLS: 'on', MENTION_ALLOWED_USERS: 'U1' })
    ).toEqual([
      {
        key: 'OPS_TOOLS',
        message: expect.stringContaining('REASONER_SANDBOX=docker'),
      },
    ])
  })
})

describe('connection check', () => {
  it('checks the bot token, scopes, same app, and Socket Mode', async () => {
    const calls: string[] = []
    const fetchImpl = (async (
      url: string | URL | Request,
      init?: RequestInit
    ) => {
      const method = String(url).split('/').pop()!
      calls.push(
        `${method} ${(init?.headers as Record<string, string>).Authorization}`
      )
      const bodies: Record<string, object> = {
        'auth.test': {
          ok: true,
          user: 'pacey',
          user_id: 'U0V',
          team: 'T',
          bot_id: 'B1',
        },
        'bots.info': { ok: true, bot: { app_id: 'A0APP' } },
        'apps.connections.open': { ok: true, url: 'wss://example/?ticket=t' },
      }
      return new Response(JSON.stringify(bodies[method]), {
        headers: {
          'x-oauth-scopes': 'app_mentions:read,channels:history,chat:write',
        },
      })
    }) as typeof fetch
    const items = await checkSlackTokens(
      { botToken: 'xoxb-1', appToken: 'xapp-1-A0APP-zz' },
      fetchImpl
    )
    expect(items.map((item) => item.ok)).toEqual([true, false, true, true])
    expect(items[0]?.detail).toBe('pacey (U0V) @ T')
    expect(items[1]?.detail).toContain(
      'channels:read, files:read, files:write, users:read'
    )
    expect(items[2]?.detail?.match(/A0APP/g)).toHaveLength(2)
    expect(calls).toEqual([
      'auth.test Bearer xoxb-1',
      'bots.info Bearer xoxb-1',
      'apps.connections.open Bearer xapp-1-A0APP-zz',
    ])
    expect(await checkSlackTokens({ botToken: 'xoxb-1' })).toEqual([
      expect.objectContaining({ ok: false }),
    ])
  })
})
