/** Slack 메시지 text 필드 하나에 안전하게 담을 수 있는 길이. (hard limit 40k, 가독성 기준) */
export const SLACK_CHUNK_LIMIT = 3500;

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

/** 줄 경계를 우선으로 긴 텍스트를 여러 메시지로 나눈다. */
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
 * Slack 이 제어 표기(<!channel>, <@U...>, <#C...>, <!subteam^...>)로 읽지 않도록 & 와 < 를 엔티티로 바꾼다.
 * > 는 인용 표시로 쓰이고 < 없이는 제어 표기가 되지 않아 그대로 둔다.
 */
export function escapeSlackText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

/** 모델이 Slack 형식으로 쓴 웹 링크 (<https://...>, <https://...|이름>) */
const SLACK_LINK = /<(https?:\/\/[^\s<>|]+)(?:\|([^<>\n]*))?>/g;

/** 웹 링크 표기만 남기고 나머지 제어 표기는 글자 그대로 보이게 한다. */
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
 * LLM 이 흔히 내놓는 GitHub Markdown 을 Slack mrkdwn 으로 옮긴다.
 * 모델 답은 공개 채널에 그대로 올라가므로 웹 링크 외의 제어 표기(멘션, @channel 알림)는 무력화한다.
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

/** 텍스트 안의 사용자 멘션 ID 목록. */
export function extractUserIds(text: string): string[] {
  return [
    ...new Set([...text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]!)),
  ];
}

/** Slack 원문 표기를 사람이 읽는 평문으로 바꾼다. (LLM 입력용) */
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
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: timezone,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ms));
}
