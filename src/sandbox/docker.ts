import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { runProcess, type RunResult } from './process.js'
import {
  PDFTOTEXT_ARGS,
  SANDBOX_PATHS,
  type Mount,
  type Sandbox,
  type SandboxRun,
} from './runtime.js'

export interface DockerSandboxOptions {
  dockerBin: string
  image: string
  network: string
  proxyUrl: string
  memory: string
  cpus: string
  /**
   * Hosts reached directly on the internal network without the proxy (e.g.
   * ops-broker)
   */
  noProxy?: string[]
  /** Names of internal service containers that must be running at startup */
  requiredServices?: string[]
}

export const SANDBOX_LABEL = 'pacenote.role=reasoner'

/**
 * docker run arguments for PDF text extraction. Since it parses files uploaded
 * by other people, it runs in a disposable container with no network, a
 * read-only root, and all capabilities dropped.
 */
export function pdfExtractArgs(image: string, pdfPath: string): string[] {
  return [
    'run',
    '--rm',
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--user',
    '1000:1000',
    '--memory',
    '512m',
    '--pids-limit',
    '64',
    '--label',
    SANDBOX_LABEL,
    '-v',
    `${path.dirname(pdfPath)}:/in:ro`,
    '--entrypoint',
    'pdftotext',
    image,
    ...PDFTOTEXT_ARGS,
    `/in/${path.basename(pdfPath)}`,
    '-',
  ]
}

/**
 * docker run arguments for one disposable container.
 * - Read-only root filesystem; HOME and /tmp are tmpfs, empty on every run
 * - All capabilities dropped, no privilege escalation, process/memory/CPU
 *   limits
 * - Connected only to the internal network. Outbound traffic goes only through
 *   the egress proxy (allowed domains).
 * - The only visible host paths are the mounts the run asks for, read-only
 *   unless marked writable.
 * - Environment values are passed by name only (-e NAME) and supplied through
 *   the docker CLI process environment, which keeps credentials out of process
 *   listings.
 */
export function dockerRunArgs(
  options: DockerSandboxOptions,
  run: Pick<SandboxRun, 'command' | 'args' | 'env' | 'mounts' | 'cwd'>,
  containerName: string
): string[] {
  const args = [
    'run',
    '--rm',
    '-i',
    '--name',
    containerName,
    '--label',
    SANDBOX_LABEL,
    '--network',
    options.network,
    '--read-only',
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,size=256m',
    '--tmpfs',
    '/home/node:rw,nosuid,nodev,size=256m,uid=1000,gid=1000,mode=0700',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '256',
    '--memory',
    options.memory,
    '--cpus',
    options.cpus,
    '--user',
    '1000:1000',
    '-e',
    `HTTPS_PROXY=${options.proxyUrl}`,
    '-e',
    `HTTP_PROXY=${options.proxyUrl}`,
  ]
  if (options.noProxy?.length) {
    const list = options.noProxy.join(',')
    args.push('-e', `NO_PROXY=${list}`, '-e', `no_proxy=${list}`)
  }
  for (const name of Object.keys(run.env ?? {})) args.push('-e', name)
  for (const mount of run.mounts ?? []) {
    args.push('-v', `${mount.host}:${mount.at}${mount.writable ? '' : ':ro'}`)
  }
  if (run.cwd) {
    args.push('-v', `${run.cwd.host}:${run.cwd.at}:ro`, '-w', run.cwd.at)
  } else {
    args.push('-w', SANDBOX_PATHS.empty)
  }
  args.push(options.image, run.command, ...run.args)
  return args
}

/**
 * Runs the CLI in a disposable, hardened container on the sandbox network
 * (sandbox/compose.yaml).
 */
export class DockerSandbox implements Sandbox {
  readonly kind = 'docker' as const
  readonly isolated = true

  constructor(private readonly options: DockerSandboxOptions) {}

  pathIn(mount: Mount, hostFile: string): string {
    return path.posix.join(
      mount.at,
      path.relative(mount.host, hostFile).split(path.sep).join('/')
    )
  }

  async extractPdfText(pdfPath: string): Promise<string> {
    const { stdout } = await runProcess(
      this.options.dockerBin,
      pdfExtractArgs(this.options.image, pdfPath),
      { cwd: process.cwd(), input: '', timeoutMs: 60_000 }
    )
    return stdout
  }

  async run(run: SandboxRun): Promise<RunResult> {
    const name = `pacenote-reasoner-${randomUUID().slice(0, 8)}`
    try {
      return await runProcess(
        this.options.dockerBin,
        dockerRunArgs(this.options, run, name),
        {
          cwd: process.cwd(),
          input: run.input,
          timeoutMs: run.timeoutMs,
          signal: run.signal,
          env: { ...process.env, ...run.env },
          onStdoutLine: run.onOutputLine,
        }
      )
    } catch (err) {
      // The container may be left behind if the docker CLI is killed, so it is
      // removed.
      await runProcess(this.options.dockerBin, ['rm', '-f', name], {
        cwd: process.cwd(),
        input: '',
        timeoutMs: 15_000,
      }).catch(() => undefined)
      throw err
    }
  }

  async verify(): Promise<string[]> {
    const { dockerBin, image, network } = this.options
    const docker = (args: string[]) =>
      runProcess(dockerBin, args, {
        cwd: process.cwd(),
        input: '',
        timeoutMs: 15_000,
      })
    const problems: string[] = []

    try {
      await docker(['version', '--format', '{{.Server.Version}}'])
    } catch (err) {
      return [`Cannot connect to the docker daemon: ${(err as Error).message}`]
    }
    await docker(['image', 'inspect', image]).catch(() =>
      problems.push(`Sandbox image ${image} not found. (pnpm sandbox:build)`)
    )
    try {
      const { stdout } = await docker([
        'network',
        'inspect',
        network,
        '--format',
        '{{.Internal}}',
      ])
      if (stdout.trim() !== 'true') {
        problems.push(
          `Network ${network} is not internal. Containers can reach the outside directly.`
        )
      }
    } catch {
      problems.push(`Sandbox network ${network} not found. (pnpm sandbox:up)`)
    }
    const { stdout: proxies } = await docker([
      'ps',
      '--filter',
      `network=${network}`,
      '--filter',
      'name=egress-proxy',
      '--format',
      '{{.Names}}',
    ]).catch(() => ({ stdout: '' }))
    if (!proxies.trim()) {
      problems.push('The egress proxy is not running. (pnpm sandbox:up)')
    }
    for (const service of this.options.requiredServices ?? []) {
      const { stdout } = await docker([
        'ps',
        '--filter',
        `network=${network}`,
        '--filter',
        `name=${service}`,
        '--format',
        '{{.Names}}',
      ]).catch(() => ({ stdout: '' }))
      if (!stdout.trim())
        problems.push(`${service} is not running. (pnpm sandbox:ops-up)`)
    }
    return problems
  }
}
