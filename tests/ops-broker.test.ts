import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  filterRgOutput,
  isDenied,
  listDir,
  readText,
  resolveInRoot,
  rgFilterArgs,
} from '../src/broker/fs.js'
import {
  describeArgs,
  eventsArgs,
  getArgs,
  logsArgs,
  topArgs,
} from '../src/broker/k8s.js'
import { redactSecrets } from '../src/broker/redact.js'

const clusters = ['main', 'staging']

describe('k8s arguments', () => {
  it('builds read-only commands as argument arrays', () => {
    expect(
      getArgs(
        { cluster: 'main', kind: 'pods', namespace: 'kube-system' },
        clusters
      )
    ).toEqual([
      '--context',
      'main',
      '--request-timeout=20s',
      'get',
      'pods',
      '--namespace',
      'kube-system',
      '--output',
      'wide',
    ])
    expect(
      getArgs(
        {
          cluster: 'staging',
          kind: 'certificates.cert-manager.io',
          allNamespaces: true,
          output: 'yaml',
        },
        clusters
      )
    ).toContain('--all-namespaces')
    expect(
      describeArgs({ cluster: 'main', kind: 'node', name: 'web-01' }, clusters)
    ).toEqual([
      '--context',
      'main',
      '--request-timeout=20s',
      'describe',
      'node',
      'web-01',
    ])
    expect(
      logsArgs(
        {
          cluster: 'main',
          namespace: 'ns',
          pod: 'p-1',
          tail: 50,
          previous: true,
        },
        clusters
      )
    ).toEqual(
      expect.arrayContaining(['logs', 'p-1', '--tail', '50', '--previous'])
    )
    expect(eventsArgs({ cluster: 'main' }, clusters)).toContain(
      '--all-namespaces'
    )
    expect(topArgs({ cluster: 'main', target: 'nodes' }, clusters)).toEqual([
      '--context',
      'main',
      '--request-timeout=20s',
      'top',
      'nodes',
    ])
  })

  it('rejects secrets, clusters outside the allowlist, and invalid values', () => {
    expect(() =>
      getArgs({ cluster: 'main', kind: 'secrets' }, clusters)
    ).toThrow(/secrets/)
    expect(() =>
      getArgs({ cluster: 'main', kind: 'secret.v1' }, clusters)
    ).toThrow(/secrets/)
    expect(() => getArgs({ cluster: 'prod', kind: 'pods' }, clusters)).toThrow(
      /Cluster is not allowed/
    )
    expect(() =>
      getArgs({ cluster: 'main', kind: 'pods', name: 'x;rm -rf /' }, clusters)
    ).toThrow(/name/)
    expect(() =>
      getArgs({ cluster: 'main', kind: '--raw=/' }, clusters)
    ).toThrow(/kind/)
    expect(() =>
      getArgs({ cluster: 'main', kind: 'pods', selector: 'a=$(id)' }, clusters)
    ).toThrow(/selector/)
    expect(() =>
      logsArgs(
        { cluster: 'main', namespace: 'ns', pod: 'p', tail: 0 },
        clusters
      )
    ).toThrow(/tail/)
    expect(() =>
      logsArgs(
        { cluster: 'main', namespace: 'ns', pod: 'p', since: '1d' },
        clusters
      )
    ).toThrow(/since/)
  })
})

describe('fs', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ops-fs-'))
  const outside = mkdtempSync(path.join(tmpdir(), 'ops-outside-'))
  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })
  mkdirSync(path.join(root, 'repo/.git'), { recursive: true })
  writeFileSync(path.join(root, 'repo/README.md'), 'line1\nline2\nline3\n')
  writeFileSync(path.join(root, 'repo/.env'), 'SLACK_BOT_TOKEN=xoxb-secret')
  writeFileSync(path.join(root, 'repo/.env.example'), 'SLACK_BOT_TOKEN=')
  writeFileSync(path.join(root, 'repo/main-admin.conf'), 'admin')
  writeFileSync(path.join(outside, 'data.txt'), 'outside')
  symlinkSync(outside, path.join(root, 'repo/escape'))

  it('secret file rules', () => {
    for (const p of [
      'a/.env',
      'a/.env.local',
      'a/id_rsa',
      'a/tls.key',
      'a/kubeconfig',
      'a/main-admin.conf',
      'a/.git/config',
      'a/.venv/x.py',
      'a/sealed-secret.yaml',
      'a/x.tfstate',
    ]) {
      expect(isDenied(p), p).toBe(true)
    }
    for (const p of [
      'a/.env.example',
      'a/README.md',
      'infra/sites/inventory.ini',
    ]) {
      expect(isDenied(p), p).toBe(false)
    }
  })

  it('hides secret files and .git in listings', async () => {
    const listing = await listDir(root, 'repo')
    expect(listing).toContain('README.md')
    expect(listing).toContain('.env.example')
    expect(listing).not.toMatch(/^\.env$/m)
    expect(listing).not.toContain('.git/')
    expect(listing).not.toContain('admin.conf')
  })

  it('reads with line numbers and rejects out-of-scope paths', async () => {
    expect(await readText(root, 'repo/README.md', 2, 1)).toContain('2\tline2')
    expect(await readText(root, path.join(root, 'repo/README.md'))).toContain(
      '1\tline1'
    )
    await expect(resolveInRoot(root, 'repo/.env')).rejects.toThrow(/restricted/)
    await expect(resolveInRoot(root, '../etc/passwd')).rejects.toThrow(
      /outside the work root/
    )
    await expect(resolveInRoot(root, '/etc/passwd')).rejects.toThrow(
      /relative to the work root/
    )
    await expect(resolveInRoot(root, 'repo/escape/data.txt')).rejects.toThrow(
      /outside the work root/
    )
  })
})

