import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * 처리 중인 멘션 기록. 봇이 재시작(배포, tsx watch, 크래시)되어 응답이 끊기면
 * 다음 시작 때 같은 자리표시 메시지로 이어서 처리하거나 실패를 알린다.
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
  /** 실행 기록 id. 이어서 처리할 때 같은 기록에 이어 쓴다. */
  runId?: string;
  /** 지금까지 처리를 시작한 횟수 */
  attempts: number;
  startedAt: number;
}

/** 한 요청을 처리 시작할 수 있는 최대 횟수 (처음 1번 + 재시작 후 이어서 1번) */
export const MAX_ATTEMPTS = 2;
/** 이보다 오래된 요청은 이어서 처리하지 않는다. */
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

  /** 반쯤 쓴 파일이 남지 않도록 임시 파일에 쓰고 바꾼다. */
  private write(entries: InflightEntry[]): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`);
    renameSync(tmp, this.file);
  }
}
