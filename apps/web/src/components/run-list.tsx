import type { RunStatus, RunSummary } from "@history/types";
import { ImageIcon, Wrench } from "lucide-react";
import { useDeferredValue, useState } from "react";
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
  { label: "All" },
  { value: "running", label: "Running" },
  { value: "succeeded", label: "Succeeded" },
  { value: "failed", label: "Failed" },
  { value: "interrupted", label: "Interrupted" },
];

/** Groups runs by day. (the list is newest first) */
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

/** Run list column. The search query comes from the top bar (SearchField). */
export function RunList({
  q,
  selectedId,
  onSelect,
}: {
  q: string;
  selectedId?: string;
  onSelect: (id: string) => void;
}) {
  const [status, setStatus] = useState<RunStatus>();
  const query = useDeferredValue(q);
  const runs = useRuns({ status, q: query });

  return (
    <aside className="flex h-full w-full flex-col border-r border-sidebar-border bg-sidebar">
      {/* The filter adapts to the column, which the viewer can resize: five buttons when they fit, a select when not. */}
      <div className="@container px-3 pt-3 pb-2">
        <label className="flex h-7 items-center gap-1.5 rounded-lg bg-muted px-2.5 text-xs text-muted-foreground @min-[295px]:hidden">
          Status
          <select
            value={status ?? ""}
            onChange={(e) =>
              setStatus((e.target.value || undefined) as RunStatus | undefined)
            }
            className="min-w-0 flex-1 bg-transparent font-medium text-foreground outline-none"
          >
            {FILTERS.map((filter) => (
              <option key={filter.label} value={filter.value ?? ""}>
                {filter.label}
              </option>
            ))}
          </select>
        </label>
        {/* Status filter: one-line segmented control */}
        <div className="hidden rounded-lg bg-muted p-0.5 @min-[295px]:flex">
          {FILTERS.map((filter) => (
            <button
              key={filter.label}
              type="button"
              onClick={() => setStatus(filter.value)}
              className={cn(
                "h-6 flex-auto rounded-md px-1.5 text-xs font-medium whitespace-nowrap transition-colors",
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
                    today={group.day === "Today"}
                    selected={run.id === selectedId}
                    onSelect={() => onSelect(run.id)}
                  />
                ))}
              </div>
            </section>
          ))}
          {runs.data && runs.data.length === 0 && (
            <p className="px-3 py-10 text-center text-sm text-muted-foreground">
              {q || status
                ? "No runs match the filters."
                : "Pacey has not answered any mentions yet."}
            </p>
          )}
          {runs.isError && (
            <p className="px-3 py-10 text-center text-sm text-destructive">
              Could not load run history.
            </p>
          )}
        </div>
      </ScrollArea>
    </aside>
  );
}

/**
 * One-line summary: status, request (up to two lines), channel and time, tool/image counts and duration.
 * The requester is shown in the detail view and the tooltip.
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
        // Selection only fills the surface without lifting it. (so one item does not stand out in the list)
        selected
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "hover:bg-sidebar-accent/50"
      )}
    >
      <StatusDot status={run.status} className="mt-[7px]" />
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 text-[13px] leading-snug font-medium">
          {run.request || <span className="text-muted-foreground">(empty request)</span>}
        </span>
        <span className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="truncate">{run.conversationLabel}</span>
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