describe('ripgrep deny rules', () => {
  /** Files that isDenied blocks, with mixed case and locations. */
  const SECRET_FILES = [
    '.env',
    '.env.production',
    'Secrets.yaml',
    'k8s/Secrets.yaml',
    'KUBECONFIG',
    'netrc',
    '.netrc',
    'a.tfstate.backup',
    'id_dsa',
    'tls.KEY',
    'vault-prod.yml',
    '.git/config',
  ]

  it('puts the requested glob first and the exclude globs after it with --iglob', () => {
    expect(rgFilterArgs('!**/.env').slice(0, 3)).toEqual([
      '--glob',
      '**/.env',
      '--iglob',
    ])
    expect(rgFilterArgs()[0]).toBe('--iglob')
  })

  it('drops excluded files from search results and makes paths relative', () => {
    const output = [
      '(exit 0, 3ms)',
      '/workspace/repo/README.md\u00002:token here',
      '/workspace/repo/.env\u00001:API_KEY=x',
      '/workspace/repo/k8s/Secrets.yaml\u00004:data',
      'rg: /workspace/repo/broken: Permission denied',
    ].join('\n')
    expect(filterRgOutput(output, '/workspace')).toBe(
      [
        '(exit 0, 3ms)',
        'repo/README.md:2:token here',
        'rg: /workspace/repo/broken: Permission denied',
      ].join('\n')
    )
    const files = [
      '(exit 0, 1ms)',
      '/w/r/a.ts',
      '/w/r/netrc',
      '/w/r/id_DSA',
    ].join('\n')
    expect(filterRgOutput(files, '/w/')).toBe('(exit 0, 1ms)\nr/a.ts')
  })

  const hasRg = spawnSync('rg', ['--version']).status === 0
  it.skipIf(!hasRg)(
    'a glob cannot lift the deny rules, and the exclude globs match isDenied',
    () => {
      const repo = mkdtempSync(path.join(tmpdir(), 'ops-rg-'))
      try {
        for (const file of [...SECRET_FILES, 'README.md', 'src/app.ts']) {
          mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
          writeFileSync(path.join(repo, file), 'API_KEY=supersecretvalue\n')
        }
        for (const file of SECRET_FILES) expect(isDenied(file), file).toBe(true)
        // Same arguments as fs_search. Checks that the globs alone filter,
        // without post-processing (filterRgOutput).
        const search = (glob?: string) =>
          spawnSync(
            'rg',
            [
              '--files-with-matches',
              '--hidden',
              ...rgFilterArgs(glob),
              '--',
              'supersecret',
              repo,
            ],
            { encoding: 'utf8' }
          )
            .stdout.split('\n')
            .filter(Boolean)
            .map((file) => path.relative(repo, file))
            .sort()
        for (const glob of [
          undefined,
          '**/*',
          '**/.env',
          '!**/.env',
          '**/*secret*',
          'KUBECONFIG',
        ]) {
          expect(search(glob), String(glob)).toEqual(
            glob === undefined || glob === '**/*'
              ? ['README.md', 'src/app.ts']
              : []
          )
        }
      } finally {
        rmSync(repo, { recursive: true, force: true })
      }
    }
  )
})

describe('redactSecrets', () => {
  it('redacts common secret formats', () => {
    const text = [
      'token: abcdefghijklmnop',
      'SLACK=xoxb-1234567890-abcdefghij',
      '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----',
      'client-key-data: LS0tLS1CRUdJTiBSU0E=',
      `GH=github_pat_11ABCDEFG0123456789abc_${'x'.repeat(59)}`,
      'normal line',
    ].join('\n')
    const out = redactSecrets(text)
    expect(out).not.toContain('abcdefghijklmnop')
    expect(out).not.toContain('xoxb-1234567890')
    expect(out).not.toContain('github_pat_')
    expect(out).not.toContain('AAAA')
    expect(out).not.toContain('LS0tLS1CRUdJTiBSU0E=')
    expect(out).toContain('normal line')
  })
})
