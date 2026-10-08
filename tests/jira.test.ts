import { describe, expect, it } from "vitest";
import {
  adfToText,
  JiraClient,
  parseIssueKey,
  scopeJql,
  textToAdf,
} from "../src/broker/jira.js";

const PROJECTS = ["PROJ", "OPS"];

describe("Jira 범위 제한", () => {
  it("JQL 을 허용 프로젝트로 고정하고 ORDER BY 는 뒤에 둔다", () => {
    expect(scopeJql("assignee = currentUser() ORDER BY created DESC", PROJECTS)).toBe(
      'project in ("PROJ", "OPS") AND (assignee = currentUser()) ORDER BY created DESC'
    );
    expect(scopeJql("  ", PROJECTS)).toBe(
      'project in ("PROJ", "OPS") ORDER BY updated DESC'
    );
    // 다른 프로젝트를 가리켜도 AND 로 묶여 허용 범위를 벗어나지 못한다.
    expect(scopeJql("project = OTHER OR text ~ x", PROJECTS)).toBe(
      'project in ("PROJ", "OPS") AND (project = OTHER OR text ~ x) ORDER BY updated DESC'
    );
  });

  it("이슈 키와 URL 을 읽고 허용되지 않은 프로젝트는 거부한다", () => {
    expect(parseIssueKey("proj-12", PROJECTS)).toBe("PROJ-12");
    expect(
      parseIssueKey("https://x.atlassian.net/browse/OPS-7?focusedCommentId=1", PROJECTS)
    ).toBe("OPS-7");
    expect(() => parseIssueKey("OTHER-1", PROJECTS)).toThrow(/다룰 수 없는 프로젝트/);
    expect(() => parseIssueKey("PROJ-1; DROP", PROJECTS)).toThrow(/이슈 키 형식/);
  });
});

describe("ADF 변환", () => {
  it("ADF 를 텍스트로 바꾼다", () => {
    const doc = {
      type: "doc",
      version: 1,
      content: [
        { type: "heading", content: [{ type: "text", text: "배경" }] },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "담당 " },
            { type: "mention", attrs: { text: "@alice" } },
            { type: "hardBreak" },
            { type: "inlineCard", attrs: { url: "https://example.com/pr/1" } },
          ],
        },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }],
            },
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "b" }] }],
            },
          ],
        },
        { type: "codeBlock", content: [{ type: "text", text: "kubectl get pods" }] },
      ],
    };
    expect(adfToText(doc)).toBe(
      "배경\n담당 @alice\nhttps://example.com/pr/1\n- a\n- b\n```\nkubectl get pods\n```"
    );
    expect(adfToText(undefined)).toBe("");
  });

  it("텍스트를 문단과 목록이 있는 ADF 로 바꾼다", () => {
    expect(textToAdf("첫 줄\n둘째 줄\n\n- a\n- b")).toEqual({
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "첫 줄" },
            { type: "hardBreak" },
            { type: "text", text: "둘째 줄" },
          ],
        },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }],
            },
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "b" }] }],
            },
          ],
        },
      ],
    });
  });
});

