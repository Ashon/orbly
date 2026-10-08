import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { BotStatus, BotStatusView, SocketState } from "./types.js";

export const STATUS_FILE = "bot.json";
export const LOG_FILE = path.join("logs", "bot.log");

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM 이면 프로세스는 있지만 다른 사용자 소유다.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readBotStatus(dataDir: string): BotStatusView {
  const file = path.join(dataDir, STATUS_FILE);
  if (!existsSync(file)) return { alive: false };
  try {
    const status = JSON.parse(readFileSync(file, "utf8")) as BotStatus;
    return { status, alive: isAlive(status.pid) };
  } catch {
    return { alive: false };
  }
}

export class BotAlreadyRunningError extends Error {
  constructor(
    readonly pid: number,
    managedBy: string
  ) {
    super(
      `다른 Verda 봇이 실행 중입니다 (pid ${pid}, ${managedBy === "desktop" ? "데스크톱 앱" : "터미널"}). ` +
        "같은 앱 토큰으로 두 개를 띄우면 Slack 이 이벤트를 나눠 보내므로 하나만 실행합니다."
    );
  }
}

/** 이 프로세스의 상태 파일. 시작할 때 잡고(acquire) 종료할 때 지운다. */
export class BotStatusFile {
  private constructor(
    private readonly file: string,
    private status: BotStatus
  ) {}

  /**
   * 다른 봇이 살아 있으면 waitMs 동안 끝나기를 기다린다. (pnpm dev 재시작 때 이전 프로세스가 처리 중 요청을 마무리하는 시간)
   * 그래도 살아 있으면 BotAlreadyRunningError.
   */
  static async acquire(
    dataDir: string,
    managedBy: BotStatus["managedBy"],
    waitMs = 30_000
  ): Promise<BotStatusFile> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const current = readBotStatus(dataDir);
      if (!current.alive || current.status?.pid === process.pid) break;
      if (Date.now() >= deadline) {
        throw new BotAlreadyRunningError(current.status!.pid, current.status!.managedBy);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const now = new Date().toISOString();
    const handle = new BotStatusFile(path.join(dataDir, STATUS_FILE), {
      version: 1,
      pid: process.pid,
      startedAt: now,
      updatedAt: now,
      state: "starting",
      managedBy,
      socket: { state: "disconnected", since: now, reconnects: 0 },
      problems: [],
      requests: { active: 0, handled: 0 },
    });
    handle.write();
    process.once("exit", () => handle.release());
    return handle;
  }

  get current(): BotStatus {
    return this.status;
  }

  update(patch: Partial<Omit<BotStatus, "version" | "pid" | "startedAt">>): void {
    this.status = { ...this.status, ...patch };
    this.write();
  }

  socket(state: SocketState): void {
    const previous = this.status.socket;
    if (previous.state === state) return;
    this.update({
      socket: {
        state,
        since: new Date().toISOString(),
        reconnects: previous.reconnects + (state === "reconnecting" ? 1 : 0),
      },
    });
  }

  /** 이 프로세스가 쓴 파일일 때만 지운다. */
  release(): void {
    try {
      const onDisk = JSON.parse(readFileSync(this.file, "utf8")) as BotStatus;
      if (onDisk.pid === process.pid) rmSync(this.file, { force: true });
    } catch {
      // 이미 없다.
    }
  }

  private write(): void {
    this.status.updatedAt = new Date().toISOString();
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(`${this.file}.tmp`, `${JSON.stringify(this.status, null, 2)}\n`);
      renameSync(`${this.file}.tmp`, this.file);
    } catch {
      // 상태 파일을 못 써도 봇은 계속 동작한다.
    }
  }
}
