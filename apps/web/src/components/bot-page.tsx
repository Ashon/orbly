import type { BotStatus, LogLine, SupervisorState } from "@runtime/types";
import {
  ArrowDownToLine,
  Bot,
  Cpu,
  FolderOpen,
  Hammer,
  Inbox,
  Play,
  RotateCw,
  Search,
  Square,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useBotLogs, useBotStatus } from "@/lib/api";
import { botControl, useSupervisor } from "@/lib/desktop";
import { formatDateTime, formatDuration, formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import { describeBot, TONE_CLASS } from "./bot-state";
import { CodeBlock } from "./code-block";

const SOCKET_LABEL: Record<BotStatus["socket"]["state"], string> = {
  connecting: "연결 중",
  connected: "연결됨",
  reconnecting: "재연결 중",
  disconnecting: "닫는 중",
  disconnected: "끊김",
};

export function BotPage() {
  const { data: view } = useBotStatus();
  const supervisor = useSupervisor();
  const status = view?.alive ? view.status : undefined;
  const { tone, label } = describeBot(view, supervisor);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b px-8 pt-6 pb-5">
        <div className="mx-auto max-w-5xl">
          <div className="flex items-start gap-4">
            <span
              className={cn(
                "mt-1 grid size-10 place-items-center rounded-xl",
                TONE_CLASS[tone].bg
              )}
            >
              <Bot className={cn("size-5", TONE_CLASS[tone].text)} />
            </span>
            <div className="min-w-0 flex-1">
              <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
                Verda 봇
                <span className={cn("text-sm font-medium", TONE_CLASS[tone].text)}>
                  {label}
                </span>
              </h1>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {status
                  ? `Socket Mode ${SOCKET_LABEL[status.socket.state]} ${formatRelative(status.socket.since).replace(" 전", "")}째` +
                    `, 재연결 ${status.socket.reconnects}회`
                  : "Slack Socket Mode 로 멘션을 받아 처리하는 프로세스입니다."}
              </p>
            </div>
            <Controls supervisor={supervisor} />
          </div>
          {supervisor?.message && (
            <p
              className={cn(
                "mt-3 rounded-lg px-3 py-2 text-xs",
                supervisor.phase === "crashed" ? TONE_CLASS.error.bg : "bg-muted/60",
                supervisor.phase === "crashed"
                  ? TONE_CLASS.error.text
                  : "text-muted-foreground"
              )}
            >
              {supervisor.message}
            </p>
          )}
          <div className="mt-4 grid grid-cols-4 gap-3">
            <Info icon={<Bot />} label="봇 계정">
              {status?.bot ? `@${status.bot.user}` : "-"}
              <Sub>{status?.bot?.team}</Sub>
            </Info>
            <Info icon={<Cpu />} label="추론">
              {status?.reasoner ?? "-"}
              <Sub>
                {status
                  ? `MCP ${status.mcp?.length ? status.mcp.join(", ") : "없음"} / 그림 ${status.diagrams ? "on" : "off"}`
                  : undefined}
              </Sub>
            </Info>
            <Info icon={<Inbox />} label="요청">
              {status ? `처리 중 ${status.requests.active}건` : "-"}
              <Sub>
                {status
                  ? `이번 실행에서 ${status.requests.handled}건 처리` +
                    (status.requests.lastAt
                      ? `, 마지막 ${formatRelative(status.requests.lastAt)}`
                      : "")
                  : undefined}
              </Sub>
            </Info>
            <Info icon={<Square />} label="프로세스">
              {status
                ? `pid ${status.pid}`
                : supervisor?.pid
                  ? `pid ${supervisor.pid}`
                  : "-"}
              <Sub>
                {status
                  ? `${status.managedBy === "desktop" ? "데스크톱 앱" : "터미널"}, ${formatDuration(Date.now() - Date.parse(status.startedAt))} 동작`
                  : undefined}
              </Sub>
            </Info>
          </div>
          {status && status.problems.length > 0 && (
            <ul className="mt-3 space-y-1">
              {status.problems.map((problem) => (
                <li
                  key={problem}
                  className="flex items-start gap-1.5 text-xs text-status-interrupted"
                >
                  <TriangleAlert className="mt-px size-3.5 shrink-0" />
                  {problem}
                </li>
              ))}
            </ul>
          )}
          {supervisor &&
            supervisor.output.length > 0 &&
            (supervisor.phase === "crashed" || supervisor.phase === "building") && (
              <CodeBlock
                className="mt-3"
                label="마지막 출력"
                code={supervisor.output.slice(-40).join("\n")}
                maxHeight="max-h-48"
              />
            )}
        </div>
      </div>
      <LogPanel />
    </div>
  );
}

