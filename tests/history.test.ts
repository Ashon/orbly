import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  claudeLineToEvents,
  codexLineToEvents,
  lastMessage,
  splitToolName,
} from "../src/history/events.js";
import { handleLocalApi } from "../src/local-api.js";
import { dayOf, isSafeArtifactName, runIdFor } from "../src/history/layout.js";
import { HistoryReader } from "../src/history/reader.js";
import { HistoryStore } from "../src/history/recorder.js";
import { slackPermalink } from "../src/mention/responder.js";
import { parseCodexOutput } from "../src/reasoner/index.js";

const AT = "2026-10-08T05:00:00.000Z";

const codexLines = [
  { type: "thread.started", thread_id: "t1" },
  {
    type: "item.started",
    item: {
      id: "item_1",
      type: "mcp_tool_call",
      server: "ops",
      tool: "host_check",
      arguments: { check: "uptime", host: "web-01" },
      result: null,
      error: null,
      status: "in_progress",
    },
  },
  {
    type: "item.completed",
    item: {
      id: "item_1",
      type: "mcp_tool_call",
      server: "ops",
      tool: "host_check",
      arguments: { check: "uptime", host: "web-01" },
      result: { content: [{ type: "text", text: "$ uptime\n up 3 days" }] },
      error: null,
      status: "completed",
    },
  },
  {
    type: "item.completed",
    item: { id: "item_2", type: "agent_message", text: "web-01 는 3일째 동작 중입니다." },
  },
  {
    type: "turn.completed",
    usage: { input_tokens: 43200, cached_input_tokens: 40576, output_tokens: 131 },
  },
].map((line) => JSON.stringify(line));

describe("codex 이벤트", () => {
  it("도구 호출, 메시지, 사용량을 단계로 바꾼다", () => {
    const events = codexLines.flatMap((line) => codexLineToEvents(line, AT));
    expect(events.map((e) => e.kind)).toEqual(["tool", "tool", "message", "usage"]);
    expect(events[0]).toMatchObject({ id: "item_1", status: "running", server: "ops" });
    expect(events[1]).toMatchObject({
      status: "completed",
      result: "$ uptime\n up 3 days",
    });
    expect(events[3]).toMatchObject({ inputTokens: 43200, outputTokens: 131 });
    expect(lastMessage(events)).toBe("web-01 는 3일째 동작 중입니다.");
    expect(codexLineToEvents("not json")).toEqual([]);
  });

  it("최종 답은 마지막 agent_message 이고, 없으면 오류 이벤트를 알린다", () => {
    expect(parseCodexOutput(codexLines.join("\n"))).toBe(
      "web-01 는 3일째 동작 중입니다."
    );
    const failed = JSON.stringify({
      type: "turn.failed",
      error: { message: "quota exceeded" },
    });
    expect(() => parseCodexOutput(failed)).toThrow(/quota exceeded/);
    expect(() => parseCodexOutput("")).toThrow(/빈 응답/);
  });
});

describe("claude 이벤트", () => {
  it("tool_use 와 tool_result 를 같은 id 로 묶을 수 있게 만든다", () => {
    const use = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "확인해 보겠습니다." },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "mcp__ops__k8s_get",
            input: { kind: "pods" },
          },
        ],
      },
    });
    const result = JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [{ type: "text", text: "3 pods" }],
          },
        ],
      },
    });
    const done = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "끝",
      total_cost_usd: 0.12,
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const events = [use, result, done].flatMap((line) => claudeLineToEvents(line, AT));
    expect(events).toMatchObject([
      { kind: "message", text: "확인해 보겠습니다." },
      { kind: "tool", id: "toolu_1", server: "ops", tool: "k8s_get", status: "running" },
      { kind: "tool", id: "toolu_1", status: "completed", result: "3 pods" },
      { kind: "usage", costUsd: 0.12, inputTokens: 10 },
    ]);
    expect(splitToolName("Read")).toEqual({ server: "claude", tool: "Read" });
    expect(splitToolName("mcp__ops__ws_create_pr")).toEqual({
      server: "ops",
      tool: "ws_create_pr",
    });
  });
});

