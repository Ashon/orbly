import type { RunStatus, RunSummary } from "@history/types";
import { ImageIcon, Search, Wrench } from "lucide-react";
import { useDeferredValue, useState } from "react";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useRuns } from "@/lib/api";
import { formatDuration, formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import { StatusDot } from "./status";

const FILTERS: { value?: RunStatus; label: string }[] = [
  { label: "전체" },
  { value: "running", label: "진행 중" },
  { value: "succeeded", label: "완료" },
  { value: "failed", label: "실패" },
  { value: "interrupted", label: "중단" },
];

export function RunList({
  selectedId,
  onSelect,
}: {
  selectedId?: string;
  onSelect: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<RunStatus>();
  const query = useDeferredValue(q);
  const runs = useRuns({ status, q: query });

  return (
    <aside className="flex h-full w-[340px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar">
      <div className="space-y-2.5 px-3 pt-3 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="요청, 채널, 답변 검색"
            className="h-8 pl-8 text-[13px]"
          />
        </div>
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((filter) => (
            <button
              key={filter.label}
              type="button"
              onClick={() => setStatus(filter.value)}
              className={cn(
                "h-6 rounded-full px-2.5 text-xs font-medium transition-colors",
                status === filter.value
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              )}
            >
              {filter.label}
            </button>
          ))}
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-0.5 px-2 pb-3">
          {runs.data?.map((run) => (
            <RunListItem
              key={run.id}
              run={run}
              selected={run.id === selectedId}
              onSelect={() => onSelect(run.id)}
            />
          ))}
          {runs.data && runs.data.length === 0 && (
            <p className="px-3 py-10 text-center text-sm text-muted-foreground">
              {q || status ? "조건에 맞는 기록이 없습니다." : "아직 기록이 없습니다."}
            </p>
          )}
          {runs.isError && (
            <p className="px-3 py-10 text-center text-sm text-destructive">
              기록을 읽지 못했습니다.
            </p>
          )}
        </div>
      </ScrollArea>
    </aside>
  );
}

function RunListItem({
  run,
  selected,
  onSelect,
}: {
  run: RunSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "group flex w-full gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
        selected
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "hover:bg-sidebar-accent/60"
      )}
    >
      <StatusDot status={run.status} className="mt-1.5" />
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 text-[13px] leading-snug font-medium">
          {run.request || <span className="text-muted-foreground">(빈 요청)</span>}
        </span>
        <span className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="truncate">
            {run.channelLabel}
            {run.userName ? ` / @${run.userName}` : ""}
          </span>
          <span className="shrink-0">{formatRelative(run.startedAt)}</span>
          <span className="ml-auto flex shrink-0 items-center gap-2 tabular-nums">
            {run.toolCalls > 0 && (
              <span className="flex items-center gap-0.5">
                <Wrench className="size-3" />
                {run.toolCalls}
              </span>
            )}
            {run.outputs > 0 && (
              <span className="flex items-center gap-0.5">
                <ImageIcon className="size-3" />
                {run.outputs}
              </span>
            )}
            {run.status !== "running" && <span>{formatDuration(run.durationMs)}</span>}
          </span>
        </span>
      </span>
    </button>
  );
}
