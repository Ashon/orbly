import { Activity, CircleCheck, FolderOpen, LoaderCircle, Timer } from "lucide-react";
import type * as React from "react";
import { useHealth, useStats } from "@/lib/api";
import { formatDuration, formatNumber } from "@/lib/format";
import { VerdaMark } from "./logo";

export function Overview() {
  const stats = useStats();
  const health = useHealth();
  const data = stats.data;
  const finished = data
    ? data.byStatus.succeeded + data.byStatus.failed + data.byStatus.interrupted
    : 0;
  const successRate =
    data && finished > 0
      ? Math.round((data.byStatus.succeeded / finished) * 100)
      : undefined;
  const maxDaily = Math.max(1, ...(data?.daily.map((d) => d.runs) ?? [1]));
  const maxTool = Math.max(1, ...(data?.topTools.map((t) => t.calls) ?? [1]));

  return (
    // 4열 격자 하나에 모든 카드를 놓는다. 가로, 세로 간격은 같은 gap-4, 아래 줄은 2열씩 차지해 위 카드 경계와 맞춘다.
    <div className="mx-auto max-w-4xl px-8 py-8">
      <div className="mb-6 flex items-center gap-3">
        <VerdaMark className="size-10" />
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            <span className="verda-gradient-text">Verda</span> 작업 기록
          </h1>
          <p className="text-sm text-muted-foreground">
            Slack 멘션을 받아 처리한 요청과 도구 호출, 답변, 산출물을 봅니다.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-4">
        <StatCard
          icon={<Activity />}
          label="전체 실행"
          value={data ? formatNumber(data.total) : "-"}
        />
        <StatCard
          icon={<CircleCheck />}
          label="성공률"
          value={successRate === undefined ? "-" : `${successRate}%`}
          hint={
            data
              ? `실패 ${data.byStatus.failed} / 중단 ${data.byStatus.interrupted}`
              : undefined
          }
        />
        <StatCard
          icon={<Timer />}
          label="평균 소요"
          value={formatDuration(data?.avgDurationMs)}
        />
        <StatCard
          icon={
            <LoaderCircle
              className={data?.byStatus.running ? "animate-spin" : undefined}
            />
          }
          label="진행 중"
          value={data ? String(data.byStatus.running) : "-"}
          accent={Boolean(data?.byStatus.running)}
        />

        <section className="col-span-2 flex flex-col rounded-xl bg-card p-4">
          <h2 className="mb-3 text-sm font-medium">최근 14일</h2>
          {/* 옆 카드와 높이가 같아지도록 남는 높이를 막대가 쓴다. */}
          <div className="flex min-h-36 flex-1 items-end gap-1.5">
            {data?.daily.map((day) => (
              <div
                key={day.day}
                className="group flex h-full flex-1 flex-col items-center justify-end gap-1"
              >
                <span className="text-[10px] text-muted-foreground tabular-nums opacity-0 transition-opacity group-hover:opacity-100">
                  {day.runs}
                </span>
                <div
                  className="relative w-full overflow-hidden rounded-t-md bg-well"
                  style={{ height: `${Math.max(4, (day.runs / maxDaily) * 100)}%` }}
                  title={`${day.day}: ${day.runs}건${day.failed ? `, 실패 ${day.failed}` : ""}`}
                >
                  {day.runs > 0 && (
                    <div className="verda-gradient absolute inset-0 opacity-90" />
                  )}
                  {day.failed > 0 && (
                    <div
                      className="absolute inset-x-0 top-0 bg-status-failed/80"
                      style={{ height: `${(day.failed / day.runs) * 100}%` }}
                    />
                  )}
                </div>
                <span className="text-[10px] text-muted-foreground tabular-nums">
                  {day.day.slice(8)}
                </span>
              </div>
            ))}
          </div>
        </section>
        <section className="col-span-2 rounded-xl bg-card p-4">
          <h2 className="mb-3 text-sm font-medium">많이 쓴 도구</h2>
          {data?.topTools.length ? (
            <ul className="space-y-2">
              {data.topTools.slice(0, 7).map((tool) => (
                <li key={tool.name} className="text-xs">
                  <div className="mb-1 flex justify-between gap-2">
                    <span className="truncate font-mono">{tool.name}</span>
                    <span className="text-muted-foreground tabular-nums">
                      {tool.calls}
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-well">
                    <div
                      className="verda-gradient h-full rounded-full"
                      style={{ width: `${(tool.calls / maxTool) * 100}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-6 text-center text-xs text-muted-foreground">
              도구 호출 기록이 없습니다.
            </p>
          )}
        </section>
      </div>

      {health.data && (
        <p className="mt-4 flex items-start gap-1.5 text-xs text-muted-foreground">
          <FolderOpen className="mt-px size-3.5 shrink-0" />
          <span className="shrink-0">기록 위치</span>
          <span className="min-w-0 font-mono break-all">{health.data.root}</span>
        </p>
      )}
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  hint,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-xl bg-card p-4">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground [&_svg]:size-3.5">
        {icon}
        {label}
      </div>
      <div
        className={`mt-2 text-2xl font-semibold tabular-nums ${accent ? "text-status-running" : ""}`}
      >
        {value}
      </div>
      {hint && <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}