describe("JiraClient", () => {
  const calls: { method: string; path: string; body?: unknown; auth?: string }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace("https://jira.example.com", "");
    const headers = init?.headers as Record<string, string>;
    calls.push({
      method: init?.method ?? "GET",
      path,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: headers.Authorization,
    });
    if (path.startsWith("/rest/api/3/search/jql")) {
      return Response.json({
        issues: [
          {
            key: "PROJ-1",
            fields: {
              summary: "배포 실패",
              status: { name: "진행 중" },
              issuetype: { name: "작업" },
              assignee: { displayName: "Alice" },
              updated: "2026-10-08T10:00:00.000+0900",
            },
          },
        ],
        isLast: false,
      });
    }
    if (path.startsWith("/rest/api/3/issue/createmeta/PROJ/issuetypes")) {
      return Response.json({
        issueTypes: [
          { id: "1", name: "에픽", subtask: false },
          { id: "2", name: "작업", subtask: false },
          { id: "3", name: "하위 작업", subtask: true },
        ],
      });
    }
    if (path === "/rest/api/3/issue" && init?.method === "POST")
      return Response.json({ key: "PROJ-2" }, { status: 201 });
    if (path === "/rest/api/3/issue/PROJ-1/comment")
      return Response.json({ id: "100" }, { status: 201 });
    if (path.startsWith("/rest/api/3/issue/PROJ-9"))
      return Response.json({ errorMessages: ["Issue does not exist"] }, { status: 404 });
    return new Response("{}", { status: 500 });
  }) as typeof fetch;

  let now = 0;
  const client = new JiraClient({
    baseUrl: "https://jira.example.com/",
    email: "me@example.com",
    token: "ATATTtest",
    projects: PROJECTS,
    fetchImpl,
    now: () => now,
  });

  it("검색은 범위를 고정한 JQL 로 하고 토큰은 Basic 인증으로만 쓴다", async () => {
    const text = await client.search("text ~ 배포", 5);
    expect(text.split("\n")).toEqual([
      '이슈 1건 (더 있음, 조건을 좁히세요) (JQL: project in ("PROJ", "OPS") AND (text ~ 배포) ORDER BY updated DESC)',
      "PROJ-1 [진행 중] 배포 실패 (작업, 담당 Alice, 갱신 2026-10-08)",
    ]);
    const call = calls.at(-1)!;
    expect(decodeURIComponent(call.path)).toContain(
      'jql=project in ("PROJ", "OPS") AND (text ~ 배포) ORDER BY updated DESC'
    );
    expect(call.path).toContain("maxResults=5");
    expect(call.auth).toBe(
      `Basic ${Buffer.from("me@example.com:ATATTtest").toString("base64")}`
    );
  });

  it("유형을 생략하면 작업으로 만들고, 설명은 ADF 로 보낸다", async () => {
    const text = await client.createIssue({
      project: "proj",
      summary: " 배포 실패 조사 ",
      description: "로그 확인",
      labels: ["ops alert"],
    });
    expect(text).toBe(
      "PROJ-2 를 만들었습니다. (작업) https://jira.example.com/browse/PROJ-2"
    );
    expect(calls.at(-1)).toMatchObject({
      method: "POST",
      path: "/rest/api/3/issue",
      body: {
        fields: {
          project: { key: "PROJ" },
          issuetype: { id: "2" },
          summary: "배포 실패 조사",
          labels: ["ops-alert"],
          description: { type: "doc", version: 1 },
        },
      },
    });
  });

  it("없는 유형, 허용되지 않은 프로젝트, 유형 없는 하위 이슈는 쓰기 전에 거부한다", async () => {
    const before = calls.filter((c) => c.method === "POST").length;
    await expect(
      client.createIssue({ project: "PROJ", summary: "x", issueType: "Story" })
    ).rejects.toThrow(/가능: 에픽, 작업, 하위 작업/);
    await expect(client.createIssue({ project: "OTHER", summary: "x" })).rejects.toThrow(
      /다룰 수 없는 프로젝트/
    );
    await expect(
      client.createIssue({ project: "PROJ", summary: "x", parent: "PROJ-1" })
    ).rejects.toThrow(/유형도 지정/);
    expect(calls.filter((c) => c.method === "POST").length).toBe(before);
  });

  it("댓글을 남기고, 쓰기는 시간당 20건으로 제한한다", async () => {
    expect(await client.addComment("PROJ-1", "확인했습니다")).toBe(
      "PROJ-1 에 댓글을 남겼습니다. https://jira.example.com/browse/PROJ-1?focusedCommentId=100"
    );
    // 앞에서 생성 1건, 댓글 1건을 썼다.
    for (let i = 0; i < 18; i += 1) await client.addComment("PROJ-1", `n${i}`);
    await expect(client.addComment("PROJ-1", "over")).rejects.toThrow(
      /시간당 Jira 쓰기 한도/
    );
    now += 3_600_001;
    await expect(client.addComment("PROJ-1", "다시")).resolves.toContain("PROJ-1");
  });

  it("오류는 Jira 메시지를 읽기 쉽게 돌려준다", async () => {
    await expect(client.viewIssue("PROJ-9")).rejects.toThrow(
      /찾을 수 없거나 볼 권한이 없습니다/
    );
  });
});