function Controls({ supervisor }: { supervisor: SupervisorState | undefined }) {
  const control = botControl();
  const [pending, setPending] = useState(false);
  if (!control || !supervisor) {
    return (
      <p className="shrink-0 text-right text-xs text-muted-foreground">
        봇 시작과 중지는
        <br />
        데스크톱 앱에서 할 수 있습니다.
      </p>
    );
  }
  const phase = supervisor.phase;
  const run = (action: () => Promise<void>) => {
    setPending(true);
    void action().finally(() => setPending(false));
  };
  const busy = pending || phase === "building" || phase === "stopping";
  const live = phase === "running" || phase === "starting";
  return (
    <div className="flex shrink-0 flex-col items-end gap-2">
      <div className="flex items-center gap-1.5">
        {!live && (
          <Button
            size="sm"
            disabled={busy || phase === "external"}
            onClick={() => run(() => control.start())}
          >
            <Play />
            시작
          </Button>
        )}
        {live && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => run(() => control.restart())}
          >
            <RotateCw />
            재시작
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={busy || phase === "external"}
          onClick={() => run(() => control.restart(true))}
        >
          <Hammer />
          빌드 후 재시작
        </Button>
        {live && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => run(() => control.stop())}
          >
            <Square />
            중지
          </Button>
        )}
      </div>
    </div>
  );
}

function Info({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-xl bg-card px-3.5 py-3">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground [&_svg]:size-3.5">
        {icon}
        {label}
      </div>
      <div className="mt-1 truncate text-sm font-medium">{children}</div>
    </div>
  );
}

function Sub({ children }: { children?: React.ReactNode }) {
  return children ? (
    <div className="truncate text-[11px] font-normal text-muted-foreground">
      {children}
    </div>
  ) : null;
}

type LogView = "all" | "socket" | "mention" | "problems";

const LOG_VIEWS: { value: LogView; label: string }[] = [
  { value: "all", label: "전체" },
  { value: "socket", label: "Socket Mode" },
  { value: "mention", label: "멘션 처리" },
  { value: "problems", label: "경고, 오류" },
];

const matchesView = (line: LogLine, view: LogView) => {
  const scope = line.scope ?? "";
  switch (view) {
    case "socket":
      return scope.startsWith("verda:socket") || scope.startsWith("verda:bolt");
    case "mention":
      return scope.startsWith("verda:mention") || scope.startsWith("verda:history");
    case "problems":
      return line.level === "WARN" || line.level === "ERROR";
    default:
      return true;
  }
};

const LEVEL_CLASS: Record<string, string> = {
  DEBUG: "text-muted-foreground",
  INFO: "text-status-succeeded",
  WARN: "text-status-interrupted",
  ERROR: "text-status-failed",
};

function LogPanel() {
  const [view, setView] = useState<LogView>("all");
  const [q, setQ] = useState("");
  const [follow, setFollow] = useState(true);
  const { data, isError } = useBotLogs({ lines: 1500 });
  const scroller = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => {
    const query = q.trim().toLowerCase();
    return (data ?? []).filter(
      (line) =>
        matchesView(line, view) && (!query || line.message.toLowerCase().includes(query))
    );
  }, [data, view, q]);

  useEffect(() => {
    const el = scroller.current;
    if (follow && el) el.scrollTop = el.scrollHeight;
  }, [lines, follow]);

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-8 py-2">
        <div className="mx-auto flex w-full max-w-5xl items-center gap-2">
          <span className="text-sm font-medium">로그</span>
          <div className="ml-2 flex gap-1">
            {LOG_VIEWS.map((item) => (
              <button
                key={item.value}
                type="button"
                onClick={() => setView(item.value)}
                className={cn(
                  "h-6 rounded-full px-2.5 text-xs font-medium transition-colors",
                  view === item.value
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="relative ml-auto w-56">
            <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="로그 검색"
              className="h-7 pl-7 text-xs"
            />
          </div>
          <Button
            variant={follow ? "secondary" : "ghost"}
            size="xs"
            onClick={() => setFollow((v) => !v)}
            aria-pressed={follow}
          >
            <ArrowDownToLine />
            따라가기
          </Button>
          {botControl() && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="로그 폴더 열기"
              onClick={() => void botControl()?.openLogs()}
            >
              <FolderOpen />
            </Button>
          )}
        </div>
      </div>
      <div
        ref={scroller}
        onWheel={(e) => {
          if (e.deltaY < 0) setFollow(false);
        }}
        className="min-h-0 flex-1 overflow-auto bg-muted/30 px-8 py-2 font-mono text-[11.5px] leading-[1.6]"
      >
        <div className="mx-auto max-w-5xl">
          {lines.map((line, i) => (
            <LogRow key={`${line.at}-${i}`} line={line} />
          ))}
          {lines.length === 0 && (
            <p className="py-10 text-center font-sans text-sm text-muted-foreground">
              {isError ? "로그를 읽지 못했습니다." : "표시할 로그가 없습니다."}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function LogRow({ line }: { line: LogLine }) {
  const scope = (line.scope ?? "").replace(/^verda:?/, "") || "main";
  const socket = scope.startsWith("socket") || scope.startsWith("bolt");
  return (
    <div
      className={cn(
        "flex gap-3 rounded px-1.5 hover:bg-accent/50",
        line.level === "ERROR" && "bg-status-failed/5"
      )}
    >
      <span className="shrink-0 text-muted-foreground tabular-nums">
        {line.at ? formatDateTime(line.at).slice(6) : ""}
      </span>
      <span
        className={cn("w-10 shrink-0 font-semibold", LEVEL_CLASS[line.level ?? "INFO"])}
      >
        {line.level ?? ""}
      </span>
      <span
        className={cn(
          "w-16 shrink-0 truncate",
          socket ? "text-status-running" : "text-muted-foreground"
        )}
      >
        {scope}
      </span>
      <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">
        {line.message}
      </span>
    </div>
  );
}
