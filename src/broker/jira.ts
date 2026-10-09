/**
 * Jira Cloud lookups, issue creation, and comments. Uses the broker's API token and handles only the allowed projects (JIRA_PROJECTS).
 * The reasoner container has no token and cannot reach Jira.
 * Writes are recorded under the token owner's account, so only creation and comments are offered, not status changes (transitions).
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
      `Project is not allowed: ${project} (allowed: ${projects.join(", ")})`
    );
  }
  return key;
}

/** Validates an issue key (PROJ-123) and checks that its project is allowed. */
export function parseIssueKey(input: string, projects: readonly string[]): string {
  const key = input
    .trim()
    .replace(/^.*\/browse\//, "")
    .replace(/[?#].*$/, "")
    .toUpperCase();
  const match = KEY_PATTERN.exec(key);
  if (!match)
    throw new Error(
      `Invalid issue key format: ${input} (e.g. ${projects[0] ?? "PROJ"}-123)`
    );
  allowedProject(match[1]!, projects);
  return key;
}

/**
 * Pins the JQL scope to the allowed projects. The condition is wrapped in parentheses and joined with AND, and ORDER BY is moved to the end.
 * Even if the condition points to another project, results come only from the allowed projects.
 * So that the condition cannot close the wrapping parentheses and escape, JQL with unbalanced parentheses or unclosed quotes is rejected.
 * (e.g. "x = 1) OR (project = OTHER")
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
 * Checks parenthesis pairing and quotes outside strings, and returns the position of the first ORDER BY outside parentheses and strings.
 * Returns -1 if there is none. Parentheses and "order by" inside strings are not counted.
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
      if (depth < 0) throw new Error("JQL has unbalanced parentheses.");
    } else if (orderAt < 0 && depth === 0 && !/\w/.test(text.charAt(i - 1))) {
      ORDER_BY.lastIndex = i;
      if (ORDER_BY.test(text)) orderAt = i;
    }
  }
  if (quote) throw new Error("JQL has an unclosed quote.");
  if (depth !== 0) throw new Error("JQL has unbalanced parentheses.");
  return orderAt;
}

interface AdfNode {
  type?: string;
  text?: string;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
}

/** Converts Atlassian Document Format to readable text. */
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
        return "[attachment]\n";
      default:
        return children();
    }
  };
  return walk(doc as AdfNode)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Converts plain text to ADF. Blank lines separate paragraphs, and a paragraph whose lines all start with - becomes a list. */
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

const name = (user?: User | null) => user?.displayName ?? "none";

function issueLine(issue: Issue): string {
  const f = issue.fields;
  return `${issue.key} [${f.status?.name ?? "?"}] ${f.summary ?? ""}`;
}

export function formatIssue(issue: Issue, siteUrl: string, maxComments: number): string {
  const f = issue.fields;
  const lines = [
    `${issue.key} ${f.summary ?? ""}`,
    `- type ${f.issuetype?.name ?? "?"}, status ${f.status?.name ?? "?"}, priority ${f.priority?.name ?? "-"}`,
    `- assignee ${name(f.assignee)}, reporter ${name(f.reporter)}, created ${day(f.created)}, updated ${day(f.updated)}${f.duedate ? `, due ${f.duedate}` : ""}`,
  ];
  if (f.labels?.length) lines.push(`- labels ${f.labels.join(", ")}`);
  if (f.parent)
    lines.push(
      `- parent ${f.parent.key}${f.parent.fields?.summary ? ` ${f.parent.fields.summary}` : ""}`
    );
  lines.push(`- link ${siteUrl}/browse/${issue.key}`);

  const description = adfToText(f.description);
  lines.push("", "Description:", description ? description.slice(0, 6000) : "(none)");
  if (f.subtasks?.length) lines.push("", "Subtasks:", ...f.subtasks.map(issueLine));
  if (f.issuelinks?.length) {
    lines.push(
      "",
      "Linked issues:",
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
      `Comments (latest ${shown.length} of ${f.comment?.total ?? comments.length}):`
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
  /** Site URL (https://your-site.atlassian.net) */
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
    if (data.issues.length === 0) return `No issues found. (JQL: ${scoped})`;
    return [
      `${data.issues.length} ${data.issues.length === 1 ? "issue" : "issues"}${data.isLast === false ? " (more available, narrow the query)" : ""} (JQL: ${scoped})`,
      ...data.issues.map(
        (issue) =>
          `${issueLine(issue)} (${issue.fields.issuetype?.name ?? "?"}, assignee ${name(issue.fields.assignee)}, updated ${day(issue.fields.updated)})`
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
    // An issue moved to another project comes back with its new key.
    if (issue.fields.project) allowedProject(issue.fields.project.key, this.projects);
    return formatIssue(issue, this.siteUrl, clamp(maxComments, 0, 50));
  }

  async createIssue(input: CreateIssueInput): Promise<string> {
    const project = allowedProject(input.project, this.projects);
    const summary = input.summary.trim();
    if (!summary || summary.length > 255)
      throw new Error("Summary must be 1-255 characters.");
    if ((input.description ?? "").length > MAX_TEXT)
      throw new Error(`Description must be at most ${MAX_TEXT} characters.`);
    const parent = input.parent ? parseIssueKey(input.parent, this.projects) : undefined;

    // Issue type names differ per project (and language setting), so look them up among the creatable types.
    const meta = await this.request<{
      issueTypes: { id: string; name: string; subtask: boolean }[];
    }>("GET", `/rest/api/3/issue/createmeta/${project}/issuetypes?maxResults=50`);
    const wanted = input.issueType?.trim().toLowerCase();
    if (!wanted && parent) {
      throw new Error(
        `When a parent issue is given, also specify the issue type (available: ${meta.issueTypes.map((t) => t.name).join(", ")}).`
      );
    }
    const standard = meta.issueTypes.filter((t) => !t.subtask);
    const type = wanted
      ? meta.issueTypes.find((t) => t.name.toLowerCase() === wanted)
      : (standard.find((t) => ["task", "작업"].includes(t.name.toLowerCase())) ??
        standard[0]);
    if (!type) {
      throw new Error(
        `Issue type cannot be created in ${project}: ${input.issueType ?? "(default)"} (available: ${meta.issueTypes.map((t) => t.name).join(", ")})`
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
    return `Created ${created.key} (${type.name}). ${this.siteUrl}/browse/${created.key}`;
  }

  async addComment(input: string, body: string): Promise<string> {
    const key = parseIssueKey(input, this.projects);
    if (!body.trim()) throw new Error("Comment body is empty.");
    if (body.length > MAX_TEXT)
      throw new Error(`Comment must be at most ${MAX_TEXT} characters.`);
    this.takeWriteSlot();
    const comment = await this.request<{ id: string }>(
      "POST",
      `/rest/api/3/issue/${key}/comment`,
      {
        body: textToAdf(body),
      }
    );
    return `Added a comment to ${key}. ${this.siteUrl}/browse/${key}?focusedCommentId=${comment.id}`;
  }

  /** Limits the number of writes (creation, comments) per hour. */
  private takeWriteSlot(): void {
    const now = (this.options.now ?? Date.now)();
    while (this.writeTimes.length && now - this.writeTimes[0]! > 3_600_000)
      this.writeTimes.shift();
    if (this.writeTimes.length >= MAX_WRITES_PER_HOUR)
      throw new Error(`Hourly Jira write limit (${MAX_WRITES_PER_HOUR}) exceeded.`);
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
        // Uses the body as is when it is not JSON.
      }
      if (res.status === 401)
        throw new Error(
          "Jira authentication failed (check OPS_JIRA_EMAIL and OPS_JIRA_TOKEN)."
        );
      if (res.status === 404)
        throw new Error(
          `Not found or no permission to view (404): ${path.split("?")[0]}`
        );
      if (res.status === 429)
        throw new Error("Jira API rate limit exceeded. Try again shortly.");
      throw new Error(`Jira API error ${res.status}: ${message}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }
}
