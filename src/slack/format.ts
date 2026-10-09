/** Length that fits safely in one Slack message text field. (hard limit 40k; chosen for readability) */
export const SLACK_CHUNK_LIMIT = 3500;

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

/** Splits long text into multiple messages, preferring line boundaries. */
export function chunkText(text: string, limit = SLACK_CHUNK_LIMIT): string[] {
  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (current.trim()) chunks.push(current.trimEnd());
    current = "";
  };
  for (const line of text.split("\n")) {
    if (line.length > limit) {
      flush();
      for (let i = 0; i < line.length; i += limit) chunks.push(line.slice(i, i + limit));
      continue;
    }
    if (current.length + line.length + 1 > limit) flush();
    current += `${line}\n`;
  }
  flush();
  return chunks.length > 0 ? chunks : [""];
}

/**
 * Escapes & and < as entities so Slack does not read them as control markup (<!channel>, <@U...>, <#C...>, <!subteam^...>).
 * > is left as is because it marks quotes and cannot form control markup without <.
 */
export function escapeSlackText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

/** Web links the model wrote in Slack format (<https://...>, <https://...|name>) */
const SLACK_LINK = /<(https?:\/\/[^\s<>|]+)(?:\|([^<>\n]*))?>/g;

/** Keeps web link markup and shows all other control markup as literal text. */
function escapeExceptLinks(line: string): string {
  let out = "";
  let last = 0;
  for (const match of line.matchAll(SLACK_LINK)) {
    const [whole, url = "", label] = match;
    out += escapeSlackText(line.slice(last, match.index));
    out += `<${escapeSlackText(url)}${label === undefined ? "" : `|${escapeSlackText(label)}`}>`;
    last = match.index + whole.length;
  }
  return out + escapeSlackText(line.slice(last));
}

/**
 * Converts the GitHub Markdown that LLMs commonly produce into Slack mrkdwn.
 * Model answers are posted to public channels as is, so control markup other than web links (mentions, @channel alerts) is neutralized.
 */
export function toSlackMrkdwn(markdown: string): string {
  let inCode = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (line.trim().startsWith("```")) {
        inCode = !inCode;
        return escapeSlackText(line);
      }
      if (inCode) return escapeSlackText(line);
      return escapeExceptLinks(line)
        .replace(/^(\s*)[*+] /, "$1- ")
        .replace(/^#{1,6}\s+(.+?)\s*#*$/, "*$1*")
        .replace(/\*\*(.+?)\*\*/g, "*$1*")
        .replace(/__(.+?)__/g, "*$1*")
        .replace(/~~(.+?)~~/g, "~$1~")
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s|<>]+)\)/g, "<$2|$1>");
    })
    .join("\n");
}

/** User mention IDs in the text. */
export function extractUserIds(text: string): string[] {
  return [
    ...new Set([...text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]!)),
  ];
}

/** Converts Slack markup into human-readable plain text. (for LLM input) */
export function renderSlackText(text: string, userNames: Map<string, string>): string {
  return text
    .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id: string, label?: string) => {
      return `@${userNames.get(id) ?? label ?? id}`;
    })
    .replace(/<#([CG][A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id: string, name?: string) => {
      return `#${name || id}`;
    })
    .replace(
      /<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g,
      (_, name?: string) => name ?? "@team"
    )
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1")
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:\/\/[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function formatTime(ms: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ms));
}
