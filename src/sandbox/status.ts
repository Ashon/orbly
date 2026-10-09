import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { configFingerprint } from '../config.js'
import { readBotStatus } from '../runtime/status.js'
import { readEnvFile, readEnvValues } from '../settings/env-file.js'
import { allowlistPath, brokerRuntimeDir } from '../settings/paths.js'
import {
  parseAllowlist,
  readAllowlistFile,
  REQUIRED_DOMAINS,
} from './allowlist.js'
import { brokerExpected } from './env.js'
import type {
  BrokerHealth,
  ContainerState,
  PendingApply,
  SandboxCheck,
  SandboxStatus,
} from './types.js'

export const SANDBOX_IMAGES = [
  { name: 'pacenote-reasoner:latest', purpose: 'Reasoning (runs per request)' },
  { name: 'pacenote-renderer:latest', purpose: 'Diagram rendering' },
  { name: 'pacenote-egress-proxy:latest', purpose: 'Egress proxy' },
  { name: 'pacenote-ops-broker:latest', purpose: 'Ops tools broker' },
]
const CONTAINERS = {
  'egress-proxy': 'pacenote-sandbox-egress-proxy-1',
  'ops-broker': 'pacenote-sandbox-ops-broker-1',
} as const
/**
 * Reads only the broker environment variables used for comparison. (GH_TOKEN
 * and the like are not read)
 */
const BROKER_ENV_KEYS = [
  'SSH_USER',
  'ALLOWED_CIDR',
  'GIT_ALLOWED_OWNERS',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'JIRA_URL',
  'JIRA_EMAIL',
  'JIRA_PROJECTS',
] as const

export function parseHealthz(text: string): BrokerHealth | undefined {
  if (!text.startsWith('ok')) return undefined
  const field = (name: string) =>
    new RegExp(`${name}=(\\[[^\\]]*\\]|\\S+)`).exec(text)?.[1]
  const list = (value?: string) =>
    (value ?? '')
      .replace(/^\[|\]$/g, '')
      .split(/[,|]/)
      .map((item) => item.trim())
      .filter(Boolean)
  const fs = field('fs')
  const github = field('github')
  const jira = field('jira')
  return {
    sshHosts: Number(field('hosts') ?? 0),
    k8s: list(field('k8s')),
    fs: fs && fs !== 'off' ? fs : undefined,
    git: field('git') === 'on',
    github: github && github !== 'off' ? list(github) : [],
    jira: jira && jira !== 'off' ? list(jira) : [],
  }
}

/** Keeps only the chosen keys from a KEY=value list. */
export function pickEnv(
  entries: string[],
  keys: readonly string[]
): Record<string, string> {
  const picked: Record<string, string> = {}
  for (const entry of entries) {
    const index = entry.indexOf('=')
    const key = entry.slice(0, index)
    if (keys.includes(key)) picked[key] = entry.slice(index + 1)
  }
  return picked
}

export interface PendingInput {
  /** Only while the bot is alive */
  bot?: { configHash?: string; expectedHash: string }
  proxy?: { running: boolean; startedAt?: number; allowlistMtime?: number }
  broker?: {
    running: boolean
    startedAt?: number
    imageOutdated: boolean
    sourceMtime?: number
    imageCreatedAt?: number
    env: Record<string, string>
    mounts: Record<string, string>
    hostsMtime?: number
    kubeconfigMtime?: number
    expected: ReturnType<typeof brokerExpected>
    /**
     * Commit author used when the broker is recreated (OPS_GIT_AUTHOR_*, or the
     * global git config if unset)
     */
    author?: { name: string; email: string }
  }
}

const owners = (value?: string) =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .join(',')

