import { setupSettingsRoute } from '@src/settings/fields'
import {
  Activity,
  BarChart3,
  CircleCheck,
  LoaderCircle,
  Settings,
  Timer,
  Wrench,
} from 'lucide-react'
import type * as React from 'react'
import { Button } from '@/components/ui/button'
import { useStats } from '@/lib/api'
import { useSupervisor } from '@/lib/desktop'
import { formatDuration, formatNumber } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * The first thing to do when the bot cannot start yet, usually connecting Slack
 * on a first run. It names what is missing and leads to Settings, where the
 * tokens are entered and checked.
 */
function SetupCard({
  message,
  issues,
}: {
  message?: string
  issues?: { key?: string }[]
}) {
  return (
    <div className="mt-6 flex items-center gap-4 rounded-2xl bg-card-accent px-5 py-4">
      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-semibold">Set up Pace</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {message ?? 'Some settings are missing before Pace can start.'}
        </p>
      </div>
      <Button
        size="sm"
        onClick={() => (window.location.hash = setupSettingsRoute(issues))}
      >
        <Settings />
        Open Settings
      </Button>
    </div>
  )
}

/**
 * "32.9s" -> ["32.9", "s"]. If the number and unit cannot be split, the whole
 * text goes in the number slot. ("1m 5s")
 */
function splitUnit(text: string): [string, string] {
  const match = /^([\d.,]+)\s*([^\d\s]+)$/.exec(text)
  return match ? [match[1]!, match[2]!] : [text, '']
}

