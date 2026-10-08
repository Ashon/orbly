import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../logger.js";
import {
  ARTIFACTS_DIR,
  dayDirFor,
  dayOf,
  isDayDir,
  isSafeArtifactName,
  RUN_FILE,
  runIdFor,
  RUNS_DIR,
} from "./layout.js";
import {
  RUN_RECORD_VERSION,
  type RunEvent,
  type RunRecord,
  type RunStatus,
} from "./types.js";

/** 한 실행에 남기는 최대 단계 수. 넘으면 이후 단계는 버리고 한 번 알린다. */
const MAX_EVENTS = 2_000;
const MAX_TEXT_CHARS = 20_000;
const MAX_PROMPT_CHARS = 200_000;
/** 진행 중 기록을 파일에 쓰는 간격 */
const WRITE_DELAY_MS = 400;

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}\n... (${text.length}자 중 일부)` : text;

export type RunInit = Pick<RunRecord, "slack" | "request" | "backend">;

/** 실행 기록 파일 쓰기. 봇 프로세스에서만 쓴다. */
export class HistoryStore {
  constructor(
    readonly root: string,
    private readonly log?: Logger
  ) {}

  start(init: RunInit, now = new Date()): RunHandle {
    const id = runIdFor(now, randomBytes(3).toString("hex"));
    const at = now.toISOString();
    const record: RunRecord = {
      version: RUN_RECORD_VERSION,
      id,
      status: "running",
      attempts: 1,
      startedAt: at,
      updatedAt: at,
      ...init,
      request: clip(init.request, MAX_TEXT_CHARS),
      context: { messages: 0 },
      attachments: [],
      events: [],
      outputs: [],
    };
    const handle = new RunHandle(record, this.runDir(id)!, this.log);
    handle.flush();
    return handle;
  }

  /** 재시작 후 이어서 처리할 때 기존 기록을 다시 연다. */
  reopen(id: string): RunHandle | undefined {
    const record = this.read(id);
    if (!record) return undefined;
    return new RunHandle(record, this.runDir(id)!, this.log);
  }

  read(id: string): RunRecord | undefined {
    const dir = this.runDir(id);
    if (!dir) return undefined;
    try {
      return JSON.parse(readFileSync(path.join(dir, RUN_FILE), "utf8")) as RunRecord;
    } catch {
      return undefined;
    }
  }

  /**
   * 시작할 때, 진행 중으로 남아 있지만 이어서 처리하지 않을 실행을 중단으로 표시한다.
   * keep 에 있는 id 는 이어서 처리될 실행이라 건드리지 않는다.
   */
  interruptStale(keep: ReadonlySet<string>, now = new Date()): number {
    let count = 0;
    for (const day of this.days().slice(0, 7)) {
      const dayDir = path.join(this.root, RUNS_DIR, day);
      for (const id of readdirSync(dayDir)) {
        if (keep.has(id)) continue;
        const record = this.read(id);
        if (record?.status !== "running") continue;
        const handle = new RunHandle(record, path.join(dayDir, id), this.log);
        handle.event({
          kind: "note",
          at: now.toISOString(),
          text: "봇이 재시작되어 중단됨",
        });
        handle.finish("interrupted", { error: "봇 재시작으로 중단" }, now);
        count += 1;
      }
    }
    return count;
  }

  /** 보관 기간이 지난 날짜 디렉터리를 지운다. 0 이면 지우지 않는다. */
  prune(retentionDays: number, now = new Date()): number {
    if (retentionDays <= 0) return 0;
    const cutoff = dayDirFor(new Date(now.getTime() - retentionDays * 86_400_000));
    let removed = 0;
    for (const day of this.days()) {
      if (day >= cutoff) continue;
      rmSync(path.join(this.root, RUNS_DIR, day), { recursive: true, force: true });
      removed += 1;
    }
    return removed;
  }

  /** 날짜 디렉터리 이름 (최신순) */
  private days(): string[] {
    const dir = path.join(this.root, RUNS_DIR);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter(isDayDir).sort().reverse();
  }

  private runDir(id: string): string | undefined {
    const day = dayOf(id);
    return day ? path.join(this.root, RUNS_DIR, day, id) : undefined;
  }
}

/** 한 실행의 기록. 바뀔 때마다 잠시 모았다가 run.json 을 통째로 다시 쓴다. */
export class RunHandle {
  private timer?: NodeJS.Timeout;
  private dropped = false;
  /** 재시도한 실행은 도구 호출 id 가 겹치지 않게 시도 번호를 붙인다. */
  private idPrefix: string;

  constructor(
    readonly record: RunRecord,
    readonly dir: string,
    private readonly log?: Logger
  ) {
    this.idPrefix = record.attempts > 1 ? `${record.attempts}:` : "";
  }

  get id(): string {
    return this.record.id;
  }

  /** 재시작 후 이어서 처리한다. */
  resume(now = new Date()): void {
    this.record.attempts += 1;
    this.idPrefix = `${this.record.attempts}:`;
    this.record.status = "running";
    delete this.record.finishedAt;
    delete this.record.durationMs;
    delete this.record.error;
    this.event({
      kind: "note",
      at: now.toISOString(),
      text: `봇이 재시작되어 이어서 처리 (시도 ${this.record.attempts}회째)`,
    });
  }

  patch(fields: Partial<Omit<RunRecord, "id" | "version" | "events">>): void {
    Object.assign(this.record, fields);
    this.schedule();
  }

  setPrompt(system: string, user: string): void {
    this.patch({
      prompt: { system, user: clip(user, MAX_PROMPT_CHARS) },
    });
  }

  /** 단계를 추가한다. 도구/명령 단계는 같은 id 면 이전 단계에 합친다. (시작 -> 완료) */
  event(event: RunEvent): void {
    const events = this.record.events;
    if (event.kind === "tool" || event.kind === "command") {
      const id = `${this.idPrefix}${event.id}`;
      const kind = event.kind;
      const index = events.findIndex(
        (e) =>
          (e.kind === "tool" || e.kind === "command") && e.kind === kind && e.id === id
      );
      if (index >= 0) {
        const merged = { ...events[index] } as Record<string, unknown>;
        for (const [key, value] of Object.entries(event)) {
          // claude 의 도구 결과에는 서버/도구 이름이 비어 있다. 시작 시점 값을 유지한다.
          if (key === "at" || key === "id" || value === undefined || value === "")
            continue;
          merged[key] = value;
        }
        events[index] = merged as RunEvent;
        this.schedule();
        return;
      }
      event = { ...event, id };
    } else if (
      event.kind === "message" ||
      event.kind === "reasoning" ||
      event.kind === "note"
    ) {
      event = { ...event, text: clip(event.text, MAX_TEXT_CHARS) };
    }
    if (events.length >= MAX_EVENTS) {
      if (!this.dropped) {
        this.dropped = true;
        events.push({
          kind: "note",
          at: new Date().toISOString(),
          text: "단계가 너무 많아 이후 기록은 생략",
        });
      }
      return;
    }
    events.push(event);
    this.schedule();
  }

  /** 산출물(PNG 등)을 artifacts/ 에 저장하고 파일 이름을 돌려준다. */
  async saveArtifact(name: string, data: Buffer): Promise<string> {
    if (!isSafeArtifactName(name))
      throw new Error(`산출물 이름이 올바르지 않습니다: ${name}`);
    const dir = path.join(this.dir, ARTIFACTS_DIR);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, name), data);
    return name;
  }

  finish(
    status: Exclude<RunStatus, "running">,
    fields: Partial<RunRecord> = {},
    now = new Date()
  ): void {
    Object.assign(this.record, fields);
    this.record.status = status;
    this.record.finishedAt = now.toISOString();
    this.record.durationMs = now.getTime() - Date.parse(this.record.startedAt);
    this.flush();
  }

  /** 지금 바로 run.json 을 쓴다. 반쯤 쓴 파일이 남지 않도록 임시 파일에 쓰고 바꾼다. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.record.updatedAt = new Date().toISOString();
    try {
      mkdirSync(this.dir, { recursive: true });
      const file = path.join(this.dir, RUN_FILE);
      writeFileSync(`${file}.tmp`, `${JSON.stringify(this.record, null, 2)}\n`);
      renameSync(`${file}.tmp`, file);
    } catch (err) {
      // 기록 실패가 응답을 막지 않게 한다.
      this.log?.warn(`실행 기록 저장 실패 ${this.id}: ${(err as Error).message}`);
    }
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), WRITE_DELAY_MS);
    this.timer.unref();
  }
}