/** Components whose changed settings are not applied yet, with reasons */
export function computePending(input: PendingInput): PendingApply[] {
  const pending: PendingApply[] = []
  const { bot, proxy, broker } = input
  if (bot && bot.configHash && bot.configHash !== bot.expectedHash) {
    pending.push({
      component: 'bot',
      reason: 'The .env settings changed after the bot started.',
    })
  }
  if (proxy) {
    if (!proxy.running)
      pending.push({ component: 'proxy', reason: 'The proxy is not running.' })
    else if (
      proxy.allowlistMtime &&
      proxy.startedAt &&
      proxy.allowlistMtime > proxy.startedAt
    ) {
      pending.push({
        component: 'proxy',
        reason: 'The allowed domains list changed after the proxy started.',
      })
    }
  }
  if (broker) {
    if (!broker.running) {
      pending.push({
        component: 'broker',
        reason: 'The broker is not running.',
      })
      return pending
    }
    const e = broker.expected
    const env = broker.env
    const diffs: string[] = []
    if (env.SSH_USER !== undefined && env.SSH_USER !== e.sshUser)
      diffs.push('SSH user')
    if (env.ALLOWED_CIDR !== undefined && env.ALLOWED_CIDR !== e.allowedCidr)
      diffs.push('Allowed SSH range')
    if (
      env.GIT_ALLOWED_OWNERS !== undefined &&
      owners(env.GIT_ALLOWED_OWNERS) !== owners(e.allowedOwners)
    ) {
      diffs.push('Allowed GitHub orgs')
    }
    if (broker.mounts['/workspace'] && broker.mounts['/workspace'] !== e.fsRoot)
      diffs.push('Work directory')
    if (
      broker.mounts['/run/secrets/ssh-key'] &&
      broker.mounts['/run/secrets/ssh-key'] !== e.sshKey
    ) {
      diffs.push('SSH key path')
    }
    if (
      broker.mounts['/run/secrets/known_hosts'] &&
      broker.mounts['/run/secrets/known_hosts'] !== e.knownHosts
    ) {
      diffs.push('known_hosts path')
    }
    if (
      (env.JIRA_URL !== undefined && env.JIRA_URL !== e.jiraUrl) ||
      (env.JIRA_EMAIL !== undefined && env.JIRA_EMAIL !== e.jiraEmail) ||
      (env.JIRA_PROJECTS !== undefined &&
        owners(env.JIRA_PROJECTS).toUpperCase() !==
          owners(e.jiraProjects).toUpperCase())
    ) {
      diffs.push('Jira settings')
    }
    const author = broker.author
    if (
      author?.email &&
      env.GIT_AUTHOR_EMAIL !== undefined &&
      (env.GIT_AUTHOR_NAME !== author.name ||
        env.GIT_AUTHOR_EMAIL !== author.email)
    ) {
      diffs.push('PR commit author')
    }
    if (diffs.length > 0) {
      pending.push({
        component: 'broker',
        reason: `Differs from .env: ${diffs.join(', ')}`,
      })
    }
    const started = broker.startedAt ?? 0
    if (broker.imageOutdated) {
      pending.push({
        component: 'broker',
        reason: 'A newly built broker image is available.',
      })
    } else if (
      broker.sourceMtime &&
      broker.imageCreatedAt &&
      broker.sourceMtime > broker.imageCreatedAt
    ) {
      pending.push({
        component: 'broker',
        reason: 'The broker code is newer than the image. (Rebuild needed)',
      })
    }
    if (broker.hostsMtime && broker.hostsMtime > started) {
      pending.push({
        component: 'broker',
        reason: 'The host list changed after the broker started.',
      })
    }
    if (broker.kubeconfigMtime && broker.kubeconfigMtime > started) {
      pending.push({
        component: 'broker',
        reason: 'The kubeconfig changed after the broker started.',
      })
    }
  }
  return pending
}

type Run = (
  command: string,
  args: string[]
) => Promise<{ code: number; stdout: string; stderr: string }>

