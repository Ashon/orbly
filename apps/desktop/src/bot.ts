import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { parseEnv } from 'node:util'
import { utilityProcess, type UtilityProcess } from 'electron'
import { RECHECK_SANDBOX } from '../../../src/runtime/sandbox-health.js'
import { readRunningBot } from '../../../src/runtime/status.js'
import { botLockDirs } from '../../../src/settings/legacy.js'
import { setupProblem, startFailureProblem } from './bot-readiness.js'
import type { SupervisorState } from '../../../src/runtime/types.js'

export type { SupervisorState }

/**
 * The desktop app runs and manages the bot (Socket Mode) as a child process.
 * - Runs the bot entry with Electron utilityProcess. Dev runs use the
 *   repository's dist/index.js and build first when the sources are newer. The
 *   packaged app uses the bundle inside the app (bot/index.mjs) as is.
 *   (app-paths.ts)
 * - If a bot is already running from a terminal (pnpm dev etc.), it is left
 *   alone and shown as "external".
 * - Before launching, the bot's environment is checked with the bot's own
 *   rules. Missing settings (a first run) or tokens Slack rejected show as
 *   "setup" instead of launching a bot that would only exit on them.
 * - A bot that was running fine and dies is restarted a few times. One that
 *   dies right after starting for another reason is left stopped as "failed".
 * - Stopping sends SIGTERM. The bot waits up to 20 seconds for active requests
 *   and resumes the rest on the next start.
 */
interface Settings {
  autoStartBot: boolean
}

const OUTPUT_LINES = 200
const STOP_TIMEOUT_MS = 30_000
/** A bot that dies after running at least this long is restarted. */
const HEALTHY_UPTIME_MS = 30_000
const MAX_RESTARTS = 3
const RESTART_WINDOW_MS = 10 * 60_000

export class BotSupervisor extends EventEmitter<{ change: [SupervisorState] }> {
  /**
   * Asks the running bot to check the sandbox again now (after a sandbox job),
   * so its status follows at once.
   */
  recheckSandbox(): void {
    this.child?.postMessage({ type: RECHECK_SANDBOX })
  }

  private child?: UtilityProcess
  private childStartedAt = 0
  private stopRequested = false
  private restartTimes: number[] = []
  private poller?: NodeJS.Timeout
  private state: SupervisorState
  private readonly settingsFile: string

  constructor(
    private readonly options: {
      /** Bot entry file */
      entry: string
      /**
       * Dev runs only: the repository to rebuild. Without it, nothing is built.
       * (packaged app)
       */
      repoRoot?: string
      /** Bot working directory */
      cwd: string
      /** Settings file (outside the repository, src/settings/paths.ts) */
      envFile: string
      dataDir: string
      /**
       * Login shell PATH (an app launched from Finder lacks the docker, codex,
       * and pnpm paths)
       */
      toolPath: () => string
      log: (message: string) => void
    }
  ) {
    super()
    this.settingsFile = path.join(options.dataDir, 'desktop.json')
    this.state = {
      phase: 'idle',
      output: [],
      autoStart: this.readSettings().autoStartBot,
      restarts: 0,
      canBuild: options.repoRoot !== undefined,
    }
    this.refreshExternal()
    // Also tracks external bots starting and stopping.
    this.poller = setInterval(() => this.refreshExternal(), 2_000)
    this.poller.unref()
  }

  get current(): SupervisorState {
    return this.state
  }

  get managing(): boolean {
    return this.child !== undefined
  }

  setAutoStart(value: boolean): void {
    writeFileSync(
      this.settingsFile,
      `${JSON.stringify({ autoStartBot: value }, null, 2)}\n`
    )
    this.set({ autoStart: value })
  }

  async start(options: { rebuild?: boolean } = {}): Promise<void> {
    if (this.child || this.state.phase === 'building') return
    this.refreshExternal()
    if (this.state.phase === 'external') return
    this.stopRequested = false
    const problem = setupProblem(this.botEnv())
    if (problem) {
      this.set({
        phase: 'setup',
        pid: undefined,
        message: problem.message,
        issues: problem.issues,
        output: [],
      })
      return
    }
    const { entry } = this.options
    if (
      this.options.repoRoot &&
      (options.rebuild || this.needsBuild(entry, this.options.repoRoot))
    ) {
      if (!(await this.build())) return
    }
    this.spawn(entry)
  }

