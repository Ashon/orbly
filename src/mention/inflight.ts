import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { toMessageFile, type SlackFileRef } from '../messengers/slack/files.js'
import { mentionKey, type Mention } from '../messengers/types.js'

/**
 * Record of in-progress mentions. When a bot restart (deploy, tsx watch, crash)
 * cuts off an answer, the next start resumes it in the same placeholder message
 * or reports the failure.
 */
export interface InflightEntry {
  /** mentionKey(mention) */
  key: string
  mention: Mention
  /** Where it was asked, as the run history shows it ("#ops") */
  label: string
  /** The bot's message the answer goes into */
  placeholder: string
  /** Run id. When resuming, writing continues in the same run. */
  runId?: string
  /** Number of times processing has started so far */
  attempts: number
  startedAt: number
}

/** An entry as written before messengers existed (Slack only, through v0.2) */
interface SlackEntry {
  key: string
  event: {
    channel: string
    ts: string
    thread_ts?: string
    user: string
    text: string
    files?: unknown[]
  }
  threadTs: string
  label: string
  placeholderTs: string
  runId?: string
  attempts: number
  startedAt: number
}

function fromSlackEntry({
  event,
  threadTs,
  placeholderTs,
  ...rest
}: SlackEntry): InflightEntry {
  const mention: Mention = {
    messenger: 'slack',
    conversation: event.channel,
    message: event.ts,
    thread: threadTs,
    inThread: Boolean(event.thread_ts),
    userId: event.user,
    text: event.text,
    files: ((event.files ?? []) as SlackFileRef[]).map(toMessageFile),
  }
  return {
    ...rest,
    key: mentionKey(mention),
    mention,
    placeholder: placeholderTs,
  }
}

/**
 * Maximum number of times processing can start for one request (1 initial + 1
 * resume after a restart)
 */
export const MAX_ATTEMPTS = 2
/** Requests older than this are not resumed. */
export const MAX_RESUME_AGE_MS = 30 * 60_000

export type ResumeDecision = 'resume' | 'give_up'

export function resumeDecision(
  entry: InflightEntry,
  now = Date.now()
): ResumeDecision {
  if (entry.attempts >= MAX_ATTEMPTS) return 'give_up'
  if (now - entry.startedAt > MAX_RESUME_AGE_MS) return 'give_up'
  return 'resume'
}

export class InflightStore {
  constructor(private readonly file: string) {}

  list(): InflightEntry[] {
    if (!existsSync(this.file)) return []
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
      if (!Array.isArray(parsed)) return []
      return (parsed as (InflightEntry | SlackEntry)[]).map((entry) =>
        'event' in entry ? fromSlackEntry(entry) : entry
      )
    } catch {
      return []
    }
  }

  upsert(entry: InflightEntry): void {
    this.write([...this.list().filter((e) => e.key !== entry.key), entry])
  }

  remove(key: string): void {
    const entries = this.list()
    const rest = entries.filter((e) => e.key !== key)
    if (rest.length !== entries.length) this.write(rest)
  }

  /**
   * Writes to a temporary file and renames it so no half-written file is left
   * behind.
   */
  private write(entries: InflightEntry[]): void {
    mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`)
    renameSync(tmp, this.file)
  }
}
