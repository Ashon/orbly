/**
 * 봇 실행 상태. 봇이 <VERDA_DATA_DIR>/bot.json 에 쓰고, 데스크톱 앱과 화면이 읽는다.
 * 같은 파일이 실행 잠금 역할도 한다. (살아 있는 pid 가 있으면 두 번째 봇은 뜨지 않는다)
 */
export type SocketState =
  "connecting" | "connected" | "reconnecting" | "disconnecting" | "disconnected";

export interface BotStatus {
  version: 1;
  pid: number;
  startedAt: string;
  updatedAt: string;
  /** starting: 설정/점검 중, running: 이벤트 수신 중, stopping: 종료 중 (처리 중 요청을 기다림) */
  state: "starting" | "running" | "stopping";
  /** 누가 띄웠는지. 데스크톱 앱이 띄우면 desktop */
  managedBy: "desktop" | "terminal";
  socket: { state: SocketState; since: string; reconnects: number };
  bot?: { user: string; userId: string; team: string };
  reasoner?: string;
  mcp?: string[];
  diagrams?: boolean;
  history?: boolean;
  /** 샌드박스 점검 등 시작 시 발견한 문제 */
  problems: string[];
  requests: { active: number; handled: number; lastAt?: string };
  /** 시작할 때의 설정 지문 (config.ts configFingerprint). 바뀌면 재시작이 필요하다. */
  configHash?: string;
}

/** /api/bot 응답. alive 는 pid 가 실제로 살아 있는지 */
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

/** 데스크톱 앱이 관리하는 봇 프로세스 상태 (IPC 로 화면에 전달) */
export type BotPhase =
  "idle" | "building" | "starting" | "running" | "stopping" | "crashed" | "external";

export interface SupervisorState {
  phase: BotPhase;
  /** 이 앱이 띄운 프로세스의 pid, 또는 외부 봇의 pid */
  pid?: number;
  /** 사용자에게 보여 줄 최근 안내 (실패 원인 등) */
  message?: string;
  /** 시작/빌드 실패 시 마지막 출력 */
  output: string[];
  autoStart: boolean;
  /** 비정상 종료 후 다시 띄운 횟수 (최근 10분) */
  restarts: number;
}
