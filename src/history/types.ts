/**
 * Verda 실행 기록 형식. 봇이 쓰고 데스크톱 앱이 읽는다. (apps/web 에서 타입만 가져다 쓴다)
 * 저장 위치: <VERDA_DATA_DIR>/runs/<YYYY-MM-DD>/<run id>/run.json, 산출물은 같은 디렉터리의 artifacts/
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
  /** 모델에 넘긴 이미지는 artifacts/ 에 복사해 둔다. */
  file?: string;
}

export interface RunOutput {
  kind: "generated" | "diagram";
  /** artifacts/ 아래 파일 이름 */
  file: string;
  title: string;
  /** 그림이면 원문 (mermaid, dot 등) */
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

/** 목록 화면용 요약 */
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
  /** 요청, 채널, 사용자, 답변에서 찾을 문자열 */
  q?: string;
  limit?: number;
}

export interface RunStats {
  total: number;
  byStatus: Record<RunStatus, number>;
  /** 최근 14일, 날짜별 실행 수 (오래된 날 -> 최근) */
  daily: { day: string; runs: number; failed: number }[];
  /** 성공한 실행의 평균 소요 시간 */
  avgDurationMs?: number;
  /** 많이 쓴 도구 상위 10개 */
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