  async stop(): Promise<void> {
    const child = this.child
    if (!child) return
    this.stopRequested = true
    this.set({
      phase: 'stopping',
      message: 'Finishing active requests before stopping.',
    })
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (child.pid) {
          try {
            process.kill(child.pid, 'SIGKILL')
          } catch {
            // Already exited
          }
        }
        resolve()
      }, STOP_TIMEOUT_MS)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      child.kill()
    })
  }

  async restart(options: { rebuild?: boolean } = {}): Promise<void> {
    await this.stop()
    await this.start(options)
  }

  dispose(): void {
    if (this.poller) clearInterval(this.poller)
  }

  /** pnpm build (tsc). Output is kept in output. Called only in dev runs. */
  private build(): Promise<boolean> {
    this.set({
      phase: 'building',
      message: 'Building Pace (pnpm build)',
      output: [],
    })
    return new Promise((resolve) => {
      execFile(
        'pnpm',
        ['build'],
        {
          cwd: this.options.repoRoot!,
          env: { ...process.env, PATH: this.options.toolPath() },
          timeout: 180_000,
          maxBuffer: 4 * 1024 * 1024,
        },
        (err, stdout, stderr) => {
          const output = `${stdout}${stderr}`
            .split('\n')
            .filter(Boolean)
            .slice(-OUTPUT_LINES)
          if (err) {
            this.options.log(`bot build failed: ${err.message}`)
            this.set({ phase: 'failed', message: 'The build failed.', output })
            resolve(false)
            return
          }
          this.set({ phase: 'idle', message: undefined, output })
          resolve(true)
        }
      )
    })
  }

  /**
   * The bot's environment: the settings file under the app's own environment,
   * as with node --env-file.
   */
  private botEnv(): Record<string, string> {
    const env: Record<string, string> = {}
    const { envFile } = this.options
    if (existsSync(envFile))
      Object.assign(env, parseEnv(readFileSync(envFile, 'utf8')))
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !key.startsWith('ELECTRON_')) env[key] = value
    }
    env.PATH = this.options.toolPath()
    env.PACENOTE_MANAGED_BY = 'desktop'
    env.PACENOTE_DATA_DIR = this.options.dataDir
    env.NODE_ENV = 'production'
    return env
  }

  private spawn(entry: string): void {
    const env = this.botEnv()
    const child = utilityProcess.fork(entry, [], {
      cwd: this.options.cwd,
      env,
      stdio: 'pipe',
      serviceName: 'Pace',
    })
    this.child = child
    this.childStartedAt = Date.now()
    this.set({
      phase: 'starting',
      pid: undefined,
      message: undefined,
      issues: undefined,
      output: [],
    })

    const capture = (chunk: Buffer) => {
      const lines = chunk.toString().split('\n').filter(Boolean)
      this.set({
        output: [...this.state.output, ...lines].slice(-OUTPUT_LINES),
      })
    }
    child.stdout?.on('data', capture)
    child.stderr?.on('data', capture)
    child.once('spawn', () => this.set({ pid: child.pid }))
    child.once('exit', (code) => this.onExit(child, code))
  }

  private onExit(child: UtilityProcess, code: number): void {
    if (this.child !== child) return
    this.child = undefined
    const uptime = Date.now() - this.childStartedAt
    this.options.log(`bot exited code=${code} uptime=${uptime}ms`)
    if (this.stopRequested) {
      this.set({ phase: 'idle', pid: undefined, message: 'Stopped' })
      return
    }
    const now = Date.now()
    this.restartTimes = this.restartTimes.filter(
      (t) => now - t < RESTART_WINDOW_MS
    )
    const last = this.state.output.at(-1) ?? ''
    if (
      uptime >= HEALTHY_UPTIME_MS &&
      this.restartTimes.length < MAX_RESTARTS
    ) {
      this.restartTimes.push(now)
      this.set({
        phase: 'crashed',
        pid: undefined,
        restarts: this.restartTimes.length,
        message: `Pace exited (code ${code}). Restarting in 3 seconds.`,
      })
      setTimeout(() => void this.start(), 3_000)
      return
    }
    if (uptime < HEALTHY_UPTIME_MS) {
      // Tokens Slack rejected are a setup problem; anything else is a failed
      // start, with the output kept.
      const problem = startFailureProblem(this.state.output)
      this.set(
        problem
          ? {
              phase: 'setup',
              pid: undefined,
              message: problem.message,
              issues: [],
            }
          : {
              phase: 'failed',
              pid: undefined,
              message:
                `Pace stopped right after starting (code ${code}). ${last}`.trim(),
            }
      )
      return
    }
    this.set({
      phase: 'crashed',
      pid: undefined,
      message: `Pace keeps exiting and will not be restarted (code ${code}).`,
    })
  }

  /**
   * Syncs phase with bot.json. A bot started here is running; one started
   * elsewhere is external
   */
  private refreshExternal(): void {
    // A bot in the other default home (an old Verda or Orbly, before migrating)
    // also counts as running elsewhere.
    const view = readRunningBot(botLockDirs(this.options.dataDir))
    if (this.child) {
      const ours = view.alive && view.status?.pid === this.child.pid
      const running = ours && view.status?.state === 'running'
      if (running && this.state.phase === 'starting')
        this.set({ phase: 'running' })
      return
    }
    const externalPid = view.alive ? view.status?.pid : undefined
    if (externalPid && this.state.phase !== 'external') {
      this.set({
        phase: 'external',
        pid: externalPid,
        message:
          'Pace is running elsewhere, such as a terminal. Stop it there to manage it here.',
      })
    } else if (!externalPid && this.state.phase === 'external') {
      this.set({
        phase: 'idle',
        pid: undefined,
        message: 'Pace stopped running elsewhere.',
      })
      if (this.state.autoStart) void this.start()
    }
  }

  /** A build is needed when dist/index.js is missing or src is newer. */
  private needsBuild(entry: string, repoRoot: string): boolean {
    if (!existsSync(entry)) return true
    const built = statSync(entry).mtimeMs
    const newest = (dir: string): number =>
      readdirSync(dir, { withFileTypes: true }).reduce((max, item) => {
        const file = path.join(dir, item.name)
        const mtime = item.isDirectory() ? newest(file) : statSync(file).mtimeMs
        return Math.max(max, mtime)
      }, 0)
    return newest(path.join(repoRoot, 'src')) > built
  }

  private readSettings(): Settings {
    try {
      const parsed = JSON.parse(
        readFileSync(this.settingsFile, 'utf8')
      ) as Partial<Settings>
      return { autoStartBot: parsed.autoStartBot ?? true }
    } catch {
      return { autoStartBot: true }
    }
  }

  private set(patch: Partial<SupervisorState>): void {
    this.state = { ...this.state, ...patch }
    this.emit('change', this.state)
  }
}
