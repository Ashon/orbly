import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Record of in-progress mentions. When a bot restart (deploy, tsx watch, crash) cuts off an answer,
 * the next start resumes it in the same placeholder message or reports the failure.
 */
export interface InflightEvent {
  channel: string;
  ts: string;
  thread_ts?: string;
  user: string;
  text: string;
  files?: unknown[];
}

export interface InflightEntry {
  key: string;
  event: InflightEvent;
  threadTs: string;
  label: string;
  placeholderTs: string;
  /** Run id. When resuming, writing continues in the same run. */
  runId?: string;
  /** Number of times processing has started so far */
  attempts: number;
  startedAt: number;
}

/** Maximum number of times processing can start for one request (1 initial + 1 resume after a restart) */
export const MAX_ATTEMPTS = 2;
/** Requests older than this are not resumed. */
export const MAX_RESUME_AGE_MS = 30 * 60_000;

export type ResumeDecision = "resume" | "give_up";

export function resumeDecision(entry: InflightEntry, now = Date.now()): ResumeDecision {
  if (entry.attempts >= MAX_ATTEMPTS) return "give_up";
  if (now - entry.startedAt > MAX_RESUME_AGE_MS) return "give_up";
  return "resume";
}

export class InflightStore {
  constructor(private readonly file: string) {}

  list(): InflightEntry[] {
    if (!existsSync(this.file)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      return Array.isArray(parsed) ? (parsed as InflightEntry[]) : [];
    } catch {
      return [];
    }
  }

  upsert(entry: InflightEntry): void {
    this.write([...this.list().filter((e) => e.key !== entry.key), entry]);
  }

  remove(key: string): void {
    const entries = this.list();
    const rest = entries.filter((e) => e.key !== key);
    if (rest.length !== entries.length) this.write(rest);
  }

  /** Writes to a temporary file and renames it so no half-written file is left behind. */
  private write(entries: InflightEntry[]): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`);
    renameSync(tmp, this.file);
  }
}
