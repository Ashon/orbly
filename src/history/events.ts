import type { RunEvent, StepStatus } from "./types.js";

/** 도구 결과, 명령 출력은 이 길이까지만 기록한다. */
const MAX_OUTPUT_CHARS = 8_000;

const clip = (text: string) =>
  text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n... (${text.length}자 중 일부)`
    : text;

const stepStatus = (status: unknown): StepStatus =>
  status === "completed" ? "completed" : status === "failed" ? "failed" : "running";

const contentText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && "text" in part
        ? String((part as { text: unknown }).text)
        : ""
    )
    .filter(Boolean)
    .join("\n");
};

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: { content?: unknown } | null;
  error?: { message?: string } | string | null;
  status?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  query?: string;
  message?: string;
}

/** codex exec --json 한 줄을 실행 기록 단계로 바꾼다. 관심 없는 줄은 빈 배열. */
export function codexLineToEvents(
  line: string,
  at = new Date().toISOString()
): RunEvent[] {
  let event: {
    type?: string;
    item?: CodexItem;
    usage?: Record<string, number>;
    message?: string;
    error?: { message?: string };
  };
  try {
    event = JSON.parse(line);
  } catch {
    return [];
  }
  if (event.type === "turn.completed" && event.usage) {
    return [
      {
        kind: "usage",
        at,
        inputTokens: event.usage.input_tokens,
        cachedInputTokens: event.usage.cached_input_tokens,
        outputTokens: event.usage.output_tokens,
      },
    ];
  }
  if (event.type === "error" && event.message)
    return [{ kind: "error", at, message: event.message }];
  if (event.type === "turn.failed") {
    return [{ kind: "error", at, message: event.error?.message ?? "codex turn failed" }];
  }
  const item = event.item;
  if (!item || (event.type !== "item.started" && event.type !== "item.completed"))
    return [];
  const done = event.type === "item.completed";
  switch (item.type) {
    case "agent_message":
      return done && item.text ? [{ kind: "message", at, text: item.text.trim() }] : [];
    case "reasoning":
      return done && item.text ? [{ kind: "reasoning", at, text: item.text.trim() }] : [];
    case "mcp_tool_call": {
      const error =
        typeof item.error === "string" ? item.error : (item.error?.message ?? undefined);
      return [
        {
          kind: "tool",
          id: item.id ?? `${item.server}.${item.tool}`,
          at,
          server: item.server ?? "?",
          tool: item.tool ?? "?",
          arguments: item.arguments,
          status: error ? "failed" : stepStatus(item.status),
          result: item.result ? clip(contentText(item.result.content)) : undefined,
          error: error || undefined,
          finishedAt: done ? at : undefined,
        },
      ];
    }
    case "command_execution":
      return [
        {
          kind: "command",
          id: item.id ?? item.command ?? "command",
          at,
          command: item.command ?? "",
          status: stepStatus(item.status),
          output: item.aggregated_output ? clip(item.aggregated_output) : undefined,
          exitCode: item.exit_code,
          finishedAt: done ? at : undefined,
        },
      ];
    case "web_search":
      return done
        ? [
            {
              kind: "tool",
              id: item.id ?? "web_search",
              at,
              server: "web",
              tool: "search",
              arguments: { query: item.query },
              status: "completed",
              finishedAt: at,
            },
          ]
        : [];
    case "error":
      return [{ kind: "error", at, message: item.message ?? "codex error" }];
    default:
      return [];
  }
}

/** 단계 목록에서 마지막 메시지(최종 답변)를 꺼낸다. */
export function lastMessage(events: RunEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.kind === "message") return event.text;
  }
  return undefined;
}

/** mcp__ops__host_check -> { server: ops, tool: host_check }, Read -> { server: claude, tool: Read } */
export function splitToolName(name: string): { server: string; tool: string } {
  const match = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  return match
    ? { server: match[1]!, tool: match[2]! }
    : { server: "claude", tool: name };
}

interface ClaudeBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

/** claude -p --output-format stream-json 한 줄을 실행 기록 단계로 바꾼다. */
export function claudeLineToEvents(
  line: string,
  at = new Date().toISOString()
): RunEvent[] {
  let event: {
    type?: string;
    message?: { content?: ClaudeBlock[] };
    usage?: Record<string, number>;
    total_cost_usd?: number;
  };
  try {
    event = JSON.parse(line);
  } catch {
    return [];
  }
  if (event.type === "result") {
    return [
      {
        kind: "usage",
        at,
        inputTokens: event.usage?.input_tokens,
        cachedInputTokens: event.usage?.cache_read_input_tokens,
        outputTokens: event.usage?.output_tokens,
        costUsd: event.total_cost_usd,
      },
    ];
  }
  const blocks = event.message?.content ?? [];
  const events: RunEvent[] = [];
  for (const block of blocks) {
    if (event.type === "assistant" && block.type === "text" && block.text?.trim()) {
      events.push({ kind: "message", at, text: block.text.trim() });
    } else if (
      event.type === "assistant" &&
      block.type === "thinking" &&
      block.thinking?.trim()
    ) {
      events.push({ kind: "reasoning", at, text: block.thinking.trim() });
    } else if (
      event.type === "assistant" &&
      block.type === "tool_use" &&
      block.id &&
      block.name
    ) {
      events.push({
        kind: "tool",
        id: block.id,
        at,
        ...splitToolName(block.name),
        arguments: block.input,
        status: "running",
      });
    } else if (
      event.type === "user" &&
      block.type === "tool_result" &&
      block.tool_use_id
    ) {
      const text = clip(contentText(block.content));
      events.push({
        kind: "tool",
        id: block.tool_use_id,
        at,
        server: "",
        tool: "",
        status: block.is_error ? "failed" : "completed",
        result: block.is_error ? undefined : text,
        error: block.is_error ? text : undefined,
        finishedAt: at,
      });
    }
  }
  return events;
}
