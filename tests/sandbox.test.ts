import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { parseCodexDefaults } from '../src/reasoners/codex.js'
import {
  dockerRunArgs,
  DockerSandbox,
  type DockerSandboxOptions,
} from '../src/sandbox/docker.js'

const options: DockerSandboxOptions = {
  dockerBin: 'docker',
  image: 'img:1',
  network: 'sbx',
  proxyUrl: 'http://egress-proxy:8888',
  memory: '2g',
  cpus: '2',
}

const valueAfter = (args: string[], flag: string) =>
  args[args.indexOf(flag) + 1]

describe('dockerRunArgs', () => {
  const args = dockerRunArgs(
    options,
    {
      command: 'claude',
      args: ['-p'],
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'secret-token' },
      cwd: { host: '/repo', at: '/workspace' },
    },
    'c1'
  )

  it('applies all isolation options', () => {
    expect(args.slice(0, 3)).toEqual(['run', '--rm', '-i'])
    expect(args).toContain('--read-only')
    expect(valueAfter(args, '--network')).toBe('sbx')
    expect(valueAfter(args, '--cap-drop')).toBe('ALL')
    expect(valueAfter(args, '--security-opt')).toBe('no-new-privileges')
    expect(valueAfter(args, '--user')).toBe('1000:1000')
    expect(args).toContain('HTTPS_PROXY=http://egress-proxy:8888')
  })

  it('mounts the working directory read-only and passes environment values by name only', () => {
    expect(args).toContain('/repo:/workspace:ro')
    expect(valueAfter(args, '-w')).toBe('/workspace')
    expect(args).toContain('CLAUDE_CODE_OAUTH_TOKEN')
    expect(args.join(' ')).not.toContain('secret-token')
    expect(args.slice(-3)).toEqual(['img:1', 'claude', '-p'])
  })

  it('passes NO_PROXY so internal services bypass the proxy', () => {
    const withBroker = dockerRunArgs(
      { ...options, noProxy: ['ops-broker'] },
      { command: 'codex', args: [] },
      'c3'
    )
    expect(withBroker).toContain('NO_PROXY=ops-broker')
    expect(args.some((a) => a.startsWith('NO_PROXY='))).toBe(false)
  })

  it('mounts read-only unless writable, and starts in an empty directory without a working directory', () => {
    const run = dockerRunArgs(
      options,
      {
        command: 'codex',
        args: ['exec'],
        mounts: [
          {
            host: '/home/me/.codex/auth.json',
            at: '/run/secrets/codex-auth.json',
          },
          { host: '/tmp/out', at: '/out', writable: true },
        ],
      },
      'c2'
    )
    expect(run).toContain(
      '/home/me/.codex/auth.json:/run/secrets/codex-auth.json:ro'
    )
    expect(run).toContain('/tmp/out:/out')
    expect(valueAfter(run, '-w')).toBe('/work')
    expect(run.some((a) => a.endsWith(':/workspace:ro'))).toBe(false)
  })
})

describe('DockerSandbox.pathIn', () => {
  it('maps a host file under a mount to its path in the container', () => {
    const box = new DockerSandbox(options)
    const mount = { host: path.join(tmpdir(), 'files'), at: '/attachments' }
    expect(box.pathIn(mount, path.join(mount.host, 'a b.png'))).toBe(
      '/attachments/a b.png'
    )
  })
})

describe('parseCodexDefaults', () => {
  it('reads only top-level keys and ignores values inside tables', () => {
    const toml = [
      'model = "gpt-x"',
      'model_reasoning_effort = "medium"',
      '',
      '[profiles.fast]',
      'model = "gpt-mini"',
    ].join('\n')
    expect(parseCodexDefaults(toml)).toEqual({
      model: 'gpt-x',
      reasoningEffort: 'medium',
    })
    expect(parseCodexDefaults('[a]\nmodel = "b"')).toEqual({
      model: undefined,
      reasoningEffort: undefined,
    })
  })
})

describe('loadConfig sandbox', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pacenote-codex-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const env = {
    SLACK_BOT_TOKEN: 'xoxb-1',
    SLACK_APP_TOKEN: 'xapp-1',
  }

  it('does not start the claude sandbox without container credentials', () => {
    expect(() => loadConfig({ ...env, REASONER_SANDBOX: 'docker' })).toThrow(
      /SANDBOX_CLAUDE_OAUTH_TOKEN/
    )
    const config = loadConfig({
      ...env,
      REASONER_SANDBOX: 'docker',
      SANDBOX_CLAUDE_OAUTH_TOKEN: 'tok',
    })
    expect(config.reasoner.auth).toEqual({
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok' },
    })
    expect(config.reasoner.sandbox).toBeDefined()
    expect(JSON.stringify(config.reasoner.sandbox)).not.toContain('tok')
  })

  it('requires an auth file for the codex sandbox and takes the model from the host config.toml', () => {
    const auth = path.join(dir, 'auth.json')
    expect(() =>
      loadConfig({
        ...env,
        REASONER: 'codex',
        REASONER_SANDBOX: 'docker',
        SANDBOX_CODEX_AUTH_FILE: auth,
      })
    ).toThrow(auth)

    writeFileSync(auth, '{}')
    writeFileSync(
      path.join(dir, 'config.toml'),
      'model = "gpt-x"\nmodel_reasoning_effort = "low"\n'
    )
    const config = loadConfig({
      ...env,
      REASONER: 'codex',
      REASONER_SANDBOX: 'docker',
      SANDBOX_CODEX_AUTH_FILE: auth,
    })
    expect(config.reasoner).toMatchObject({
      model: 'gpt-x',
      reasoningEffort: 'low',
      auth: { file: auth },
    })
  })
})

describe('loadConfig commands', () => {
  it("names each CLI's binary for the host sandbox", () => {
    const config = loadConfig({
      SLACK_BOT_TOKEN: 'xoxb-1',
      SLACK_APP_TOKEN: 'xapp-1',
      CLAUDE_BIN: '/opt/claude',
    })
    expect(config.reasoner.sandbox).toBeUndefined()
    expect(config.reasoner.commands.claude).toBe('/opt/claude')
    expect(config.reasoner.commands.codex).toBeTruthy()
  })
})
