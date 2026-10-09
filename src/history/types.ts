/**
 * Orbly run history format. The bot writes it and the desktop app reads it. (apps/web imports only the types)
 * Location: <ORBLY_DATA_DIR>/runs/<YYYY-MM-DD>/<run id>/run.json, outputs in artifacts/ in the same directory
 */
export const RUN_RECORD_VERSION = 1;

export type RunStatus = "running" | "succeeded" | "failed" | "interrupted";

export type StepStatus = "running" | "completed" | "failed";

export type RunEvent =
  | { kind: "message"; at: string; text: string }
  | { kind: "reasoning"; at: string; text: string }
  | {
      kind: "tool";
      id: string;
      at: string;
      server: string;
      tool: string;
      arguments?: unknown;
      status: StepStatus;
      result?: string;
      error?: string;
      finishedAt?: string;
    }
  | {
      kind: "command";
      id: string;
      at: string;
      command: string;
      status: StepStatus;
      output?: string;
      exitCode?: number | null;
      finishedAt?: string;
    }
  | {
      kind: "usage";
      at: string;
      inputTokens?: number;
      cachedInputTokens?: number;
      outputTokens?: number;
      costUsd?: number;
    }
  | { kind: "note"; at: string; text: string }
  | { kind: "error"; at: string; message: string };

export interface RunAttachment {
  name: string;
  source: string;
  kind: "image" | "text" | "pdf" | "other";
  status: "read" | "skipped" | "failed";
  reason?: string;
  /** Images passed to the model are copied to artifacts/. */
  file?: string;
}

export interface RunOutput {
  kind: "generated" | "diagram";
  /** File name under artifacts/ */
  file: string;
  title: string;
  /** Source text for diagrams (mermaid, dot, etc.) */
  source?: string;
}

export interface RunRecord {
  version: number;
  id: string;
  status: RunStatus;
  attempts: number;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  durationMs?: number;
  slack: {
    channel: string;
    channelLabel: string;
    threadTs: string;
    eventTs: string;
    placeholderTs?: string;
    permalink?: string;
    userId: string;
    userName?: string;
  };
  request: string;
  backend: { reasoner: string; sandbox: string; model?: string };
  context: { messages: number };
  attachments: RunAttachment[];
  prompt?: { system: string; user: string };
  events: RunEvent[];
  answer?: string;
  outputs: RunOutput[];
  error?: string;
}

/** Summary for the list screen */
export interface RunSummary {
  id: string;
  status: RunStatus;
  startedAt: string;
  durationMs?: number;
  channelLabel: string;
  userName?: string;
  request: string;
  reasoner: string;
  toolCalls: number;
  outputs: number;
  attempts: number;
}

export interface RunQuery {
  status?: RunStatus;
  /** Text to search for in the request, channel, user, and answer */
  q?: string;
  limit?: number;
}

export interface RunStats {
  total: number;
  byStatus: Record<RunStatus, number>;
  /** Runs per day over the last 14 days (oldest -> newest) */
  daily: { day: string; runs: number; failed: number }[];
  /** Average duration of succeeded runs */
  avgDurationMs?: number;
  /** Top 10 most used tools */
  topTools: { name: string; calls: number }[];
}

export function summarize(run: RunRecord): RunSummary {
  return {
    id: run.id,
    status: run.status,
    startedAt: run.startedAt,
    durationMs: run.durationMs,
    channelLabel: run.slack.channelLabel,
    userName: run.slack.userName,
    request: run.request.length > 200 ? `${run.request.slice(0, 197)}...` : run.request,
    reasoner: `${run.backend.reasoner}@${run.backend.sandbox}`,
    toolCalls: run.events.filter((e) => e.kind === "tool" || e.kind === "command").length,
    outputs: run.outputs.length,
    attempts: run.attempts,
  };
}