export function commandRunner(env: NodeJS.ProcessEnv, cwd: string): Run {
  return (command, args) =>
    new Promise((resolve) => {
      execFile(
        command,
        args,
        { env, cwd, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const code = err
            ? typeof (err as { code?: unknown }).code === 'number'
              ? (err as { code: number }).code
              : 1
            : 0
          resolve({ code, stdout: String(stdout), stderr: String(stderr) })
        }
      )
    })
}

const mtime = (file: string) =>
  existsSync(file) ? statSync(file).mtimeMs : undefined
const expandHome = (value: string, home: string) =>
  value === '~' || value.startsWith('~/')
    ? path.join(home, value.slice(1))
    : value

/**
 * Sandbox commit author. Resolved in the same order as sandbox:ops-up:
 * OPS_GIT_AUTHOR_* in .env, otherwise the global git config. This repository's
 * local git config is not consulted.
 */
async function sandboxAuthor(
  values: NodeJS.ProcessEnv,
  run: Run
): Promise<{ name: string; email: string; source: string }> {
  const fromGlobal = async (key: string) =>
    (await run('git', ['config', '--global', key])).stdout.trim()
  const name =
    values.OPS_GIT_AUTHOR_NAME?.trim() || (await fromGlobal('user.name'))
  const email =
    values.OPS_GIT_AUTHOR_EMAIL?.trim() || (await fromGlobal('user.email'))
  const fromEnv = Boolean(
    values.OPS_GIT_AUTHOR_NAME?.trim() || values.OPS_GIT_AUTHOR_EMAIL?.trim()
  )
  return { name, email, source: fromEnv ? '.env' : 'global git config' }
}

/**
 * Collects sandbox status: docker, images, containers, broker health,
 * credential files, and items that need apply. Secrets are not read. (Only
 * checks whether files exist and whether GitHub login is done)
 */