describe("실행 기록", () => {
  const root = mkdtempSync(path.join(tmpdir(), "verda-history-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const store = new HistoryStore(root);
  const reader = new HistoryReader(root);
  const init = {
    slack: {
      channel: "C1",
      channelLabel: "#ops",
      threadTs: "1.0",
      eventTs: "1.0",
      userId: "U1",
    },
    request: "web-01 상태 확인",
    backend: { reasoner: "codex", sandbox: "docker" },
  };

  it("run id 에 날짜가 들어 있고 산출물 이름을 검사한다", () => {
    const id = runIdFor(new Date(2026, 9, 8, 14, 3, 9), "a1b2c3");
    expect(id).toBe("20261008-140309-a1b2c3");
    expect(dayOf(id)).toBe("2026-10-08");
    expect(dayOf("../etc")).toBeUndefined();
    expect(isSafeArtifactName("figure-1.png")).toBe(true);
    expect(isSafeArtifactName("../run.json")).toBe(false);
  });

  it("단계를 합치고, 완료하면 목록과 상세에서 보인다", async () => {
    const run = store.start(init, new Date(2026, 9, 8, 14, 0, 0));
    for (const event of codexLines.flatMap((line) => codexLineToEvents(line, AT)))
      run.event(event);
    await run.saveArtifact("figure-1.png", Buffer.from([0x89, 0x50]));
    run.patch({ outputs: [{ kind: "diagram", file: "figure-1.png", title: "그림 1" }] });
    run.finish("succeeded", { answer: "정상" }, new Date(2026, 9, 8, 14, 0, 12));

    const saved = JSON.parse(readFileSync(path.join(run.dir, "run.json"), "utf8"));
    expect(saved.events.filter((e: { kind: string }) => e.kind === "tool")).toHaveLength(
      1
    );
    expect(saved.events[0]).toMatchObject({
      status: "completed",
      result: "$ uptime\n up 3 days",
    });

    const [summary] = reader.list();
    expect(summary).toMatchObject({
      id: run.id,
      status: "succeeded",
      durationMs: 12_000,
      toolCalls: 1,
      outputs: 1,
      reasoner: "codex@docker",
    });
    expect(reader.get(run.id)?.answer).toBe("정상");
    expect(reader.artifactPath(run.id, "figure-1.png")).toBe(
      path.join(run.dir, "artifacts", "figure-1.png")
    );
    expect(reader.artifactPath(run.id, "../run.json")).toBeUndefined();
    expect(reader.list({ q: "WEB-01" })).toHaveLength(1);
    expect(reader.list({ status: "failed" })).toHaveLength(0);
  });

  it("재시작 후 이어서 처리하면 시도 번호를 붙여 도구 id 가 겹치지 않는다", () => {
    const run = store.start(init, new Date(2026, 9, 8, 15, 0, 0));
    run.event(codexLineToEvents(codexLines[1]!, AT)[0]!);
    run.flush();
    const reopened = store.reopen(run.id)!;
    reopened.resume();
    reopened.event(codexLineToEvents(codexLines[1]!, AT)[0]!);
    const tools = reopened.record.events.filter((e) => e.kind === "tool");
    expect(tools.map((e) => (e.kind === "tool" ? e.id : ""))).toEqual([
      "item_1",
      "2:item_1",
    ]);
    expect(reopened.record.attempts).toBe(2);
    reopened.finish("succeeded");
  });

  it("진행 중으로 남은 기록은 이어서 처리할 것만 빼고 중단으로 표시한다", () => {
    const keep = store.start(init, new Date(2026, 9, 8, 16, 0, 0));
    const stale = store.start(init, new Date(2026, 9, 8, 16, 0, 1));
    expect(store.interruptStale(new Set([keep.id]))).toBe(1);
    expect(reader.get(stale.id)?.status).toBe("interrupted");
    expect(reader.get(keep.id)?.status).toBe("running");
    expect(reader.stats(new Date(2026, 9, 8, 18)).byStatus).toMatchObject({
      succeeded: 2,
      interrupted: 1,
      running: 1,
    });
  });

  it("보관 기간이 지난 날짜 디렉터리를 지운다", () => {
    store.start(init, new Date(2026, 7, 1, 9, 0, 0));
    expect(store.prune(30, new Date(2026, 9, 8))).toBe(1);
    expect(store.prune(0, new Date(2030, 0, 1))).toBe(0);
    expect(reader.list().every((run) => run.id.startsWith("20261008"))).toBe(true);
  });
});

describe("slackPermalink", () => {
  it("스레드 답글 링크를 만든다", () => {
    expect(
      slackPermalink(
        "https://x.slack.com/",
        "C1",
        "1791453237.582449",
        "1791443475.275049"
      )
    ).toBe(
      "https://x.slack.com/archives/C1/p1791453237582449?thread_ts=1791443475.275049&cid=C1"
    );
    expect(slackPermalink("https://x.slack.com", "C1", "1.5", "1.5")).toBe(
      "https://x.slack.com/archives/C1/p15"
    );
  });
});

describe("조회 API", () => {
  const root = mkdtempSync(path.join(tmpdir(), "verda-api-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const store = new HistoryStore(root);
  const reader = new HistoryReader(root);
  const call = (pathname: string, method = "GET") =>
    handleLocalApi(reader, method, new URL(pathname, "verda://app"));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body = async (pathname: string): Promise<any> => (await call(pathname)).json();

  it("목록, 상세, 산출물, 통계를 읽기 전용으로 준다", async () => {
    const run = store.start({
      slack: {
        channel: "C1",
        channelLabel: "#ops",
        threadTs: "1.0",
        eventTs: "1.0",
        userId: "U1",
      },
      request: "그림 그려 줘",
      backend: { reasoner: "codex", sandbox: "docker" },
    });
    await run.saveArtifact("image-1.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    run.finish("failed", { error: "boom" });

    const list = await body("/api/runs?status=failed");
    expect(list.map((r: { id: string }) => r.id)).toEqual([run.id]);
    expect(await body("/api/runs?status=succeeded")).toEqual([]);
    expect((await body(`/api/runs/${run.id}`)).error).toBe("boom");

    const image = await call(`/api/runs/${run.id}/artifacts/image-1.png`);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await image.arrayBuffer())).toHaveLength(4);

    expect((await call(`/api/runs/${run.id}/artifacts/..%2Frun.json`)).status).toBe(404);
    expect((await call("/api/runs/../../etc")).status).toBe(404);
    expect((await call("/api/runs", "POST")).status).toBe(405);
    expect((await body("/api/stats")).byStatus.failed).toBe(1);
  });
});