export function Overview() {
  const stats = useStats()
  const supervisor = useSupervisor()
  const data = stats.data
  const finished = data
    ? data.byStatus.succeeded + data.byStatus.failed + data.byStatus.interrupted
    : 0
  const successRate =
    data && finished > 0
      ? Math.round((data.byStatus.succeeded / finished) * 100)
      : undefined
  const daily = data?.daily ?? []
  const maxDaily = Math.max(1, ...daily.map((d) => d.runs))
  const recentRuns = daily.reduce((sum, d) => sum + d.runs, 0)
  const recentFailed = daily.reduce((sum, d) => sum + d.failed, 0)
  const today = daily.at(-1)?.runs ?? 0
  const maxTool = Math.max(1, ...(data?.topTools.map((t) => t.calls) ?? [1]))
  const [avgValue, avgUnit] = splitUnit(formatDuration(data?.avgDurationMs))
  const running = data?.byStatus.running ?? 0

  return (
    // One surface, no cards: the figures share a row split by hairlines, and
    // the chart and the tools sit side by side under a divider. The row wraps
    // to two columns when the surface is narrow.
    <div className="@container mx-auto max-w-4xl px-10 py-9">
      {/* A page title like the other screens'; the brand is the sidebar's. */}
      <header>
        <h1 className="text-lg font-semibold tracking-tight">Overview</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          How Pace has answered your Slack mentions: how many, how well, and
          with which tools.
        </p>
      </header>

      {supervisor?.phase === 'setup' && (
        <SetupCard message={supervisor.message} issues={supervisor.issues} />
      )}

      <section
        aria-label="Totals"
        className="mt-9 grid grid-cols-2 gap-y-8 @min-[46rem]:grid-cols-4"
      >
        <Metric
          icon={<Activity className="text-primary" />}
          label="Total runs"
          value={data ? formatNumber(data.total) : '-'}
          unit={data?.total === 1 ? 'run' : 'runs'}
          hint={data ? `${formatNumber(today)} today` : undefined}
        />
        <Metric
          icon={<CircleCheck className="text-status-succeeded" />}
          label="Success rate"
          value={successRate === undefined ? '-' : String(successRate)}
          unit="%"
          hint={
            data
              ? `${data.byStatus.failed} failed / ${data.byStatus.interrupted} interrupted`
              : undefined
          }
        />
        <Metric
          icon={<Timer className="text-chart-1" />}
          label="Average duration"
          value={avgValue}
          unit={avgUnit}
          hint="Time to finish one request"
        />
        <Metric
          icon={
            <LoaderCircle
              className={cn(
                'text-status-running',
                running > 0 && 'animate-spin'
              )}
            />
          }
          label="Running"
          value={data ? String(running) : '-'}
          unit={running === 1 ? 'run' : 'runs'}
          hint={running > 0 ? 'Generating replies now' : 'No active requests'}
          accent={running > 0}
        />
      </section>

      <div className="mt-10 grid gap-10 border-t border-border pt-9 @min-[46rem]:grid-cols-2">
        <section className="flex flex-col">
          <CardHeader
            icon={<BarChart3 className="text-primary" />}
            label="Last 14 days"
            meta="Runs per day"
          />
          <div className="mt-5 flex min-h-40 flex-1 gap-5">
            <div className="flex shrink-0 flex-col justify-end pb-5">
              <Value
                value={formatNumber(recentRuns)}
                unit={recentRuns === 1 ? 'run' : 'runs'}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {recentFailed > 0 ? `${recentFailed} failed` : 'No failures'}
              </p>
            </div>
            {/* Pill-shaped bars: filled over the background (well) by run
                count, with failures painted red at the top. The columns
                share the width, so the chart never grows past its section;
                when they get too narrow for every date, every other date
                (counting back from today) is hidden. */}
            <div className="@container/bars flex min-w-0 flex-1 items-end gap-1">
              {daily.map((day, index) => (
                <div
                  key={day.day}
                  className="group flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1.5"
                  title={`${day.day}: ${day.runs} ${day.runs === 1 ? 'run' : 'runs'}${day.failed ? `, ${day.failed} failed` : ''}`}
                >
                  <span className="text-[10px] text-muted-foreground tabular-nums opacity-0 transition-opacity group-hover:opacity-100">
                    {day.runs}
                  </span>
                  <div className="relative flex w-2 flex-1 flex-col justify-end overflow-hidden rounded-full bg-well">
                    {day.runs > 0 && (
                      <div
                        className="pacenote-gradient relative w-full rounded-full"
                        style={{
                          height: `${Math.max(12, (day.runs / maxDaily) * 100)}%`,
                        }}
                      >
                        {day.failed > 0 && (
                          <div
                            className="absolute inset-x-0 top-0 rounded-full bg-status-failed"
                            style={{
                              height: `${(day.failed / day.runs) * 100}%`,
                            }}
                          />
                        )}
                      </div>
                    )}
                  </div>
                  <span
                    className={cn(
                      'text-[10px] text-muted-foreground tabular-nums',
                      (daily.length - 1 - index) % 2 === 1 &&
                        '@max-[16rem]/bars:invisible'
                    )}
                  >
                    {day.day.slice(8)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section>
          <CardHeader
            icon={<Wrench className="text-chart-1" />}
            label="Top tools"
            meta="Calls"
          />
          {data?.topTools.length ? (
            <ul className="mt-5 space-y-3">
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
                      className="pacenote-gradient h-full rounded-full"
                      style={{ width: `${(tool.calls / maxTool) * 100}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-8 text-sm text-muted-foreground">
              No tool calls recorded.
            </p>
          )}
        </section>
      </div>
    </div>
  )
}

/**
 * Section header: colored icon and title, with secondary text such as the range
 * on the right
 */
function CardHeader({
  icon,
  label,
  meta,
}: {
  icon: React.ReactNode
  label: string
  meta?: string
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="flex shrink-0 [&_svg]:size-4">{icon}</span>
      <h2 className="truncate text-sm font-semibold">{label}</h2>
      {meta && (
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
          {meta}
        </span>
      )}
    </div>
  )
}

/** Large number with a faint unit */
function Value({
  value,
  unit,
  accent,
}: {
  value: string
  unit?: string
  accent?: boolean
}) {
  return (
    <div
      className={cn(
        'flex items-baseline gap-1 tabular-nums',
        accent && 'text-status-running'
      )}
    >
      <span className="text-3xl font-semibold tracking-tight">{value}</span>
      {unit && (
        <span className="text-sm font-medium text-muted-foreground">
          {unit}
        </span>
      )}
    </div>
  )
}

/**
 * One figure in the totals row. Figures after the first are set off by a
 * hairline on their left, so the row reads as one band.
 */
function Metric({
  icon,
  label,
  value,
  unit,
  hint,
  accent,
}: {
  icon: React.ReactNode
  label: string
  value: string
  unit?: string
  hint?: string
  accent?: boolean
}) {
  return (
    <div className="min-w-0 px-6 first:pl-0 [&:not(:first-child)]:border-l [&:not(:first-child)]:border-border @max-[46rem]:[&:nth-child(3)]:border-l-0 @max-[46rem]:[&:nth-child(3)]:pl-0">
      <CardHeader icon={icon} label={label} />
      <div className="mt-3">
        <Value
          value={value}
          unit={value === '-' ? undefined : unit}
          accent={accent}
        />
      </div>
      {hint && (
        <p className="mt-1 truncate text-xs text-muted-foreground">{hint}</p>
      )}
    </div>
  )
}
