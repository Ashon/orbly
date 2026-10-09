/**
 * Jira Cloud 조회와 이슈 생성, 댓글. broker 의 API 토큰으로 허용된 프로젝트(JIRA_PROJECTS)만 다룬다.
 * 추론 컨테이너에는 토큰이 없고 Jira 로 나갈 수도 없다.
 * 쓰기는 토큰 주인 계정으로 남으므로 생성과 댓글만 두고, 상태 변경(전환)은 두지 않는다.
 */

const KEY_PATTERN = /^([A-Z][A-Z0-9_]*)-(\d+)$/;
const MAX_WRITES_PER_HOUR = 20;
const MAX_TEXT = 20_000;

const day = (iso?: string | null) => (iso ? iso.slice(0, 10) : "-");
const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(Math.trunc(value), min), max);

function allowedProject(project: string, projects: readonly string[]): string {
  const key = project.trim().toUpperCase();
  if (!projects.includes(key)) {
    throw new Error(
      `다룰 수 없는 프로젝트입니다: ${project} (허용: ${projects.join(", ")})`
    );
  }
  return key;
}

/** 이슈 키(PROJ-123)를 검증하고 허용된 프로젝트인지 확인한다. */
export function parseIssueKey(input: string, projects: readonly string[]): string {
  const key = input
    .trim()
    .replace(/^.*\/browse\//, "")
    .replace(/[?#].*$/, "")
    .toUpperCase();
  const match = KEY_PATTERN.exec(key);
  if (!match)
    throw new Error(
      `이슈 키 형식이 아닙니다: ${input} (예: ${projects[0] ?? "PROJ"}-123)`
    );
  allowedProject(match[1]!, projects);
  return key;
}

/**
 * JQL 의 범위를 허용된 프로젝트로 고정한다. 조건은 괄호로 감싸 AND 로 묶고, ORDER BY 는 뒤로 뺀다.
 * 조건이 다른 프로젝트를 가리켜도 결과는 허용된 프로젝트 안에서만 나온다.
 * 조건이 감싼 괄호를 닫고 나가지 못하도록 괄호가 맞지 않거나 따옴표가 닫히지 않은 JQL 은 거부한다.
 * (예: "x = 1) OR (project = OTHER")
 */
export function scopeJql(jql: string, projects: readonly string[]): string {
  const text = jql.trim();
  const orderAt = findOrderBy(text);
  const where = (orderAt >= 0 ? text.slice(0, orderAt) : text).trim();
  const order = orderAt >= 0 ? text.slice(orderAt).trim() : "ORDER BY updated DESC";
  const scope = `project in (${projects.map((p) => `"${p}"`).join(", ")})`;
  return `${where ? `${scope} AND (${where})` : scope} ${order}`;
}

const ORDER_BY = /order\s+by\b/iy;

/**
 * 문자열 밖의 괄호 짝과 따옴표를 검사하고, 괄호와 문자열 밖에 있는 첫 ORDER BY 의 위치를 돌려준다.
 * 없으면 -1. 문자열 안의 괄호나 "order by" 는 세지 않는다.
 */
function findOrderBy(text: string): number {
  let depth = 0;
  let quote: string | undefined;
  let orderAt = -1;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
      if (depth < 0) throw new Error("JQL 의 괄호 짝이 맞지 않습니다.");
    } else if (orderAt < 0 && depth === 0 && !/\w/.test(text.charAt(i - 1))) {
      ORDER_BY.lastIndex = i;
      if (ORDER_BY.test(text)) orderAt = i;
    }
  }
  if (quote) throw new Error("JQL 의 따옴표가 닫히지 않았습니다.");
  if (depth !== 0) throw new Error("JQL 의 괄호 짝이 맞지 않습니다.");
  return orderAt;
}

interface AdfNode {
  type?: string;
  text?: string;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
}

/** Atlassian Document Format 을 읽기 쉬운 텍스트로 바꾼다. */
export function adfToText(doc: unknown): string {
  const walk = (node: AdfNode | undefined, prefix = ""): string => {
    if (!node || typeof node !== "object") return "";
    const children = (sep = "") =>
      (node.content ?? []).map((child) => walk(child, prefix)).join(sep);
    switch (node.type) {
      case "text":
        return node.text ?? "";
      case "hardBreak":
        return "\n";
      case "mention":
      case "emoji":
        return String(node.attrs?.text ?? node.attrs?.shortName ?? "");
      case "inlineCard":
      case "blockCard":
      case "embedCard":
        return String(node.attrs?.url ?? "");
      case "paragraph":
      case "heading":
        return `${children()}\n`;
      case "bulletList":
      case "orderedList":
        return `${(node.content ?? [])
          .map((item, i) => {
            const mark = node.type === "orderedList" ? `${i + 1}. ` : "- ";
            const body = walk(item, `${prefix}  `).trim();
            return `${prefix}${mark}${body}`;
          })
          .join("\n")}\n`;
      case "codeBlock":
        return `\`\`\`\n${children()}\n\`\`\`\n`;
      case "blockquote":
        return `${children()
          .trim()
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n")}\n`;
      case "rule":
        return "---\n";
      case "tableRow":
        return `${(node.content ?? []).map((cell) => walk(cell).trim()).join(" | ")}\n`;
      case "media":
      case "mediaSingle":
      case "mediaGroup":
        return "[첨부]\n";
      default:
        return children();
    }
  };
  return walk(doc as AdfNode)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 일반 텍스트를 ADF 로 바꾼다. 빈 줄로 문단을 나누고, 모든 줄이 - 로 시작하는 문단은 목록으로 만든다. */
export function textToAdf(text: string): AdfNode & { version: 1 } {
  const paragraphs = text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((block) => block.replace(/^\n+|\n+$/g, ""))
    .filter(Boolean);
  const inline = (line: string): AdfNode[] =>
    line ? [{ type: "text", text: line }] : [];
  const content: AdfNode[] = paragraphs.map((block) => {
    const lines = block.split("\n");
    if (lines.every((line) => /^\s*[-*] /.test(line))) {
      return {
        type: "bulletList",
        content: lines.map((line) => ({
          type: "listItem",
          content: [
            { type: "paragraph", content: inline(line.replace(/^\s*[-*] /, "")) },
          ],
        })),
      };
    }
    return {
      type: "paragraph",
      content: lines.flatMap((line, i) =>
        i === 0 ? inline(line) : [{ type: "hardBreak" }, ...inline(line)]
      ),
    };
  });
  return { type: "doc", version: 1, content };
}

interface User {
  displayName?: string;
}
interface IssueFields {
  summary?: string;
  status?: { name: string };
  issuetype?: { name: string };
  priority?: { name: string } | null;
  assignee?: User | null;
  reporter?: User | null;
  labels?: string[];
  created?: string;
  updated?: string;
  duedate?: string | null;
  project?: { key: string };
  parent?: { key: string; fields?: { summary?: string } };
  description?: unknown;
  subtasks?: Issue[];
  issuelinks?: {
    type: { inward: string; outward: string };
    inwardIssue?: Issue;
    outwardIssue?: Issue;
  }[];
  comment?: {
    total: number;
    comments: { author?: User; created: string; body: unknown }[];
  };
}
interface Issue {
  key: string;
  fields: IssueFields;
}

const name = (user?: User | null) => user?.displayName ?? "없음";

function issueLine(issue: Issue): string {
  const f = issue.fields;
  return `${issue.key} [${f.status?.name ?? "?"}] ${f.summary ?? ""}`;
}

export function formatIssue(issue: Issue, siteUrl: string, maxComments: number): string {
  const f = issue.fields;
  const lines = [
    `${issue.key} ${f.summary ?? ""}`,
    `- 유형 ${f.issuetype?.name ?? "?"}, 상태 ${f.status?.name ?? "?"}, 우선순위 ${f.priority?.name ?? "-"}`,
    `- 담당 ${name(f.assignee)}, 보고 ${name(f.reporter)}, 생성 ${day(f.created)}, 갱신 ${day(f.updated)}${f.duedate ? `, 기한 ${f.duedate}` : ""}`,
  ];
  if (f.labels?.length) lines.push(`- 라벨 ${f.labels.join(", ")}`);
  if (f.parent)
    lines.push(
      `- 상위 ${f.parent.key}${f.parent.fields?.summary ? ` ${f.parent.fields.summary}` : ""}`
    );
  lines.push(`- 링크 ${siteUrl}/browse/${issue.key}`);

  const description = adfToText(f.description);
  lines.push("", "설명:", description ? description.slice(0, 6000) : "(없음)");
  if (f.subtasks?.length) lines.push("", "하위 이슈:", ...f.subtasks.map(issueLine));
  if (f.issuelinks?.length) {
    lines.push(
      "",
      "연결:",
      ...f.issuelinks.map((link) =>
        link.outwardIssue
          ? `${link.type.outward} ${issueLine(link.outwardIssue)}`
          : `${link.type.inward} ${link.inwardIssue ? issueLine(link.inwardIssue) : "?"}`
      )
    );
  }
  const comments = f.comment?.comments ?? [];
  if (comments.length) {
    const shown = comments.slice(-maxComments);
    lines.push(
      "",
      `댓글 (최근 ${shown.length}개 / 전체 ${f.comment?.total ?? comments.length}개):`
    );
    for (const c of shown) {
      lines.push(
        `[${day(c.created)} ${name(c.author)}] ${adfToText(c.body).slice(0, 1500)}`
      );
    }
  }
  return lines.join("\n");
}

export interface JiraOptions {
  /** 사이트 주소 (https://your-site.atlassian.net) */
  baseUrl: string;
  email: string;
  token: string;
  projects: string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

export interface CreateIssueInput {
  project: string;
  issueType?: string;
  summary: string;
  description?: string;
  labels?: string[];
  parent?: string;
}

export class JiraClient {
  private readonly writeTimes: number[] = [];
  private readonly siteUrl: string;

  constructor(private readonly options: JiraOptions) {
    this.siteUrl = options.baseUrl.replace(/\/+$/, "");
  }

  get projects(): string[] {
    return this.options.projects;
  }

  async search(jql: string, limit = 20): Promise<string> {
    const scoped = scopeJql(jql, this.projects);
    const fields = "summary,status,issuetype,assignee,priority,updated";
    const data = await this.request<{ issues: Issue[]; isLast?: boolean }>(
      "GET",
      `/rest/api/3/search/jql?jql=${encodeURIComponent(scoped)}&maxResults=${clamp(limit, 1, 50)}&fields=${fields}`
    );
    if (data.issues.length === 0) return `이슈를 찾지 못했습니다. (JQL: ${scoped})`;
    return [
      `이슈 ${data.issues.length}건${data.isLast === false ? " (더 있음, 조건을 좁히세요)" : ""} (JQL: ${scoped})`,
      ...data.issues.map(
        (issue) =>
          `${issueLine(issue)} (${issue.fields.issuetype?.name ?? "?"}, 담당 ${name(issue.fields.assignee)}, 갱신 ${day(issue.fields.updated)})`
      ),
    ].join("\n");
  }

  async viewIssue(input: string, maxComments = 10): Promise<string> {
    const key = parseIssueKey(input, this.projects);
    const fields = [
      "summary",
      "status",
      "issuetype",
      "priority",
      "assignee",
      "reporter",
      "labels",
      "created",
      "updated",
      "duedate",
      "project",
      "parent",
      "description",
      "subtasks",
      "issuelinks",
      "comment",
    ].join(",");
    const issue = await this.request<Issue>(
      "GET",
      `/rest/api/3/issue/${key}?fields=${fields}`
    );
    // 다른 프로젝트로 옮겨진 이슈는 새 키로 돌아온다.
    if (issue.fields.project) allowedProject(issue.fields.project.key, this.projects);
    return formatIssue(issue, this.siteUrl, clamp(maxComments, 0, 50));
  }

  async createIssue(input: CreateIssueInput): Promise<string> {
    const project = allowedProject(input.project, this.projects);
    const summary = input.summary.trim();
    if (!summary || summary.length > 255) throw new Error("제목은 1-255자여야 합니다.");
    if ((input.description ?? "").length > MAX_TEXT)
      throw new Error(`설명은 ${MAX_TEXT}자 이하여야 합니다.`);
    const parent = input.parent ? parseIssueKey(input.parent, this.projects) : undefined;

    // 유형 이름은 프로젝트(와 언어 설정)마다 달라서 생성 가능한 유형에서 찾는다.
    const meta = await this.request<{
      issueTypes: { id: string; name: string; subtask: boolean }[];
    }>("GET", `/rest/api/3/issue/createmeta/${project}/issuetypes?maxResults=50`);
    const wanted = input.issueType?.trim().toLowerCase();
    if (!wanted && parent) {
      throw new Error(
        `상위 이슈를 지정하면 유형도 지정하세요. (가능: ${meta.issueTypes.map((t) => t.name).join(", ")})`
      );
    }
    const standard = meta.issueTypes.filter((t) => !t.subtask);
    const type = wanted
      ? meta.issueTypes.find((t) => t.name.toLowerCase() === wanted)
      : (standard.find((t) => ["task", "작업"].includes(t.name.toLowerCase())) ??
        standard[0]);
    if (!type) {
      throw new Error(
        `${project} 에서 만들 수 있는 유형이 아닙니다: ${input.issueType ?? "(기본)"} (가능: ${meta.issueTypes.map((t) => t.name).join(", ")})`
      );
    }

    this.takeWriteSlot();
    const fields: Record<string, unknown> = {
      project: { key: project },
      issuetype: { id: type.id },
      summary,
    };
    if (input.description?.trim()) fields.description = textToAdf(input.description);
    if (input.labels?.length)
      fields.labels = input.labels.map((l) => l.trim().replace(/\s+/g, "-"));
    if (parent) fields.parent = { key: parent };
    const created = await this.request<{ key: string }>("POST", "/rest/api/3/issue", {
      fields,
    });
    return `${created.key} 를 만들었습니다. (${type.name}) ${this.siteUrl}/browse/${created.key}`;
  }

  async addComment(input: string, body: string): Promise<string> {
    const key = parseIssueKey(input, this.projects);
    if (!body.trim()) throw new Error("댓글 내용이 비어 있습니다.");
    if (body.length > MAX_TEXT) throw new Error(`댓글은 ${MAX_TEXT}자 이하여야 합니다.`);
    this.takeWriteSlot();
    const comment = await this.request<{ id: string }>(
      "POST",
      `/rest/api/3/issue/${key}/comment`,
      {
        body: textToAdf(body),
      }
    );
    return `${key} 에 댓글을 남겼습니다. ${this.siteUrl}/browse/${key}?focusedCommentId=${comment.id}`;
  }

  /** 쓰기(생성, 댓글)는 시간당 횟수를 제한한다. */
  private takeWriteSlot(): void {
    const now = (this.options.now ?? Date.now)();
    while (this.writeTimes.length && now - this.writeTimes[0]! > 3_600_000)
      this.writeTimes.shift();
    if (this.writeTimes.length >= MAX_WRITES_PER_HOUR)
      throw new Error(`시간당 Jira 쓰기 한도(${MAX_WRITES_PER_HOUR}건)를 넘었습니다.`);
    this.writeTimes.push(now);
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown
  ): Promise<T> {
    const auth = Buffer.from(`${this.options.email}:${this.options.token}`).toString(
      "base64"
    );
    const res = await (this.options.fetchImpl ?? fetch)(`${this.siteUrl}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        "User-Agent": "verda-ops-broker",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 20_000),
    });
    const text = await res.text();
    if (!res.ok) {
      let message = text.slice(0, 300);
      try {
        const data = JSON.parse(text) as {
          errorMessages?: string[];
          errors?: Record<string, string>;
        };
        const parts = [
          ...(data.errorMessages ?? []),
          ...Object.entries(data.errors ?? {}).map(([field, msg]) => `${field}: ${msg}`),
        ];
        if (parts.length) message = parts.join("; ");
      } catch {
        // 본문이 JSON 이 아니면 그대로 쓴다.
      }
      if (res.status === 401)
        throw new Error(
          "Jira 인증에 실패했습니다. (OPS_JIRA_EMAIL, OPS_JIRA_TOKEN 확인)"
        );
      if (res.status === 404)
        throw new Error(`찾을 수 없거나 볼 권한이 없습니다 (404): ${path.split("?")[0]}`);
      if (res.status === 429)
        throw new Error("Jira API 요청 한도를 넘었습니다. 잠시 후 다시 시도하세요.");
      throw new Error(`Jira API 오류 ${res.status}: ${message}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }
}
