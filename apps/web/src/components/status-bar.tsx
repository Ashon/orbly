import { setupSettingsRoute } from "@src/settings/fields";
import { Clock, Cpu, Plug, TriangleAlert } from "lucide-react";
import type * as React from "react";
import { Tooltip } from "@/components/ui/tooltip";
import { useBotStatus } from "@/lib/api";
import { useSupervisor } from "@/lib/desktop";
import { formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import { describeBot, TONE_CLASS } from "./bot-state";

/**
 * Status bar at the bottom of the window. Holds only bot status to glance at without switching screens.
 * Left: bot (connection, reasoner backend, attached tools, startup check issues). Right: request handling.
 */
export function StatusBar({
  onOpenBot,
  onOpenSettings,
}: {
  onOpenBot: () => void;
  /** Opens Settings at a route such as #/settings/messengers */
  onOpenSettings: (route: string) => void;
}) {
  const { data } = useBotStatus();
  const supervisor = useSupervisor();
  const { tone, label } = describeBot(data, supervisor);
  const status = data?.alive ? data.status : undefined;
  const active = status?.requests.active ?? 0;
  const problems = status?.problems ?? [];
  const tools = [...(status?.mcp ?? []), ...(status?.diagrams ? ["diagrams"] : [])];

  return (
    <footer className="surface-bar flex h-7 shrink-0 items-center gap-1 overflow-hidden border-t border-sidebar-border bg-sidebar px-2 text-[11px] whitespace-nowrap text-muted-foreground">
      {/* When setup is needed, Pacey's status goes straight to Settings, where it is fixed. */}
      <Item
        tip={
          supervisor?.phase === "setup"
            ? "Open Settings to set up Pacey"
            : "Pacey's status and logs"
        }
        onClick={
          supervisor?.phase === "setup"
            ? () => onOpenSettings(setupSettingsRoute(supervisor.issues))
            : onOpenBot
        }
      >
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
        <span className={cn("font-medium", TONE_CLASS[tone].text)}>Pacey: {label}</span>
      </Item>
      {status?.reasoner && (
        <Item tip="Reasoner backend" onClick={onOpenBot}>
          <Cpu />
          {status.reasoner}
        </Item>
      )}
      {tools.length > 0 && (
        <Item tip="Tools attached to the reasoner (MCP), diagram rendering">
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
          {problems.length} {problems.length === 1 ? "check issue" : "check issues"}
        </Item>
      )}

      <div className="ml-auto flex items-center gap-1">
        {active > 0 && (
          <Item
            tip="Requests in progress now"
            onClick={onOpenBot}
            className="text-status-running"
          >
            <span className="size-1.5 animate-pulse-dot rounded-full bg-status-running" />
            {active} active
          </Item>
        )}
        {status?.requests.lastAt && (
          <Item tip={`${status.requests.handled} handled since Pacey started`}>
            <Clock />
            Last request {formatRelative(status.requests.lastAt)}
          </Item>
        )}
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
