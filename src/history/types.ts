import type { MessengerId } from "../messengers/ids.js";

/**
 * Orbly run history format. The bot writes it and the desktop app reads it. (apps/web imports only the types)
 * Location: <ORBLY_DATA_DIR>/runs/<YYYY-MM-DD>/<run id>/run.json, outputs in artifacts/ in the same directory
 * Version 2 records where a request came from as origin; version 1 (Slack only) had a slack field, which
 * normalizeRunRecord turns into origin when reading.
 */
export const RUN_RECORD_VERSION = 2;

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

/** Where a request came from, and where the answer went */
export interface RunOrigin {
  messenger: MessengerId;
  /** The conversation (Slack channel ID) and its label ("#ops") */
  conversation: string;
  conversationLabel: string;
  thread: string;
  /** The mention's message ID */
  message: string;
  /** The bot's answer message, which first said it was working */
  placeholder?: string;
  permalink?: string;
  userId: string;
  userName?: string;
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
  origin: RunOrigin;
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
  messenger: MessengerId;
  conversationLabel: string;
  userName?: string;
  request: string;
  reasoner: string;
  toolCalls: number;
  outputs: number;
  attempts: number;
}

export interface RunQuery {
  status?: RunStatus;
  /** Text to search for in the request, conversation, user, and answer */
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
    messenger: run.origin.messenger,
    conversationLabel: run.origin.conversationLabel,
    userName: run.origin.userName,
    request: run.request.length > 200 ? `${run.request.slice(0, 197)}...` : run.request,
    reasoner: `${run.backend.reasoner}@${run.backend.sandbox}`,
    toolCalls: run.events.filter((e) => e.kind === "tool" || e.kind === "command").length,
    outputs: run.outputs.length,
    attempts: run.attempts,
  };
}

/** A version 1 record's Slack fields */
interface SlackOrigin {
  channel: string;
  channelLabel: string;
  threadTs: string;
  eventTs: string;
  placeholderTs?: string;
  permalink?: string;
  userId: string;
  userName?: string;
}

/** A run.json as read from disk, in the current shape whatever version wrote it */
export function normalizeRunRecord(
  raw: RunRecord | (Omit<RunRecord, "origin"> & { slack: SlackOrigin })
): RunRecord {
  if (!("slack" in raw) || "origin" in raw) return raw as RunRecord;
  const { slack, ...rest } = raw;
  return {
    ...rest,
    origin: {
      messenger: "slack",
      conversation: slack.channel,
      conversationLabel: slack.channelLabel,
      thread: slack.threadTs,
      message: slack.eventTs,
      placeholder: slack.placeholderTs,
      permalink: slack.permalink,
      userId: slack.userId,
      userName: slack.userName,
    },
  };
}
