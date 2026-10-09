/**
 * Bot runtime status. The bot writes it to <VERDA_DATA_DIR>/bot.json; the desktop app and UI read it.
 * The same file also acts as a run lock. (A second bot does not start while a live pid is recorded)
 */
export type SocketState =
  "connecting" | "connected" | "reconnecting" | "disconnecting" | "disconnected";

export interface BotStatus {
  version: 1;
  pid: number;
  startedAt: string;
  updatedAt: string;
  /** starting: loading config/checks, running: receiving events, stopping: shutting down (waiting for in-progress requests) */
  state: "starting" | "running" | "stopping";
  /** Who launched it. desktop when launched by the desktop app */
  managedBy: "desktop" | "terminal";
  socket: { state: SocketState; since: string; reconnects: number };
  bot?: { user: string; userId: string; team: string };
  reasoner?: string;
  mcp?: string[];
  diagrams?: boolean;
  history?: boolean;
  /** Problems found at startup, such as sandbox checks */
  problems: string[];
  requests: { active: number; handled: number; lastAt?: string };
  /** Config fingerprint at startup (config.ts configFingerprint). A change means a restart is needed. */
  configHash?: string;
}

/** /api/bot response. alive tells whether the pid is actually alive */
export interface BotStatusView {
  status?: BotStatus;
  alive: boolean;
}

export interface LogLine {
  at?: string;
  level?: "DEBUG" | "INFO" | "WARN" | "ERROR";
  scope?: string;
  message: string;
}

/** Bot process state managed by the desktop app (sent to the UI over IPC) */
export type BotPhase =
  "idle" | "building" | "starting" | "running" | "stopping" | "crashed" | "external";

export interface SupervisorState {
  phase: BotPhase;
  /** pid of the process this app launched, or of an external bot */
  pid?: number;
  /** Latest notice to show the user (failure cause etc.) */
  message?: string;
  /** Last output when start or build fails */
  output: string[];
  autoStart: boolean;
  /** Number of restarts after abnormal exits (last 10 minutes) */
  restarts: number;
  /** Whether it can rebuild from source (dev runs only. The packaged app uses its bundle as is) */
  canBuild: boolean;
}
