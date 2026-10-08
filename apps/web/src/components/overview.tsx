import {
  Activity,
  BarChart3,
  CircleCheck,
  FolderOpen,
  LoaderCircle,
  Timer,
  Wrench,
} from "lucide-react";
import type * as React from "react";
import { useHealth, useStats } from "@/lib/api";
import { formatDuration, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { VerdaMark } from "./logo";

/** "32.9초" -> ["32.9", "초"]. 숫자와 단위를 나눌 수 없으면 통째로 숫자 자리에 둔다. ("1분 5초") */
function splitUnit(text: string): [string, string] {
  const match = /^([\d.,]+)\s*([^\d\s]+)$/.exec(text);
  return match ? [match[1]!, match[2]!] : [text, ""];
}

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
  const daily = data?.daily ?? [];
  const maxDaily = Math.max(1, ...daily.map((d) => d.runs));
  const recentRuns = daily.reduce((sum, d) => sum + d.runs, 0);
  const recentFailed = daily.reduce((sum, d) => sum + d.failed, 0);
  const today = daily.at(-1)?.runs ?? 0;
  const maxTool = Math.max(1, ...(data?.topTools.map((t) => t.calls) ?? [1]));
  const [avgValue, avgUnit] = splitUnit(formatDuration(data?.avgDurationMs));
  const running = data?.byStatus.running ?? 0;

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
          icon={<Activity className="text-primary" />}
          label="전체 실행"
          value={data ? formatNumber(data.total) : "-"}
          unit="건"
          hint={data ? `오늘 ${formatNumber(today)}건` : undefined}
        />
        <StatCard
          icon={<CircleCheck className="text-status-succeeded" />}
          label="성공률"
          value={successRate === undefined ? "-" : String(successRate)}
          unit="%"
          hint={
            data
              ? `실패 ${data.byStatus.failed} / 중단 ${data.byStatus.interrupted}`
              : undefined
          }
        />
        <StatCard
          icon={<Timer className="text-chart-1" />}
          label="평균 소요"
          value={avgValue}
          unit={avgUnit}
          hint="요청 하나를 끝낼 때까지"
        />
        <StatCard
          icon={
            <LoaderCircle
              className={cn("text-status-running", running > 0 && "animate-spin")}
            />
          }
          label="진행 중"
          value={data ? String(running) : "-"}
          unit="건"
          hint={running > 0 ? "지금 답변을 만드는 중" : "처리 중인 요청 없음"}
          accent={running > 0}
        />

        <section className="surface-card col-span-2 flex flex-col p-5">
          <CardHeader
            icon={<BarChart3 className="text-primary" />}
            label="최근 14일"
            meta="일별 실행"
          />
          {/* 막대는 카드의 남는 높이를 채운다. (옆 도구 카드와 높이가 맞도록 도구는 5개까지) */}
          <div className="mt-4 flex min-h-36 flex-1 gap-5">
            <div className="flex shrink-0 flex-col justify-end pb-5">
              <Value value={formatNumber(recentRuns)} unit="건" />
              <p className="mt-1 text-xs text-muted-foreground">
                {recentFailed > 0 ? `실패 ${recentFailed}건` : "실패 없음"}
              </p>
            </div>
            {/* 알약 모양 막대: 바탕(well) 위에 실행 수만큼 채우고, 실패는 위쪽을 붉게 칠한다. */}
            <div className="flex min-w-0 flex-1 items-end justify-between gap-1">
              {daily.map((day) => (
                <div
                  key={day.day}
                  className="group flex h-full flex-col items-center justify-end gap-1.5"
                  title={`${day.day}: ${day.runs}건${day.failed ? `, 실패 ${day.failed}` : ""}`}
                >
                  <span className="text-[10px] text-muted-foreground tabular-nums opacity-0 transition-opacity group-hover:opacity-100">
                    {day.runs}
                  </span>
                  <div className="relative flex w-2 flex-1 flex-col justify-end overflow-hidden rounded-full bg-well">
                    {day.runs > 0 && (
                      <div
                        className="verda-gradient relative w-full rounded-full"
                        style={{
                          height: `${Math.max(12, (day.runs / maxDaily) * 100)}%`,
                        }}
                      >
                        {day.failed > 0 && (
                          <div
                            className="absolute inset-x-0 top-0 rounded-full bg-status-failed"
                            style={{ height: `${(day.failed / day.runs) * 100}%` }}
                          />
                        )}
                      </div>
                    )}
                  </div>
                  <span className="text-[10px] text-muted-foreground tabular-nums">
                    {day.day.slice(8)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="surface-card col-span-2 p-5">
          <CardHeader
            icon={<Wrench className="text-chart-1" />}
            label="많이 쓴 도구"
            meta="호출 수"
          />
          {data?.topTools.length ? (
            <ul className="mt-4 space-y-3">
              {data.topTools.slice(0, 5).map((tool) => (
                <li key={tool.name} className="text-xs">
                  <div className="mb-1.5 flex items-baseline justify-between gap-2">
                    <span className="truncate font-mono">{tool.name}</span>
                    <span className="shrink-0 font-medium tabular-nums">
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

/** 카드 머리: 색 아이콘과 제목, 오른쪽에 범위 같은 보조 글 */
function CardHeader({
  icon,
  label,
  meta,
}: {
  icon: React.ReactNode;
  label: string;
  meta?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="flex shrink-0 [&_svg]:size-4">{icon}</span>
      <h2 className="truncate text-sm font-semibold">{label}</h2>
      {meta && (
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">{meta}</span>
      )}
    </div>
  );
}

/** 큰 숫자와 옅은 단위 */
function Value({
  value,
  unit,
  accent,
}: {
  value: string;
  unit?: string;
  accent?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-baseline gap-1 tabular-nums",
        accent && "text-status-running"
      )}
    >
      <span className="text-3xl font-semibold tracking-tight">{value}</span>
      {unit && <span className="text-sm font-medium text-muted-foreground">{unit}</span>}
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  unit,
  hint,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  unit?: string;
  hint?: string;
  accent?: boolean;
}) {
  return (
    <div className="surface-card p-5">
      <CardHeader icon={icon} label={label} />
      <div className="mt-4">
        <Value value={value} unit={value === "-" ? undefined : unit} accent={accent} />
      </div>
      {hint && <p className="mt-1 truncate text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
