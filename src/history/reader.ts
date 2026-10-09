import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import {
  ARTIFACTS_DIR,
  dayDirFor,
  dayOf,
  isDayDir,
  isSafeArtifactName,
  RUN_FILE,
  RUNS_DIR,
} from './layout.js'
import {
  normalizeRunRecord,
  summarize,
  type RunQuery,
  type RunRecord,
  type RunStats,
  type RunStatus,
  type RunSummary,
} from './types.js'

/**
 * Reads run history. Used by the desktop app. Uses the cache when a file has
 * not changed.
 */
export class HistoryReader {
  private readonly cache = new Map<
    string,
    { mtimeMs: number; record: RunRecord }
  >()

  constructor(readonly root: string) {}

  list(query: RunQuery = {}): RunSummary[] {
    const limit = Math.min(Math.max(query.limit ?? 200, 1), 1000)
    const q = query.q?.trim().toLowerCase()
    const result: RunSummary[] = []
    for (const record of this.records()) {
      if (query.status && record.status !== query.status) continue
      if (q && !matches(record, q)) continue
      result.push(summarize(record))
      if (result.length >= limit) break
    }
    return result
  }

  get(id: string): RunRecord | undefined {
    const dir = this.runDir(id)
    return dir ? this.load(path.join(dir, RUN_FILE)) : undefined
  }

  /**
   * Absolute path of an output file. undefined if the name is unsafe or the
   * file is missing
   */
  artifactPath(id: string, name: string): string | undefined {
    const dir = this.runDir(id)
    if (!dir || !isSafeArtifactName(name)) return undefined
    const file = path.join(dir, ARTIFACTS_DIR, name)
    return existsSync(file) ? file : undefined
  }

  stats(now = new Date()): RunStats {
    const byStatus: Record<RunStatus, number> = {
      running: 0,
      succeeded: 0,
      failed: 0,
      interrupted: 0,
    }
    const daily = new Map<string, { runs: number; failed: number }>()
    for (let i = 13; i >= 0; i -= 1) {
      daily.set(dayDirFor(new Date(now.getTime() - i * 86_400_000)), {
        runs: 0,
        failed: 0,
      })
    }
    const tools = new Map<string, number>()
    let total = 0
    let durationSum = 0
    let durationCount = 0
    for (const record of this.records()) {
      total += 1
      byStatus[record.status] += 1
      const day = daily.get(dayOf(record.id) ?? '')
      if (day) {
        day.runs += 1
        if (record.status === 'failed') day.failed += 1
      }
      if (record.status === 'succeeded' && record.durationMs !== undefined) {
        durationSum += record.durationMs
        durationCount += 1
      }
      for (const event of record.events) {
        if (event.kind !== 'tool') continue
        const name = `${event.server}.${event.tool}`
        tools.set(name, (tools.get(name) ?? 0) + 1)
      }
    }
    return {
      total,
      byStatus,
      daily: [...daily].map(([day, value]) => ({ day, ...value })),
      avgDurationMs: durationCount
        ? Math.round(durationSum / durationCount)
        : undefined,
      topTools: [...tools]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([name, calls]) => ({ name, calls })),
    }
  }

  /** Newest runs first */
  private *records(): Generator<RunRecord> {
    const runsDir = path.join(this.root, RUNS_DIR)
    if (!existsSync(runsDir)) return
    const days = readdirSync(runsDir).filter(isDayDir).sort().reverse()
    for (const day of days) {
      const ids = readdirSync(path.join(runsDir, day))
        .filter((id) => dayOf(id) === day)
        .sort()
        .reverse()
      for (const id of ids) {
        const record = this.load(path.join(runsDir, day, id, RUN_FILE))
        if (record) yield record
      }
    }
  }

  private load(file: string): RunRecord | undefined {
    try {
      const { mtimeMs } = statSync(file)
      const cached = this.cache.get(file)
      if (cached?.mtimeMs === mtimeMs) return cached.record
      const record = normalizeRunRecord(
        JSON.parse(readFileSync(file, 'utf8')) as RunRecord
      )
      this.cache.set(file, { mtimeMs, record })
      return record
    } catch {
      return undefined
    }
  }

  private runDir(id: string): string | undefined {
    const day = dayOf(id)
    return day ? path.join(this.root, RUNS_DIR, day, id) : undefined
  }
}

function matches(record: RunRecord, q: string): boolean {
  return [
    record.request,
    record.origin.conversationLabel,
    record.origin.userName ?? '',
    record.answer ?? '',
    record.error ?? '',
    record.id,
  ].some((value) => value.toLowerCase().includes(q))
}
