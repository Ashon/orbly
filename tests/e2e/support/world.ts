import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HistoryReader } from "../../../src/history/reader.js";
import type { RunRecord } from "../../../src/history/types.js";
import type { BotStatus } from "../../../src/runtime/types.js";
import { FakeSlack } from "./fake-slack.js";
import { eventually, type ManagedProcess, REPO, startBot } from "./processes.js";

export const FAKE_CLAUDE = path.join(REPO, "tests/e2e/support/fake-claude.mjs");

export interface ClaudeRule {
  /** Regex on the request (case-insensitive) */
  match: string;
  answer?: string;
  delayMs?: number;
  fail?: string;
  tools?: { name: string; input?: unknown; result?: string }[];
}

export interface ClaudeCall {
  args: string[];
  system: string;
  prompt: string;
  request: string;
  images: number;
}

/**
 * One test's world: a fake Slack workspace with #ops (public), #secret (private), alice and bob, a fake claude
 * answering by rules, and a home for the bot. stop() ends everything and removes the home.
 */
export class World {
  readonly slack = new FakeSlack();
  readonly root = mkdtempSync(path.join(tmpdir(), "pacenote-e2e-"));
  readonly home = path.join(this.root, "home");
  readonly claudeDir = path.join(this.root, "claude");
  /**
   * CLAUDE_BIN: the fake claude behind a wrapper that names this node, since the bot's PATH may not have one (the
   * desktop app takes PATH from a login shell, here under the test's own HOME).
   */
  readonly claudeBin = path.join(this.root, "claude", "claude");
  readonly alice = this.slack.addUser({ id: "U0ALICE", name: "alice" });
  readonly bob = this.slack.addUser({ id: "U0BOB", name: "bob" });
  readonly ops = this.slack.addChannel({ id: "C0OPS", name: "ops", isPublic: true });
  readonly secret = this.slack.addChannel({
    id: "G0SECRET",
    name: "secret",
    isPublic: false,
  });
  private readonly processes: ManagedProcess[] = [];

  constructor(rules: ClaudeRule[] = [], answer = "OK") {
    mkdirSync(this.claudeDir, { recursive: true });
    this.script(rules, answer);
    writeFileSync(
      this.claudeBin,
      `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLAUDE}" "$@"\n`
    );
    chmodSync(this.claudeBin, 0o755);
  }

  static async create(rules: ClaudeRule[] = [], answer = "OK"): Promise<World> {
    const world = new World(rules, answer);
    await world.slack.start();
    return world;
  }

  /** Replaces the fake claude's rules */
  script(rules: ClaudeRule[], answer = "OK"): void {
    writeFileSync(
      path.join(this.claudeDir, "script.json"),
      JSON.stringify({ rules, answer })
    );
  }

  /** The environment of a bot on its own Slack app (Socket Mode) against the fake workspace */
  botEnv(extra: Record<string, string> = {}): Record<string, string> {
    return {
      HOME: this.root,
      PACENOTE_HOME: this.home,
      PACENOTE_DATA_DIR: this.home,
      SLACK_BOT_TOKEN: this.slack.botToken,
      SLACK_APP_TOKEN: this.slack.appToken,
      SLACK_API_URL: this.slack.apiUrl,
      REASONER: "claude",
      REASONER_SANDBOX: "none",
      CLAUDE_BIN: this.claudeBin,
      FAKE_CLAUDE_DIR: this.claudeDir,
      RENDER_DIAGRAMS: "off",
      TIMEZONE: "UTC",
      LOG_LEVEL: "debug",
      ...extra,
    };
  }

  /** Starts the bot and waits until it is connected and ready */
  async startBot(extra: Record<string, string> = {}): Promise<ManagedProcess> {
    const bot = this.track(startBot(this.botEnv(extra)));
    await bot.waitFor(/Started: /);
    await eventually(
      "the Socket Mode or hub connection",
      () => this.status()?.socket.state === "connected"
    );
    return bot;
  }

  track(process: ManagedProcess): ManagedProcess {
    this.processes.push(process);
    return process;
  }

  /** The bot's status file (what the desktop app shows) */
  status(): BotStatus | undefined {
    const file = path.join(this.home, "bot.json");
    if (!existsSync(file)) return undefined;
    try {
      return JSON.parse(readFileSync(file, "utf8")) as BotStatus;
    } catch {
      return undefined;
    }
  }

  runs(): RunRecord[] {
    const reader = new HistoryReader(this.home);
    return reader.list().map((summary) => reader.get(summary.id)!);
  }

  claudeCalls(): ClaudeCall[] {
    const file = path.join(this.claudeDir, "calls.jsonl");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ClaudeCall);
  }

  /** Waits until the bot's last message in the thread no longer says it is working, and returns the thread's replies */
  async answered(channel: string, thread: string, count = 1) {
    return eventually(`the bot's answer in ${thread}`, () => {
      const replies = this.slack.replies(channel, thread);
      return replies.length >= count &&
        replies.every((reply) => !/^(Working on it|I restarted)/.test(reply.text))
        ? replies
        : undefined;
    });
  }

  async stop(): Promise<void> {
    await Promise.all(this.processes.map((process) => process.stop()));
    await this.slack.stop();
    rmSync(this.root, { recursive: true, force: true });
  }
}
