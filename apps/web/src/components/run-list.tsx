import type { RunStatus, RunSummary } from "@history/types";
import { ImageIcon, Search, Wrench } from "lucide-react";
import { useDeferredValue, useState } from "react";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useRuns } from "@/lib/api";
import {
  formatDayGroup,
  formatDuration,
  formatHourMinute,
  formatRelative,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import { StatusDot } from "./status";

const FILTERS: { value?: RunStatus; label: string }[] = [
  { label: "전체" },
  { value: "running", label: "진행 중" },
  { value: "succeeded", label: "완료" },
  { value: "failed", label: "실패" },
  { value: "interrupted", label: "중단" },
];

/** 실행 목록을 날짜별로 묶는다. (목록은 최근 순) */
function groupByDay(runs: RunSummary[]): { day: string; runs: RunSummary[] }[] {
  const groups: { day: string; runs: RunSummary[] }[] = [];
  for (const run of runs) {
    const day = formatDayGroup(run.startedAt);
    const last = groups.at(-1);
    if (last?.day === day) last.runs.push(run);
    else groups.push({ day, runs: [run] });
  }
  return groups;
}

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
            className="h-8 rounded-lg pl-8 text-[13px]"
          />
        </div>
        {/* 상태 거르기: 한 줄 세그먼트 */}
        <div className="flex rounded-lg bg-muted p-0.5">
          {FILTERS.map((filter) => (
            <button
              key={filter.label}
              type="button"
              onClick={() => setStatus(filter.value)}
              className={cn(
                "h-6 flex-1 rounded-md text-xs font-medium transition-colors",
                status === filter.value
                  ? "bg-card text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {filter.label}
            </button>
          ))}
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-2 pb-3">
          {groupByDay(runs.data ?? []).map((group) => (
            <section key={group.day} className="mt-2 first:mt-0">
              <h3 className="px-3 pt-1.5 pb-1 text-[11px] font-medium text-muted-foreground">
                {group.day}
              </h3>
              <div className="space-y-0.5">
                {group.runs.map((run) => (
                  <RunListItem
                    key={run.id}
                    run={run}
                    today={group.day === "오늘"}
                    selected={run.id === selectedId}
                    onSelect={() => onSelect(run.id)}
                  />
                ))}
              </div>
            </section>
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

/**
 * 한 줄 요약: 상태, 요청(두 줄까지), 채널과 시각, 도구/이미지 수와 소요 시간.
 * 요청자는 상세 화면과 툴팁에 있다.
 */
function RunListItem({
  run,
  today,
  selected,
  onSelect,
}: {
  run: RunSummary;
  today: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      title={run.userName ? `@${run.userName}` : undefined}
      className={cn(
        "flex w-full gap-2.5 rounded-xl px-3 py-2.5 text-left transition-colors",
        // 선택은 띄우지 않고 면만 칠한다. (목록 안에서 한 항목만 튀지 않게)
        selected
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "hover:bg-sidebar-accent/50"
      )}
    >
      <StatusDot status={run.status} className="mt-[7px]" />
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 text-[13px] leading-snug font-medium">
          {run.request || <span className="text-muted-foreground">(빈 요청)</span>}
        </span>
        <span className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="truncate">{run.channelLabel}</span>
          <span className="shrink-0 text-muted-foreground/60">·</span>
          <span className="shrink-0 tabular-nums">
            {today ? formatRelative(run.startedAt) : formatHourMinute(run.startedAt)}
          </span>
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
