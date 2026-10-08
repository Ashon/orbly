import { Clock, Cpu, Monitor, Moon, Plug, Sun, TriangleAlert } from "lucide-react";
import type * as React from "react";
import { Tooltip } from "@/components/ui/tooltip";
import { useBotStatus } from "@/lib/api";
import { useSupervisor } from "@/lib/desktop";
import { formatRelative } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { describeBot, TONE_CLASS } from "./bot-state";

const THEME_ICON = { system: Monitor, light: Sun, dark: Moon } as const;
const THEME_LABEL = { system: "시스템 테마", light: "라이트", dark: "다크" } as const;

/**
 * 창 아래 상태 막대. 화면을 옮기지 않고 훑어볼 봇 상태만 둔다.
 * 왼쪽은 봇(연결, 추론 백엔드, 붙은 도구, 시작 점검 문제), 오른쪽은 요청 처리와 테마.
 */
export function StatusBar({ onOpenBot }: { onOpenBot: () => void }) {
  const { data } = useBotStatus();
  const supervisor = useSupervisor();
  const theme = useTheme();
  const { tone, label } = describeBot(data, supervisor);
  const status = data?.alive ? data.status : undefined;
  const active = status?.requests.active ?? 0;
  const problems = status?.problems ?? [];
  const tools = [...(status?.mcp ?? []), ...(status?.diagrams ? ["그림"] : [])];
  const ThemeIcon = THEME_ICON[theme.mode];

  return (
    <footer className="flex h-7 shrink-0 items-center gap-1 border-t border-sidebar-border bg-sidebar px-2 text-[11px] text-muted-foreground">
      <Item tip="봇 상태와 로그" onClick={onOpenBot}>
        <span className="relative flex size-2">
          {(tone === "ok" || tone === "busy") && (
            <span
              className={cn(
                "absolute inset-0 animate-ping rounded-full opacity-50",
                TONE_CLASS[tone].dot
              )}
            />
          )}
          <span className={cn("relative size-2 rounded-full", TONE_CLASS[tone].dot)} />
        </span>
        <span className={cn("font-medium", TONE_CLASS[tone].text)}>봇 {label}</span>
      </Item>
      {status?.reasoner && (
        <Item tip="추론 백엔드" onClick={onOpenBot}>
          <Cpu />
          {status.reasoner}
        </Item>
      )}
      {tools.length > 0 && (
        <Item tip="추론에 붙은 도구 (MCP), 그림 렌더링">
          <Plug />
          {tools.join(", ")}
        </Item>
      )}
      {problems.length > 0 && (
        <Item
          tip={problems.join("\n")}
          onClick={onOpenBot}
          className="text-status-interrupted"
        >
          <TriangleAlert />
          점검 문제 {problems.length}
        </Item>
      )}

      <div className="ml-auto flex items-center gap-1">
        {active > 0 && (
          <Item
            tip="지금 처리 중인 요청"
            onClick={onOpenBot}
            className="text-status-running"
          >
            <span className="size-1.5 animate-pulse-dot rounded-full bg-status-running" />
            처리 중 {active}
          </Item>
        )}
        {status?.requests.lastAt && (
          <Item tip={`이번 실행에서 ${status.requests.handled}건 처리`}>
            <Clock />
            마지막 요청 {formatRelative(status.requests.lastAt)}
          </Item>
        )}
        <Item
          tip={`테마: ${THEME_LABEL[theme.mode]} (눌러서 바꾸기)`}
          onClick={theme.next}
        >
          <ThemeIcon />
          <span className="sr-only">테마 바꾸기</span>
        </Item>
      </div>
    </footer>
  );
}

function Item({
  tip,
  onClick,
  className,
  children,
}: {
  tip: string;
  onClick?: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  const body = cn(
    "flex h-5 shrink-0 items-center gap-1.5 rounded px-1.5 whitespace-nowrap [&_svg]:size-3 [&_svg]:shrink-0",
    onClick &&
      "transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
    className
  );
  return (
    <Tooltip content={<span className="whitespace-pre-line">{tip}</span>} side="top">
      {onClick ? (
        <button type="button" onClick={onClick} className={body}>
          {children}
        </button>
      ) : (
        <span className={body}>{children}</span>
      )}
    </Tooltip>
  );
}
