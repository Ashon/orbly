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

const root = mkdtempSync(path.join(tmpdir(), "orbly-runtime-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const dir = (name: string) => {
  const d = path.join(root, name);
  mkdirSync(d, { recursive: true });
  return d;
};

describe("log file", () => {
  it("writes the scope and redacts secrets and the Socket Mode ticket", () => {
    const file = path.join(dir("log"), LOG_FILE);
    const log = createLogger("info", "orbly", [fileSink(file)]);
    log
      .child("socket")
      .info("connect wss://wss-primary.slack.com/link/?ticket=abc-123&app_id=A1");
    log.warn("token xoxb-1234567890-abcdefghij exposed");
    log.debug("debug is not recorded");
    log.error("failed", new Error("boom"));
    const text = readFileSync(file, "utf8");
    expect(text).toContain(
      "INFO  [orbly:socket] connect wss://wss-primary.slack.com/link/?ticket=[REDACTED]&app_id=A1"
    );
    expect(text).toContain("[REDACTED SLACK TOKEN]");
    expect(text).not.toContain("debug is");
    expect(text).toMatch(/ERROR \[orbly\] failed\nError: boom\n\s+at /);
    expect(redactLogLine("x?ticket=t1")).toBe("x?ticket=[REDACTED]");
  });

  it("rotates to .1 and starts fresh past the size limit", () => {
    const file = path.join(dir("rotate"), LOG_FILE);
    const log = createLogger("info", "orbly", [fileSink(file, 200)]);
    for (let i = 0; i < 5; i += 1) log.info(`line ${i} ${"x".repeat(40)}`);
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("line 4");
  });

  it("reads the tail line by line and joins multi-line entries", () => {
    const d = dir("tail");
    const log = createLogger("info", "orbly", [fileSink(path.join(d, LOG_FILE))]);
    log.child("socket").info("Socket Mode connected");
    log.child("mention").warn("attachment failed");
    log.error("error", new Error("multi"));
    const lines = tailLogs(d);
    expect(lines.map((l) => [l.level, l.scope])).toEqual([
      ["INFO", "orbly:socket"],
      ["WARN", "orbly:mention"],
      ["ERROR", "orbly"],
    ]);
    expect(lines[2]!.message).toContain("Error: multi");
    expect(tailLogs(d, { scope: "orbly:socket" })).toHaveLength(1);
    expect(tailLogs(d, { minLevel: "WARN" })).toHaveLength(2);
    expect(tailLogs(d, { lines: 1 })[0]!.level).toBe("ERROR");
    expect(parseLogLine("plain")).toEqual({ message: "plain" });
  });

  it("routes Slack library logs to the bot logger", () => {
    const d = dir("slack");
    const log = createLogger("info", "orbly", [fileSink(path.join(d, LOG_FILE))]);
    const slack = slackLogger(log.child("socket"), "info");
    slack.setName("socket-mode:SlackWebSocket:1");
    slack.info("Going to establish a new connection", { attempt: 1 });
    slack.debug("ping");
    expect(slack.getLevel()).toBe("info");
    const [line] = tailLogs(d);
    expect(line).toMatchObject({
      scope: "orbly:socket",
      message: "Going to establish a new connection { attempt: 1 }",
    });
    expect(tailLogs(d)).toHaveLength(1);
  });
});

describe("bot status file", () => {
  it("takes the lock when the previous process is dead and records socket state and reconnects", async () => {
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

  it("waits and then fails when another bot is alive", async () => {
    const d = dir("locked");
    // The parent process (vitest) stays alive during the test.
    writeFileSync(
      path.join(d, STATUS_FILE),
      JSON.stringify({ pid: process.ppid, managedBy: "terminal" })
    );
    await expect(BotStatusFile.acquire(d, "desktop", 600)).rejects.toBeInstanceOf(
      BotAlreadyRunningError
    );
  });
});

describe("query API: bot", () => {
  it("serves status and logs read-only", async () => {
    const d = dir("api");
    const reader = new HistoryReader(d);
    const get = async (p: string) =>
      (await handleLocalApi(reader, "GET", new URL(p, "orbly://app"))).json();
    expect(await get("/api/bot")).toEqual({ alive: false });
    const log = createLogger("info", "orbly", [fileSink(path.join(d, LOG_FILE))]);
    log.child("socket").warn("Socket Mode reconnecting");
    log.info("started");
    expect(await get("/api/bot/logs?level=warn")).toEqual([
      expect.objectContaining({ level: "WARN", scope: "orbly:socket" }),
    ]);
    expect(await get("/api/bot/logs?scope=orbly:socket")).toHaveLength(1);
  });
});
