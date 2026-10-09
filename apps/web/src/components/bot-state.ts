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

/** Combines the status file (bot.json) and the desktop supervisor state into a one-line status. */
export function describeBot(
  view: BotStatusView | undefined,
  supervisor: SupervisorState | undefined
): { tone: BotTone; label: string } {
  const phase = supervisor?.phase;
  if (phase === "building") return { tone: "busy", label: "Building" };
  if (phase === "stopping") return { tone: "busy", label: "Stopping" };
  if (phase === "crashed") return { tone: "error", label: "Crashed" };
  const status = view?.alive ? view.status : undefined;
  if (!status) {
    return phase === "starting"
      ? { tone: "busy", label: "Starting" }
      : { tone: "off", label: "Stopped" };
  }
  if (status.state === "starting") return { tone: "busy", label: "Starting" };
  if (status.state === "stopping") return { tone: "busy", label: "Stopping" };
  switch (status.socket.state) {
    case "connected":
      return { tone: "ok", label: "Connected" };
    case "connecting":
    case "reconnecting":
      return { tone: "warn", label: "Reconnecting" };
    default:
      return { tone: "error", label: "Disconnected" };
  }
}
