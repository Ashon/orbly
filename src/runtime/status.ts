import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import type { BotStatus, BotStatusView, SocketState } from './types.js'

export const STATUS_FILE = 'bot.json'
export const LOG_FILE = path.join('logs', 'bot.log')

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * The first bot alive among these data folders (see botLockDirs), else the
 * status of the first folder
 */
export function readRunningBot(dataDirs: readonly string[]): BotStatusView {
  const views = dataDirs.map(readBotStatus)
  return views.find((view) => view.alive) ?? views[0] ?? { alive: false }
}

export function readBotStatus(dataDir: string): BotStatusView {
  const file = path.join(dataDir, STATUS_FILE)
  if (!existsSync(file)) return { alive: false }
  try {
    const status = JSON.parse(readFileSync(file, 'utf8')) as BotStatus
    return { status, alive: isAlive(status.pid) }
  } catch {
    return { alive: false }
  }
}

export class BotAlreadyRunningError extends Error {
  constructor(
    readonly pid: number,
    managedBy: string
  ) {
    super(
      `Pacey is already running (pid ${pid}, ${managedBy === 'desktop' ? 'desktop app' : 'terminal'}). ` +
        'Running two with the same app token makes Slack split events between them, so only one runs.'
    )
  }
}

/** This process's status file. Acquired at startup and deleted on exit. */
export class BotStatusFile {
  private constructor(
    private readonly file: string,
    private status: BotStatus
  ) {}

  /**
   * If another bot is alive, waits up to waitMs for it to exit. (Time for the
   * previous process to finish in-progress requests on a pnpm dev restart) If
   * it is still alive, throws BotAlreadyRunningError. otherDirs are also
   * checked for a running bot (both default homes, so an old Verda or Orbly and
   * a new Pacenote never connect at the same time), but the status file is
   * written only to dataDir.
   */
  static async acquire(
    dataDir: string,
    managedBy: BotStatus['managedBy'],
    waitMs = 30_000,
    otherDirs: readonly string[] = []
  ): Promise<BotStatusFile> {
    const deadline = Date.now() + waitMs
    for (;;) {
      const current = readRunningBot([dataDir, ...otherDirs])
      if (!current.alive || current.status?.pid === process.pid) break
      if (Date.now() >= deadline) {
        throw new BotAlreadyRunningError(
          current.status!.pid,
          current.status!.managedBy
        )
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    const now = new Date().toISOString()
    const handle = new BotStatusFile(path.join(dataDir, STATUS_FILE), {
      version: 1,
      pid: process.pid,
      startedAt: now,
      updatedAt: now,
      state: 'starting',
      managedBy,
      socket: { state: 'disconnected', since: now, reconnects: 0 },
      problems: [],
      requests: { active: 0, handled: 0 },
    })
    handle.write()
    process.once('exit', () => handle.release())
    return handle
  }

  get current(): BotStatus {
    return this.status
  }

  update(
    patch: Partial<Omit<BotStatus, 'version' | 'pid' | 'startedAt'>>
  ): void {
    this.status = { ...this.status, ...patch }
    this.write()
  }

  socket(state: SocketState): void {
    const previous = this.status.socket
    if (previous.state === state) return
    this.update({
      socket: {
        state,
        since: new Date().toISOString(),
        reconnects: previous.reconnects + (state === 'reconnecting' ? 1 : 0),
      },
    })
  }

  /** Deletes the file only if this process wrote it. */
  release(): void {
    try {
      const onDisk = JSON.parse(readFileSync(this.file, 'utf8')) as BotStatus
      if (onDisk.pid === process.pid) rmSync(this.file, { force: true })
    } catch {
      // Already gone.
    }
  }

  private write(): void {
    this.status.updatedAt = new Date().toISOString()
    try {
      mkdirSync(path.dirname(this.file), { recursive: true })
      writeFileSync(
        `${this.file}.tmp`,
        `${JSON.stringify(this.status, null, 2)}\n`
      )
      renameSync(`${this.file}.tmp`, this.file)
    } catch {
      // The bot keeps running even if the status file cannot be written.
    }
  }
}