export async function collectSandboxStatus(options: {
  /**
   * Directory containing sandbox/compose.yaml (the repository or inside the
   * app)
   */
  sandboxDir: string
  /** Config file (outside the repository, src/settings/paths.ts) */
  envFile: string
  dataDir: string
  /**
   * The app's environment variables, applied with the same precedence as the
   * bot
   */
  env: NodeJS.ProcessEnv
  run: Run
  home?: string
}): Promise<SandboxStatus> {
  const { sandboxDir, run } = options
  const home = options.home ?? homedir()
  const values: NodeJS.ProcessEnv = {
    ...readEnvValues(readEnvFile(options.envFile)),
    ...options.env,
  }
  const reasoner = values.REASONER === 'codex' ? 'codex' : 'claude'
  const useDocker = values.REASONER_SANDBOX === 'docker'
  const opsOn = values.OPS_TOOLS === 'on'
  // The allowlist lives under PACENOTE_HOME. If it does not exist yet (proxy
  // never started), the default list is shown.
  const allowlistFile = allowlistPath(options.env, home)
  const allowlistSource = existsSync(allowlistFile)
    ? allowlistFile
    : path.join(sandboxDir, 'proxy/allowed-domains.txt')

  const status: SandboxStatus = {
    checkedAt: new Date().toISOString(),
    docker: { ok: false },
    images: [],
    containers: [],
    checks: [],
    pending: [],
    allowlist: {
      file: allowlistFile,
      domains: parseAllowlist(readAllowlistFile(allowlistSource)),
      required: REQUIRED_DOMAINS[reasoner],
    },
    activeRequests: 0,
  }

  const version = await run('docker', [
    'version',
    '--format',
    '{{.Server.Version}}',
  ])
  status.docker =
    version.code === 0
      ? { ok: true, version: version.stdout.trim() }
      : {
          ok: false,
          error: (version.stderr || version.stdout).trim().split('\n').at(-1),
        }

  const images = new Map<string, { id: string; createdAt: number }>()
  if (status.docker.ok) {
    for (const image of SANDBOX_IMAGES) {
      const result = await run('docker', [
        'image',
        'inspect',
        '--format',
        '{{.Id}} {{.Created}}',
        image.name,
      ])
      const [id, created] = result.stdout.trim().split(' ')
      if (result.code === 0 && id && created)
        images.set(image.name, { id, createdAt: Date.parse(created) })
      status.images.push({
        ...image,
        present: result.code === 0,
        createdAt:
          created && result.code === 0
            ? new Date(Date.parse(created)).toISOString()
            : undefined,
      })
    }
  }

  interface Inspect {
    Image: string
    Created: string
    State: { Status: string; StartedAt: string }
    Config: { Env?: string[] }
    Mounts?: { Source: string; Destination: string }[]
  }
  const inspect = async (name: string): Promise<Inspect | undefined> => {
    if (!status.docker.ok) return undefined
    const result = await run('docker', [
      'inspect',
      '--format',
      '{{json .}}',
      name,
    ])
    if (result.code !== 0) return undefined
    try {
      return JSON.parse(result.stdout) as Inspect
    } catch {
      return undefined
    }
  }
  const proxy = await inspect(CONTAINERS['egress-proxy'])
  const broker = await inspect(CONTAINERS['ops-broker'])
  for (const [service, data] of [
    ['egress-proxy', proxy],
    ['ops-broker', broker],
  ] as const) {
    const state: ContainerState = {
      service,
      state: data?.State.Status ?? 'missing',
    }
    if (data?.State.Status === 'running') state.startedAt = data.State.StartedAt
    status.containers.push(state)
  }

  if (broker?.State.Status === 'running') {
    const health = await run('docker', [
      'exec',
      CONTAINERS['ops-broker'],
      'node',
      '-e',
      "fetch('http://127.0.0.1:8080/healthz').then(r=>r.text()).then(t=>process.stdout.write(t)).catch(()=>process.exit(1))",
    ])
    if (health.code === 0) status.broker = parseHealthz(health.stdout.trim())
  }

  // Credentials and generated files (values are not read)
  const runtimeDir = brokerRuntimeDir(options.env, home)
  const expected = brokerExpected(values, runtimeDir)
  let author: Awaited<ReturnType<typeof sandboxAuthor>> | undefined
  const hostsFile = path.join(runtimeDir, 'hosts.json')
  const kubeconfig = path.join(runtimeDir, 'kubeconfig')
  const fileCheck = (label: string, file: string): SandboxCheck =>
    existsSync(file)
      ? { label, ok: true, detail: file }
      : { label, ok: false, detail: `Missing: ${file}` }
  if (useDocker && reasoner === 'codex') {
    status.checks.push(
      fileCheck(
        'codex login file',
        expandHome(values.SANDBOX_CODEX_AUTH_FILE || '~/.codex/auth.json', home)
      )
    )
  }
  if (useDocker && reasoner === 'claude') {
    const set = Boolean(
      values.SANDBOX_CLAUDE_OAUTH_TOKEN || values.SANDBOX_ANTHROPIC_API_KEY
    )
    status.checks.push({
      label: 'Sandbox claude token',
      ok: set,
      detail: set ? 'Set' : 'SANDBOX_CLAUDE_OAUTH_TOKEN required',
    })
  }
  // Checks only configured features. For empty features the broker starts
  // without those tools. (Shown as off in the broker tools row)
  if ((opsOn || broker) && expected.configured.ssh) {
    status.checks.push(fileCheck('SSH key', expected.sshKey))
    if (values.OPS_SSH_KNOWN_HOSTS?.trim())
      status.checks.push(fileCheck('SSH known_hosts', expected.knownHosts))
    let hostCount = 0
    try {
      hostCount = Object.keys(
        JSON.parse(readFileSync(hostsFile, 'utf8')) as object
      ).length
    } catch {
      // Missing or empty.
    }
    const fromInventory = Boolean(
      values.OPS_SSH_INVENTORY_DIR?.trim() && values.OPS_SSH_INVENTORY?.trim()
    )
    status.checks.push({
      label: 'Host list',
      ok: hostCount > 0,
      detail:
        hostCount > 0
          ? `${hostCount} host${hostCount === 1 ? '' : 's'} (${fromInventory ? 'rebuilt from the inventory when the broker starts' : 'hosts.json managed by hand'})`
          : fromInventory
            ? 'None (built when the broker starts)'
            : 'None (set OPS_SSH_INVENTORY or write hosts.json by hand)',
    })
  }
  if (opsOn || broker) {
    const kubeSize = existsSync(kubeconfig) ? statSync(kubeconfig).size : 0
    status.checks.push({
      label: 'k8s kubeconfig',
      ok: kubeSize > 0,
      detail:
        kubeSize > 0
          ? 'Present'
          : 'Empty (k8s tools off, rebuild kubeconfig needed)',
    })
    const jiraKeys = [
      'OPS_JIRA_URL',
      'OPS_JIRA_EMAIL',
      'OPS_JIRA_TOKEN',
      'OPS_JIRA_PROJECTS',
    ] as const
    if (jiraKeys.some((key) => values[key]?.trim())) {
      const missing = jiraKeys.filter((key) => !values[key]?.trim())
      status.checks.push({
        label: 'Jira',
        ok: missing.length === 0,
        detail:
          missing.length === 0
            ? `${values.OPS_JIRA_URL} (${values.OPS_JIRA_PROJECTS}, ${values.OPS_JIRA_EMAIL})`
            : `${missing.join(', ')} required`,
      })
    }
    const gh = await run('gh', [
      'auth',
      'status',
      '--active',
      '--hostname',
      'github.com',
    ])
    const account = /account (\S+)/.exec(gh.stdout + gh.stderr)?.[1]
    status.checks.push({
      label: 'GitHub login (gh)',
      ok: gh.code === 0,
      detail:
        gh.code === 0
          ? `${account ?? 'Logged in'} (the token is passed when the broker starts)`
          : 'gh auth login required',
    })
    author = await sandboxAuthor(values, run)
    status.checks.push({
      label: 'PR commit author',
      ok: Boolean(author.name && author.email),
      detail:
        author.name && author.email
          ? `${author.name} <${author.email}> (${author.source})`
          : 'OPS_GIT_AUTHOR_NAME and OPS_GIT_AUTHOR_EMAIL, or git config --global, required',
    })
  }

  // Needs apply
  const bot = readBotStatus(options.dataDir)
  status.activeRequests = bot.alive ? (bot.status?.requests.active ?? 0) : 0
  const brokerImage = images.get('pacenote-ops-broker:latest')
  status.pending = computePending({
    bot: bot.alive
      ? {
          configHash: bot.status?.configHash,
          expectedHash: configFingerprint(values),
        }
      : undefined,
    proxy:
      useDocker || proxy
        ? {
            running: proxy?.State.Status === 'running',
            startedAt: proxy ? Date.parse(proxy.State.StartedAt) : undefined,
            allowlistMtime: mtime(allowlistFile),
          }
        : undefined,
    broker:
      opsOn || broker
        ? {
            running: broker?.State.Status === 'running',
            startedAt: broker ? Date.parse(broker.State.StartedAt) : undefined,
            imageOutdated: Boolean(
              broker && brokerImage && broker.Image !== brokerImage.id
            ),
            imageCreatedAt: brokerImage?.createdAt,
            // Bundle that goes into the broker image (pnpm bundle, or the
            // bundle inside a packaged app)
            sourceMtime: mtime(
              path.join(sandboxDir, 'ops-broker/dist/server.mjs')
            ),
            env: pickEnv(broker?.Config.Env ?? [], BROKER_ENV_KEYS),
            mounts: Object.fromEntries(
              (broker?.Mounts ?? []).map((m) => [m.Destination, m.Source])
            ),
            hostsMtime: mtime(hostsFile),
            kubeconfigMtime: mtime(kubeconfig),
            expected,
            author,
          }
        : undefined,
  })
  return status
}
