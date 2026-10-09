import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AppMentionEvent } from "@slack/types";
import type { WebClient } from "@slack/web-api";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { HistoryReader } from "../src/history/reader.js";
import { HistoryStore } from "../src/history/recorder.js";
import { createLogger } from "../src/logger.js";
import { InflightStore } from "../src/mention/inflight.js";
import { MentionResponder } from "../src/mention/responder.js";
import type { Directory } from "../src/messengers/slack/directory.js";
import { SlackMessenger } from "../src/messengers/slack/messenger.js";
import type { Mention, Messenger, Upload } from "../src/messengers/types.js";
import type { Reasoner, ReasonRequest } from "../src/reasoner/index.js";

const root = mkdtempSync(path.join(tmpdir(), "pacenote-responder-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function setup(complete: (request: ReasonRequest) => Promise<string>) {
  const updates: string[] = [];
  const client = {
    chat: {
      postMessage: async () => ({ ok: true, ts: "1791453237.582449" }),
      update: async ({ text }: { text: string }) => {
        updates.push(text);
        return { ok: true };
      },
      postEphemeral: async () => ({ ok: true }),
    },
    conversations: {
      replies: async () => ({
        messages: [
          {
            ts: "1791443475.275049",
            user: "U0BOSS",
            text: "web-01 is NotReady, apparently",
          },
          { ts: "1791443480.000100", user: "U0BOB", text: "Could someone check?" },
        ],
      }),
      history: async () => ({ messages: [] }),
    },
    files: { info: async () => ({ ok: true }), uploadV2: async () => ({ ok: true }) },
  } as unknown as WebClient;
  const directory = {
    channel: async () => ({ id: "C0OPS", label: "#ops", isPublic: true }),
    userNames: async () =>
      new Map([
        ["U0BOSS", "alice"],
        ["U0BOB", "bob"],
      ]),
  } as unknown as Directory;
  const reasoner: Reasoner = {
    backend: "codex",
    sandbox: "docker",
    canReadFiles: false,
    mcpServerNames: ["ops"],
    complete,
  };
  const history = new HistoryStore(path.join(root, "history"));
  const log = createLogger("error");
  const messenger = new SlackMessenger({
    client,
    directory,
    botUserId: "U0PACEY",
    workspaceUrl: "https://example.slack.com/",
    files: { token: "xoxb-1" },
    allowedUsers: [],
    log,
  });
  const responder = new MentionResponder({
    config: loadConfig({ SLACK_BOT_TOKEN: "xoxb-1", SLACK_APP_TOKEN: "xapp-1" }),
    messengers: [messenger],
    reasoner,
    log,
    extractPdfText: async () => "",
    inflight: new InflightStore(path.join(root, "inflight.json")),
    history,
  });
  return { responder, updates, reader: new HistoryReader(history.root) };
}

const mention = (ts: string): Mention =>
  SlackMessenger.mention({
    type: "app_mention",
    channel: "C0OPS",
    ts,
    thread_ts: "1791443475.275049",
    user: "U0BOSS",
    text: "<@U0PACEY> check the status of web-01",
    event_ts: ts,
  } as AppMentionEvent)!;

describe("mention run history", () => {
  it("records the request, context, prompt, tool steps, and answer, and marks the run succeeded", async () => {
    const { responder, updates, reader } = setup(async (request) => {
      request.onEvent?.({
        kind: "tool",
        id: "item_1",
        at: new Date().toISOString(),
        server: "ops",
        tool: "host_check",
        arguments: { host: "web-01" },
        status: "running",
      });
      request.onEvent?.({
        kind: "tool",
        id: "item_1",
        at: new Date().toISOString(),
        server: "ops",
        tool: "host_check",
        status: "completed",
        result: "up 3 days",
        finishedAt: new Date().toISOString(),
      });
      return "It is *healthy*.";
    });
    await responder.handle(mention("1791443490.000200"));
    expect(await responder.drain(5_000)).toBe(true);

    const [summary] = reader.list();
    expect(summary).toMatchObject({
      status: "succeeded",
      toolCalls: 1,
      userName: "alice",
    });
    const run = reader.get(summary!.id)!;
    expect(run.request).toBe("check the status of web-01");
    expect(run.context.messages).toBe(2);
    expect(run.answer).toBe("It is *healthy*.");
    expect(run.prompt?.user).toContain('<request from="@alice">');
    expect(run.origin).toMatchObject({
      messenger: "slack",
      conversationLabel: "#ops",
      userName: "alice",
    });
    expect(run.origin.permalink).toBe(
      "https://example.slack.com/archives/C0OPS/p1791453237582449?thread_ts=1791443475.275049&cid=C0OPS"
    );
    expect(run.events[0]).toMatchObject({ status: "completed", result: "up 3 days" });
    expect(updates.at(-1)).toBe("It is *healthy*.");
  });

  it("records a failed run with the error when the reasoner fails", async () => {
    const { responder, reader } = setup(async () => {
      throw new Error("codex run failed: quota exceeded");
    });
    await responder.handle(mention("1791443500.000300"));
    expect(await responder.drain(5_000)).toBe(true);
    const failed = reader.list({ status: "failed" });
    expect(failed).toHaveLength(1);
    expect(reader.get(failed[0]!.id)?.error).toContain("quota exceeded");
  });
});

/** A messenger that keeps everything in memory: what any adapter has to provide, and nothing Slack-specific */
class MemoryMessenger implements Messenger {
  readonly id = "slack" as const;
  readonly profile = {
    name: "Chat",
    venues: "rooms",
    markup: "plain text",
    public: false,
  };
  readonly posts: string[] = [];
  readonly updates: string[] = [];
  readonly notices: string[] = [];
  readonly uploads: Upload[][] = [];
  answerable = true;
  failUpload = false;

  constructor(readonly allowedUsers: readonly string[] = []) {}

  async venue() {
    return this.answerable
      ? { label: "room-1", answerable: true }
      : { label: "dm", answerable: false, refusal: "Not here." };
  }
  async request(mention: Mention) {
    return { text: mention.text, author: `@${mention.userId}`, userName: mention.userId };
  }
  async context() {
    return [{ id: "m0", at: 0, author: "@bob", text: "earlier", files: [] }];
  }
  async resolveFiles(files: Mention["files"]) {
    return files;
  }
  async download(): Promise<never> {
    throw new Error("no files");
  }
  async notice(_mention: Mention, text: string) {
    this.notices.push(text);
  }
  async post(_mention: Mention, text: string) {
    this.posts.push(text);
    return `p${this.posts.length}`;
  }
  async update(_mention: Mention, _message: string, text: string) {
    this.updates.push(text);
  }
  async upload(_mention: Mention, files: Upload[]) {
    if (this.failUpload) throw new Error("upload refused");
    this.uploads.push(files);
  }
  render(markdown: string) {
    return markdown.match(/[\s\S]{1,20}/g) ?? [""];
  }
  permalink() {
    return undefined;
  }
}

describe("answering through any messenger", () => {
  const base = (messenger: MemoryMessenger, answer = "short") =>
    new MentionResponder({
      config: loadConfig({ SLACK_BOT_TOKEN: "xoxb-1", SLACK_APP_TOKEN: "xapp-1" }),
      messengers: [messenger],
      reasoner: {
        backend: "claude",
        sandbox: "host",
        canReadFiles: false,
        mcpServerNames: [],
        complete: async (request) => {
          expect(request.system).toContain("answers mentions in Chat rooms.");
          expect(request.system).not.toContain("do not put secrets");
          expect(request.prompt).toContain("@bob: earlier");
          return answer;
        },
      },
      log: createLogger("error"),
      extractPdfText: async () => "",
    });
  const ask = (text: string, userId = "u1"): Mention => ({
    messenger: "slack",
    conversation: "room-1",
    message: `${Math.random()}`,
    thread: "t1",
    inThread: true,
    userId,
    text,
    files: [],
  });

  it("answers in the placeholder and posts the rest of a long answer", async () => {
    const messenger = new MemoryMessenger();
    const responder = base(messenger, "a".repeat(45));
    await responder.handle(ask("hi"));
    expect(await responder.drain(5_000)).toBe(true);
    expect(messenger.posts[0]).toMatch(/^Working on an answe/);
    expect(messenger.updates).toEqual(["a".repeat(20)]);
    expect(messenger.posts.slice(1)).toEqual(["a".repeat(20), "aaaaa"]);
  });

  it("tells the asker when they are not allowed or the venue is not answered", async () => {
    const closed = new MemoryMessenger(["u2"]);
    await base(closed).handle(ask("hi"));
    expect(closed.notices[0]).toMatch(/^This bot is only ava/);

    const elsewhere = new MemoryMessenger();
    elsewhere.answerable = false;
    await base(elsewhere).handle(ask("hi"));
    expect(elsewhere.notices).toEqual(["Not here."]);
    expect(elsewhere.posts).toEqual([]);
  });

  it("handles a redelivered mention once", async () => {
    const messenger = new MemoryMessenger();
    const responder = base(messenger);
    const mention = ask("hi");
    await responder.handle(mention);
    await responder.handle({ ...mention });
    expect(await responder.drain(5_000)).toBe(true);
    expect(messenger.updates).toEqual(["short"]);
  });
});
