import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { BRANCH_PREFIX, isAgentBranch } from '../src/broker/git.js'
import { HistoryReader } from '../src/history/reader.js'
import { handleLocalApi } from '../src/local-api.js'
import {
  BotAlreadyRunningError,
  BotStatusFile,
  readRunningBot,
  STATUS_FILE,
} from '../src/runtime/status.js'
import {
  applyLegacyEnv,
  botLockDirs,
  defaultHome,
  envNames,
  envValue,
  legacyHomeWarning,
  warnOnce,
} from '../src/settings/legacy.js'
import { loadEnv } from '../src/settings/load-env.js'
import { loadBrokerEnv } from '../src/sandbox/env.js'
import { pacenoteHome } from '../src/settings/paths.js'
import { jobEnv } from '../src/tools/sandbox-job.js'

const root = mkdtempSync(path.join(tmpdir(), 'pacenote-legacy-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** A home folder with the given dot folders in it */
function homeWith(...dirs: string[]): string {
  const home = mkdtempSync(path.join(root, 'home-'))
  for (const dir of dirs) mkdirSync(path.join(home, dir))
  return home
}

describe('names from before the renames (Orbly, Verda)', () => {
  it('reads ORBLY_* and VERDA_* as PACENOTE_* unless a newer name is set, with a message per old name', () => {
    const env: NodeJS.ProcessEnv = {
      VERDA_DATA_DIR: '/data/old',
      ORBLY_SANDBOX_DIR: '/sandbox/orbly',
      VERDA_SANDBOX_DIR: '/sandbox/verda',
      VERDA_DESKTOP_THEME: 'dark',
      PACENOTE_DESKTOP_THEME: 'light',
      ORBLY_EMPTY: ' ',
    }
    const messages = applyLegacyEnv(env)
    expect(env.PACENOTE_DATA_DIR).toBe('/data/old')
    // Orbly is newer than Verda, so its value wins.
    expect(env.PACENOTE_SANDBOX_DIR).toBe('/sandbox/orbly')
    expect(env.PACENOTE_DESKTOP_THEME).toBe('light')
    expect(env.PACENOTE_EMPTY).toBeUndefined()
    expect(messages).toEqual([
      'ORBLY_SANDBOX_DIR is deprecated and read as PACENOTE_SANDBOX_DIR. Rename it to PACENOTE_SANDBOX_DIR.',
      'VERDA_DATA_DIR is deprecated and read as PACENOTE_DATA_DIR. Rename it to PACENOTE_DATA_DIR.',
      'VERDA_SANDBOX_DIR is deprecated and PACENOTE_SANDBOX_DIR takes its place. Rename or remove VERDA_SANDBOX_DIR.',
      'VERDA_DESKTOP_THEME is deprecated and PACENOTE_DESKTOP_THEME takes its place. Rename or remove VERDA_DESKTOP_THEME.',
    ])
    expect(envNames('DATA_DIR')).toEqual([
      'PACENOTE_DATA_DIR',
      'ORBLY_DATA_DIR',
      'VERDA_DATA_DIR',
    ])
    expect(envValue({ VERDA_SANDBOX_DIR: '/old' }, 'SANDBOX_DIR')).toBe('/old')
    expect(
      envValue(
        { ORBLY_SANDBOX_DIR: '/o', VERDA_SANDBOX_DIR: '/v' },
        'SANDBOX_DIR'
      )
    ).toBe('/o')
    expect(
      envValue(
        { PACENOTE_SANDBOX_DIR: '/new', ORBLY_SANDBOX_DIR: '/o' },
        'SANDBOX_DIR'
      )
    ).toBe('/new')
  })

  it('warns once per message', () => {
    const warn = vi.fn()
    warnOnce(['legacy test A', 'legacy test B'], warn)
    warnOnce(['legacy test A'], warn)
    expect(warn.mock.calls).toEqual([['legacy test A'], ['legacy test B']])
  })

  it('uses an earlier home only while ~/.pacenote does not exist, the newest first, and says how to move it', () => {
    const fresh = homeWith()
    expect(defaultHome(fresh)).toBe(path.join(fresh, '.pacenote'))
    expect(legacyHomeWarning({}, fresh)).toBeUndefined()

    const verda = homeWith('.verda')
    expect(defaultHome(verda)).toBe(path.join(verda, '.verda'))
    expect(pacenoteHome({}, verda)).toBe(path.join(verda, '.verda'))
    expect(legacyHomeWarning({}, verda)).toMatch(
      /mv ~\/\.verda ~\/\.pacenote, rename the VERDA_\* keys in \.env to PACENOTE_\*/
    )

    const orbly = homeWith('.orbly', '.verda')
    expect(defaultHome(orbly)).toBe(path.join(orbly, '.orbly'))
    expect(legacyHomeWarning({}, orbly)).toMatch(
      /rename to Pacenote[\s\S]*mv ~\/\.orbly ~\/\.pacenote, rename the ORBLY_\* keys/
    )
    // A location that is set is used as is, without the warning.
    expect(
      legacyHomeWarning({ PACENOTE_HOME: '/srv/pacenote' }, orbly)
    ).toBeUndefined()
    expect(
      legacyHomeWarning({ ORBLY_HOME: '/srv/orbly' }, orbly)
    ).toBeUndefined()

    const all = homeWith('.verda', '.orbly', '.pacenote')
    expect(defaultHome(all)).toBe(path.join(all, '.pacenote'))
    expect(legacyHomeWarning({}, all)).toBeUndefined()
  })

  it('reads ORBLY_HOME, then VERDA_HOME, when PACENOTE_HOME is not set', () => {
    expect(pacenoteHome({ VERDA_HOME: '/srv/verda' }, '/home/me')).toBe(
      '/srv/verda'
    )
    expect(
      pacenoteHome(
        { VERDA_HOME: '/srv/verda', ORBLY_HOME: '/srv/orbly' },
        '/home/me'
      )
    ).toBe('/srv/orbly')
    expect(
      pacenoteHome(
        { ORBLY_HOME: '/srv/orbly', PACENOTE_HOME: '~/p' },
        '/home/me'
      )
    ).toBe('/home/me/p')
  })

  it('loads the settings file from an old home and maps its old keys', () => {
    const home = path.join(root, 'load-env-home')
    mkdirSync(home, { recursive: true })
    writeFileSync(
      path.join(home, '.env'),
      'ORBLY_DATA_DIR=/data/from-file\nLOG_LEVEL=debug\nREASONER=codex\n'
    )
    const env: NodeJS.ProcessEnv = { VERDA_HOME: home, REASONER: 'claude' }
    const warnings = loadEnv(env)
    expect(env).toMatchObject({
      PACENOTE_HOME: home,
      PACENOTE_DATA_DIR: '/data/from-file',
      LOG_LEVEL: 'debug',
      // The existing environment wins over the file, as with node --env-file.
      REASONER: 'claude',
    })
    expect(warnings).toContain(
      'VERDA_HOME is deprecated and read as PACENOTE_HOME. Rename it to PACENOTE_HOME.'
    )
    expect(warnings).toContain(
      'ORBLY_DATA_DIR is deprecated and read as PACENOTE_DATA_DIR. Rename it to PACENOTE_DATA_DIR.'
    )
  })

  it('passes compose the resolved home and the mapped keys', () => {
    const home = homeWith('.orbly')
    const envFile = path.join(home, '.orbly', '.env')
    writeFileSync(envFile, 'ORBLY_SANDBOX_DIR=/old/sandbox\nOPS_TOOLS=on\n')
    const warn = vi.fn()
    const env = jobEnv({ HOME: home }, envFile, warn)
    expect(env).toMatchObject({
      PACENOTE_HOME: path.join(home, '.orbly'),
      PACENOTE_SANDBOX_DIR: '/old/sandbox',
      OPS_TOOLS: 'on',
    })
    expect(
      warn.mock.calls.map(([message]) => message as string).join('\n')
    ).toMatch(
      /mv ~\/\.orbly ~\/\.pacenote[\s\S]*ORBLY_SANDBOX_DIR is deprecated/
    )
  })

  it('sees a bot running from any earlier home, so old and new never connect together', async () => {
    const home = homeWith('.verda', '.orbly', '.pacenote')
    const verda = path.join(home, '.verda')
    const orbly = path.join(home, '.orbly')
    const fresh = path.join(home, '.pacenote')
    expect(botLockDirs(fresh, home)).toEqual([fresh, orbly, verda])
    expect(botLockDirs('/data/custom', home)).toEqual([
      '/data/custom',
      fresh,
      orbly,
      verda,
    ])

    // The parent process stands in for an old bot that is still running, from
    // each earlier home in turn.
    for (const legacy of [orbly, verda]) {
      const status = path.join(legacy, STATUS_FILE)
      writeFileSync(
        status,
        JSON.stringify({ version: 1, pid: process.ppid, managedBy: 'desktop' })
      )
      expect(readRunningBot([fresh, orbly, verda])).toMatchObject({
        alive: true,
        status: { pid: process.ppid },
      })
      await expect(
        BotStatusFile.acquire(fresh, 'terminal', 0, [orbly, verda])
      ).rejects.toBeInstanceOf(BotAlreadyRunningError)
      rmSync(status)
    }
  })

  it('shows run history written by Verda and Orbly (record version 1)', async () => {
    const dataDir = path.join(homeWith('.verda'), '.verda')
    const runDir = path.join(
      dataDir,
      'runs',
      '2026-10-09',
      '20261009-084701-54e64d'
    )
    mkdirSync(runDir, { recursive: true })
    // A record as Verda v0.1.x and Orbly v0.2.x wrote it
    writeFileSync(
      path.join(runDir, 'run.json'),
      JSON.stringify({
        version: 1,
        id: '20261009-084701-54e64d',
        status: 'succeeded',
        attempts: 1,
        startedAt: '2026-10-08T23:47:01.716Z',
        updatedAt: '2026-10-08T23:47:31.716Z',
        slack: {
          channel: 'C03',
          channelLabel: '#ops',
          threadTs: '1',
          eventTs: '1',
          placeholderTs: '1',
          userId: 'U03',
          userName: 'alice',
        },
        request: 'Why did the nightly backup job fail?',
        backend: {
          reasoner: 'claude',
          sandbox: 'docker',
          model: 'claude-opus-5-5',
        },
        context: { messages: 0 },
        attachments: [],
        events: [
          {
            kind: 'message',
            at: '2026-10-08T23:47:01.716Z',
            text: 'Checked it.',
          },
        ],
        outputs: [],
        answer: 'The backup volume was full.',
        finishedAt: '2026-10-08T23:47:31.716Z',
        durationMs: 30_000,
      })
    )
    const reader = new HistoryReader(dataDir)
    const get = async (pathname: string) =>
      (
        await handleLocalApi(reader, 'GET', new URL(pathname, 'pacenote://app'))
      ).json()
    expect(await get('/api/runs')).toMatchObject([
      {
        id: '20261009-084701-54e64d',
        status: 'succeeded',
        reasoner: 'claude@docker',
      },
    ])
    expect(await get('/api/runs/20261009-084701-54e64d')).toMatchObject({
      request: 'Why did the nightly backup job fail?',
      answer: 'The backup volume was full.',
    })
  })
})

describe('sandbox names from before the renames (Orbly, Verda)', () => {
  it("creates pacenote/* branches and still recognizes orbly/* and verda/* ones as the agent's", () => {
    expect(BRANCH_PREFIX).toBe('pacenote/')
    expect(isAgentBranch('pacenote/20261009-1a2b3c4d')).toBe(true)
    expect(isAgentBranch('orbly/20261005-1a2b3c4d')).toBe(true)
    expect(isAgentBranch('verda/20261001-1a2b3c4d')).toBe(true)
    expect(isAgentBranch('main')).toBe(false)
    expect(isAgentBranch('feature/orbly/x')).toBe(false)
  })

  it('defaults to the pacenote-ro account and keeps orbly-ro or verda-ro when it is set', () => {
    expect(loadBrokerEnv({})).toMatchObject({
      OPS_K8S_SA: 'pacenote-ro',
      OPS_K8S_SA_NAMESPACE: 'pacenote',
    })
    expect(
      loadBrokerEnv({ OPS_K8S_SA: 'orbly-ro', OPS_K8S_SA_NAMESPACE: 'orbly' })
    ).toMatchObject({ OPS_K8S_SA: 'orbly-ro', OPS_K8S_SA_NAMESPACE: 'orbly' })
    expect(
      loadBrokerEnv({ OPS_K8S_SA: 'verda-ro', OPS_K8S_SA_NAMESPACE: 'verda' })
    ).toMatchObject({ OPS_K8S_SA: 'verda-ro', OPS_K8S_SA_NAMESPACE: 'verda' })
  })
})
