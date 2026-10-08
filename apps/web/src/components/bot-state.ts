import type { BotStatusView, SupervisorState } from "@runtime/types";

export type BotTone = "ok" | "busy" | "warn" | "error" | "off";

export const TONE_CLASS: Record<BotTone, { text: string; dot: string; bg: string }> = {
  ok: {
    text: "text-status-succeeded",
    dot: "bg-status-succeeded",
    bg: "bg-status-succeeded/10 border-status-succeeded/25",
  },
  busy: {
    text: "text-status-running",
    dot: "bg-status-running",
    bg: "bg-status-running/10 border-status-running/30",
  },
  warn: {
    text: "text-status-interrupted",
    dot: "bg-status-interrupted",
    bg: "bg-status-interrupted/10 border-status-interrupted/30",
  },
  error: {
    text: "text-status-failed",
    dot: "bg-status-failed",
    bg: "bg-status-failed/10 border-status-failed/30",
  },
  off: {
    text: "text-muted-foreground",
    dot: "bg-muted-foreground/50",
    bg: "bg-muted border-border",
  },
};

/** 상태 파일(bot.json)과 데스크톱 관리 상태를 합쳐 한 줄 상태로 만든다. */
export function describeBot(
  view: BotStatusView | undefined,
  supervisor: SupervisorState | undefined
): { tone: BotTone; label: string } {
  const phase = supervisor?.phase;
  if (phase === "building") return { tone: "busy", label: "빌드 중" };
  if (phase === "stopping") return { tone: "busy", label: "종료 중" };
  if (phase === "crashed") return { tone: "error", label: "오류로 종료" };
  const status = view?.alive ? view.status : undefined;
  if (!status) {
    return phase === "starting"
      ? { tone: "busy", label: "시작 중" }
      : { tone: "off", label: "중지됨" };
  }
  if (status.state === "starting") return { tone: "busy", label: "시작 중" };
  if (status.state === "stopping") return { tone: "busy", label: "종료 중" };
  switch (status.socket.state) {
    case "connected":
      return { tone: "ok", label: "연결됨" };
    case "connecting":
    case "reconnecting":
      return { tone: "warn", label: "재연결 중" };
    default:
      return { tone: "error", label: "연결 끊김" };
  }
}
