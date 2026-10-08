import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { HistoryReader } from "../src/history/reader.js";
import { handleLocalApi } from "../src/local-api.js";
import { createLogger, fileSink, redactLogLine } from "../src/logger.js";
import { parseLogLine, tailLogs } from "../src/runtime/logs.js";
import {
  BotAlreadyRunningError,
  BotStatusFile,
  LOG_FILE,
  readBotStatus,
  STATUS_FILE,
} from "../src/runtime/status.js";
import { slackLogger } from "../src/slack/logger.js";

const root = mkdtempSync(path.join(tmpdir(), "verda-runtime-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const dir = (name: string) => {
  const d = path.join(root, name);
  mkdirSync(d, { recursive: true });
  return d;
};

describe("로그 파일", () => {
  it("scope 를 붙여 쓰고, 비밀 값과 Socket Mode ticket 을 가린다", () => {
    const file = path.join(dir("log"), LOG_FILE);
    const log = createLogger("info", "verda", [fileSink(file)]);
    log
      .child("socket")
      .info("연결 wss://wss-primary.slack.com/link/?ticket=abc-123&app_id=A1");
    log.warn("토큰 xoxb-1234567890-abcdefghij 노출");
    log.debug("debug 는 기록하지 않는다");
    log.error("실패", new Error("boom"));
    const text = readFileSync(file, "utf8");
    expect(text).toContain(
      "INFO  [verda:socket] 연결 wss://wss-primary.slack.com/link/?ticket=[REDACTED]&app_id=A1"
    );
    expect(text).toContain("[REDACTED SLACK TOKEN]");
    expect(text).not.toContain("debug 는");
    expect(text).toMatch(/ERROR \[verda\] 실패\nError: boom\n\s+at /);
    expect(redactLogLine("x?ticket=t1")).toBe("x?ticket=[REDACTED]");
  });

  it("크기를 넘으면 .1 로 넘기고 새로 쓴다", () => {
    const file = path.join(dir("rotate"), LOG_FILE);
    const log = createLogger("info", "verda", [fileSink(file, 200)]);
    for (let i = 0; i < 5; i += 1) log.info(`line ${i} ${"x".repeat(40)}`);
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("line 4");
  });

  it("마지막 부분을 줄 단위로 읽고 여러 줄 로그는 합친다", () => {
    const d = dir("tail");
    const log = createLogger("info", "verda", [fileSink(path.join(d, LOG_FILE))]);
    log.child("socket").info("Socket Mode 연결됨");
    log.child("mention").warn("첨부 실패");
    log.error("오류", new Error("multi"));
    const lines = tailLogs(d);
    expect(lines.map((l) => [l.level, l.scope])).toEqual([
      ["INFO", "verda:socket"],
      ["WARN", "verda:mention"],
      ["ERROR", "verda"],
    ]);
    expect(lines[2]!.message).toContain("Error: multi");
    expect(tailLogs(d, { scope: "verda:socket" })).toHaveLength(1);
    expect(tailLogs(d, { minLevel: "WARN" })).toHaveLength(2);
    expect(tailLogs(d, { lines: 1 })[0]!.level).toBe("ERROR");
    expect(parseLogLine("plain")).toEqual({ message: "plain" });
  });

  it("Slack 라이브러리 로그를 봇 로거로 보낸다", () => {
    const d = dir("slack");
    const log = createLogger("info", "verda", [fileSink(path.join(d, LOG_FILE))]);
    const slack = slackLogger(log.child("socket"), "info");
    slack.setName("socket-mode:SlackWebSocket:1");
    slack.info("Going to establish a new connection", { attempt: 1 });
    slack.debug("ping");
    expect(slack.getLevel()).toBe("info");
    const [line] = tailLogs(d);
    expect(line).toMatchObject({
      scope: "verda:socket",
      message: "Going to establish a new connection { attempt: 1 }",
    });
    expect(tailLogs(d)).toHaveLength(1);
  });
});

describe("봇 상태 파일", () => {
  it("이전 프로세스가 죽었으면 잠금을 가져가고, 소켓 상태와 재연결 수를 남긴다", async () => {
    const d = dir("status");
    writeFileSync(
      path.join(d, STATUS_FILE),
      JSON.stringify({ pid: 999_999_999, managedBy: "terminal" })
    );
    const status = await BotStatusFile.acquire(d, "desktop", 0);
    status.socket("connecting");
    status.socket("connected");
    status.socket("reconnecting");
    status.socket("connected");
    status.update({ state: "running" });
    const view = readBotStatus(d);
    expect(view.alive).toBe(true);
    expect(view.status).toMatchObject({
      pid: process.pid,
      managedBy: "desktop",
      state: "running",
      socket: { state: "connected", reconnects: 1 },
    });
    status.release();
    expect(existsSync(path.join(d, STATUS_FILE))).toBe(false);
  });

  it("다른 봇이 살아 있으면 기다렸다가 실패한다", async () => {
    const d = dir("locked");
    // 부모 프로세스(vitest)는 테스트 동안 살아 있다.
    writeFileSync(
      path.join(d, STATUS_FILE),
      JSON.stringify({ pid: process.ppid, managedBy: "terminal" })
    );
    await expect(BotStatusFile.acquire(d, "desktop", 600)).rejects.toBeInstanceOf(
      BotAlreadyRunningError
    );
  });
});

describe("조회 API: 봇", () => {
  it("상태와 로그를 읽기 전용으로 준다", async () => {
    const d = dir("api");
    const reader = new HistoryReader(d);
    const get = async (p: string) =>
      (await handleLocalApi(reader, "GET", new URL(p, "verda://app"))).json();
    expect(await get("/api/bot")).toEqual({ alive: false });
    const log = createLogger("info", "verda", [fileSink(path.join(d, LOG_FILE))]);
    log.child("socket").warn("Socket Mode 재연결 중");
    log.info("시작");
    expect(await get("/api/bot/logs?level=warn")).toEqual([
      expect.objectContaining({ level: "WARN", scope: "verda:socket" }),
    ]);
    expect(await get("/api/bot/logs?scope=verda:socket")).toHaveLength(1);
  });
});
