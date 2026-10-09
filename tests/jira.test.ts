import { describe, expect, it } from "vitest";
import {
  adfToText,
  JiraClient,
  parseIssueKey,
  scopeJql,
  textToAdf,
} from "../src/broker/jira.js";

const PROJECTS = ["PROJ", "OPS"];

describe("Jira scope restriction", () => {
  it("pins JQL to the allowed projects and keeps ORDER BY at the end", () => {
    expect(scopeJql("assignee = currentUser() ORDER BY created DESC", PROJECTS)).toBe(
      'project in ("PROJ", "OPS") AND (assignee = currentUser()) ORDER BY created DESC'
    );
    expect(scopeJql("  ", PROJECTS)).toBe(
      'project in ("PROJ", "OPS") ORDER BY updated DESC'
    );
    // Even when it points to another project, the AND keeps it within the allowed scope.
    expect(scopeJql("project = OTHER OR text ~ x", PROJECTS)).toBe(
      'project in ("PROJ", "OPS") AND (project = OTHER OR text ~ x) ORDER BY updated DESC'
    );
  });

  it("rejects JQL that closes the wrapping parentheses to escape", () => {
    for (const jql of [
      "x = 1) OR (project = OTHER",
      "x = 1 ORDER BY created) OR (project = OTHER",
      ") OR project = OTHER OR (x = 1",
      "x = 1 OR (project = OTHER",
    ]) {
      expect(() => scopeJql(jql, PROJECTS), jql).toThrow(/parentheses/);
    }
    expect(() => scopeJql('summary ~ "x) OR (project = OTHER', PROJECTS)).toThrow(
      /unclosed quote/
    );
  });

  it("ignores parentheses and order by inside strings", () => {
    expect(scopeJql('summary ~ "a) order by (b" ORDER BY created', PROJECTS)).toBe(
      'project in ("PROJ", "OPS") AND (summary ~ "a) order by (b") ORDER BY created'
    );
    expect(scopeJql("summary ~ 'it\\'s (x)' AND status = Done", PROJECTS)).toBe(
      `project in ("PROJ", "OPS") AND (summary ~ 'it\\'s (x)' AND status = Done) ORDER BY updated DESC`
    );
    expect(scopeJql("reorder = 1 ORDER BY rank", PROJECTS)).toBe(
      'project in ("PROJ", "OPS") AND (reorder = 1) ORDER BY rank'
    );
  });

  it("parses issue keys and URLs and rejects disallowed projects", () => {
    expect(parseIssueKey("proj-12", PROJECTS)).toBe("PROJ-12");
    expect(
      parseIssueKey("https://x.atlassian.net/browse/OPS-7?focusedCommentId=1", PROJECTS)
    ).toBe("OPS-7");
    expect(() => parseIssueKey("OTHER-1", PROJECTS)).toThrow(/Project is not allowed/);
    expect(() => parseIssueKey("PROJ-1; DROP", PROJECTS)).toThrow(
      /Invalid issue key format/
    );
  });
});

describe("ADF conversion", () => {
  it("converts ADF to text", () => {
    const doc = {
      type: "doc",
      version: 1,
      content: [
        { type: "heading", content: [{ type: "text", text: "Background" }] },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Owner " },
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
      "Background\nOwner @alice\nhttps://example.com/pr/1\n- a\n- b\n```\nkubectl get pods\n```"
    );
    expect(adfToText(undefined)).toBe("");
  });

  it("converts text to ADF with paragraphs and lists", () => {
    expect(textToAdf("first line\nsecond line\n\n- a\n- b")).toEqual({
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "first line" },
            { type: "hardBreak" },
            { type: "text", text: "second line" },
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
              summary: "Deploy failed",
              status: { name: "In Progress" },
              issuetype: { name: "Task" },
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

  it("searches with scoped JQL and uses the token only for Basic auth", async () => {
    const text = await client.search("text ~ deploy", 5);
    expect(text.split("\n")).toEqual([
      '1 issue (more available, narrow the query) (JQL: project in ("PROJ", "OPS") AND (text ~ deploy) ORDER BY updated DESC)',
      "PROJ-1 [In Progress] Deploy failed (Task, assignee Alice, updated 2026-10-08)",
    ]);
    const call = calls.at(-1)!;
    expect(decodeURIComponent(call.path)).toContain(
      'jql=project in ("PROJ", "OPS") AND (text ~ deploy) ORDER BY updated DESC'
    );
    expect(call.path).toContain("maxResults=5");
    expect(call.auth).toBe(
      `Basic ${Buffer.from("me@example.com:ATATTtest").toString("base64")}`
    );
  });

  it("defaults to the localized Task type and sends the description as ADF", async () => {
    const text = await client.createIssue({
      project: "proj",
      summary: " Investigate deploy failure ",
      description: "Check logs",
      labels: ["ops alert"],
    });
    expect(text).toBe("Created PROJ-2 (작업). https://jira.example.com/browse/PROJ-2");
    expect(calls.at(-1)).toMatchObject({
      method: "POST",
      path: "/rest/api/3/issue",
      body: {
        fields: {
          project: { key: "PROJ" },
          issuetype: { id: "2" },
          summary: "Investigate deploy failure",
          labels: ["ops-alert"],
          description: { type: "doc", version: 1 },
        },
      },
    });
  });

  it("rejects unknown types, disallowed projects, and child issues without a type before writing", async () => {
    const before = calls.filter((c) => c.method === "POST").length;
    await expect(
      client.createIssue({ project: "PROJ", summary: "x", issueType: "Story" })
    ).rejects.toThrow(/available: 에픽, 작업, 하위 작업/);
    await expect(client.createIssue({ project: "OTHER", summary: "x" })).rejects.toThrow(
      /Project is not allowed/
    );
    await expect(
      client.createIssue({ project: "PROJ", summary: "x", parent: "PROJ-1" })
    ).rejects.toThrow(/also specify the issue type/);
    expect(calls.filter((c) => c.method === "POST").length).toBe(before);
  });

  it("adds comments and limits writes to 20 per hour", async () => {
    expect(await client.addComment("PROJ-1", "Confirmed")).toBe(
      "Added a comment to PROJ-1. https://jira.example.com/browse/PROJ-1?focusedCommentId=100"
    );
    // One creation and one comment were written above.
    for (let i = 0; i < 18; i += 1) await client.addComment("PROJ-1", `n${i}`);
    await expect(client.addComment("PROJ-1", "over")).rejects.toThrow(
      /Hourly Jira write limit/
    );
    now += 3_600_001;
    await expect(client.addComment("PROJ-1", "again")).resolves.toContain("PROJ-1");
  });

  it("returns Jira errors as readable messages", async () => {
    await expect(client.viewIssue("PROJ-9")).rejects.toThrow(
      /Not found or no permission to view/
    );
  });
});
