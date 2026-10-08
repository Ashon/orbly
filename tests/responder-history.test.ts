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
import type { Reasoner, ReasonRequest } from "../src/reasoner/index.js";
import type { Directory } from "../src/slack/directory.js";

const root = mkdtempSync(path.join(tmpdir(), "verda-responder-"));
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
          { ts: "1791443475.275049", user: "U0BOSS", text: "web-01 가 NotReady 래요" },
          { ts: "1791443480.000100", user: "U0BOB", text: "확인 부탁해요" },
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
  const responder = new MentionResponder({
    config: loadConfig({ SLACK_BOT_TOKEN: "xoxb-1", SLACK_APP_TOKEN: "xapp-1" }),
    client,
    reasoner,
    directory,
    log: createLogger("error"),
    botUserId: "U0VERDA",
    extractPdfText: async () => "",
    inflight: new InflightStore(path.join(root, "inflight.json")),
    history,
    workspaceUrl: "https://example.slack.com/",
  });
  return { responder, updates, reader: new HistoryReader(history.root) };
}

const mention = (ts: string): AppMentionEvent =>
  ({
    type: "app_mention",
    channel: "C0OPS",
    ts,
    thread_ts: "1791443475.275049",
    user: "U0BOSS",
    text: "<@U0VERDA> web-01 상태 봐 줘",
    event_ts: ts,
  }) as AppMentionEvent;

describe("멘션 처리 기록", () => {
  it("요청, 맥락, 프롬프트, 도구 단계, 답변을 남기고 완료로 표시한다", async () => {
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
      return "*정상* 입니다.";
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
    expect(run.request).toBe("web-01 상태 봐 줘");
    expect(run.context.messages).toBe(2);
    expect(run.answer).toBe("*정상* 입니다.");
    expect(run.prompt?.user).toContain('<request from="@alice">');
    expect(run.slack.permalink).toBe(
      "https://example.slack.com/archives/C0OPS/p1791453237582449?thread_ts=1791443475.275049&cid=C0OPS"
    );
    expect(run.events[0]).toMatchObject({ status: "completed", result: "up 3 days" });
    expect(updates.at(-1)).toBe("*정상* 입니다.");
  });

  it("추론이 실패하면 오류와 함께 실패로 남긴다", async () => {
    const { responder, reader } = setup(async () => {
      throw new Error("codex 실행 실패: quota exceeded");
    });
    await responder.handle(mention("1791443500.000300"));
    expect(await responder.drain(5_000)).toBe(true);
    const failed = reader.list({ status: "failed" });
    expect(failed).toHaveLength(1);
    expect(reader.get(failed[0]!.id)?.error).toContain("quota exceeded");
  });
});
