import type { RunRecord } from '@history/types'
import { MESSENGER_NAMES } from '@src/messengers/ids'
import {
  Coins,
  Cpu,
  ExternalLink,
  FileText,
  ImageIcon,
  Paperclip,
  Timer,
  Wrench,
} from 'lucide-react'
import type * as React from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { artifactUrl, useRun } from '@/lib/api'
import { formatDateTime, formatDuration, formatNumber } from '@/lib/format'
import { CodeBlock } from './code-block'
import { StatusBadge } from './status'
import { Timeline } from './timeline'

export function RunDetail({ id }: { id: string }) {
  const { data: run, isError } = useRun(id)
  if (isError) {
    return (
      <p className="p-10 text-center text-sm text-muted-foreground">
        Run not found.
      </p>
    )
  }
  if (!run) return null
  return (
    <Tabs defaultValue="timeline" className="flex h-full min-h-0 flex-col">
      <RunHeader run={run} />
      <ScrollArea className="min-h-0 flex-1">
        <div className="@container mx-auto max-w-3xl px-8 py-6">
          <RunFacts run={run} />
          <TabsContent value="timeline" className="select-text">
            <Timeline run={run} />
          </TabsContent>
          <TabsContent value="attachments" className="select-text">
            <Attachments run={run} />
          </TabsContent>
          <TabsContent value="prompt" className="space-y-3 select-text">
            {run.prompt ? (
              <>
                <CodeBlock
                  label="Instructions (system)"
                  code={run.prompt.system}
                  maxHeight="max-h-96"
                />
                <CodeBlock
                  label="Input (thread context, request, attachments)"
                  code={run.prompt.user}
                  maxHeight="max-h-[60vh]"
                />
              </>
            ) : (
              <Empty>This run ended before the prompt was built.</Empty>
            )}
          </TabsContent>
          <TabsContent value="raw" className="select-text">
            <CodeBlock
              code={JSON.stringify(run, null, 2)}
              maxHeight="max-h-[70vh]"
            />
          </TabsContent>
        </div>
      </ScrollArea>
    </Tabs>
  )
}

function usageOf(run: RunRecord) {
  return run.events.reduce(
    (sum, e) =>
      e.kind === 'usage'
        ? {
            input: sum.input + (e.inputTokens ?? 0),
            output: sum.output + (e.outputTokens ?? 0),
            cost: sum.cost + (e.costUsd ?? 0),
          }
        : sum,
    { input: 0, output: 0, cost: 0 }
  )
}

/**
 * The header holds only status, request, and tabs. Run figures are in the
 * summary card above the body (RunFacts).
 */
function RunHeader({ run }: { run: RunRecord }) {
  return (
    <header className="border-b bg-card/90 px-8 pt-6 pb-0 backdrop-blur">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <StatusBadge status={run.status} />
          {run.attempts > 1 && (
            <Badge variant="secondary">{run.attempts} attempts</Badge>
          )}
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate">{run.origin.conversationLabel}</span>
            <span className="text-muted-foreground/60">·</span>
            <span className="truncate">
              @{run.origin.userName ?? run.origin.userId}
            </span>
            <span className="text-muted-foreground/60">·</span>
            <span className="shrink-0 tabular-nums">
              {formatDateTime(run.startedAt)}
            </span>
          </span>
          {run.origin.permalink && (
            <Button
              asChild
              variant="outline"
              size="xs"
              className="ml-auto shrink-0"
            >
              <a href={run.origin.permalink} target="_blank" rel="noreferrer">
                <ExternalLink />
                View in {MESSENGER_NAMES[run.origin.messenger]}
              </a>
            </Button>
          )}
        </div>
        <h1 className="mt-2.5 line-clamp-2 text-lg leading-snug font-semibold tracking-tight select-text">
          {run.request || '(empty request)'}
        </h1>
        <TabsList className="mt-4 mb-3">
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="attachments">
            Attachments
            {run.attachments.length > 0 && (
              <span className="rounded bg-muted px-1 text-[10px] tabular-nums">
                {run.attachments.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="prompt">Prompt</TabsTrigger>
          <TabsTrigger value="raw">JSON</TabsTrigger>
        </TabsList>
      </div>
    </header>
  )
}

/**
 * Run summary: duration, tools, tokens, reasoner backend. Same look as the
 * Overview totals: one row of figures split by hairlines
 */
function RunFacts({ run }: { run: RunRecord }) {
  const usage = usageOf(run)
  const tools = run.events.filter(
    (e) => e.kind === 'tool' || e.kind === 'command'
  ).length
  const duration = run.durationMs ?? Date.now() - Date.parse(run.startedAt)
  return (
    // Two columns when the detail is narrow
    <div className="mb-8 grid grid-cols-2 gap-y-4 border-b border-border pb-6 @min-[40rem]:grid-cols-4">
      <Fact
        icon={<Timer />}
        label={run.status === 'running' ? 'Elapsed' : 'Duration'}
        value={formatDuration(duration)}
      />
      <Fact
        icon={<Wrench />}
        label="Tool calls"
        value={`${tools} ${tools === 1 ? 'call' : 'calls'}`}
      />
      <Fact
        icon={<Coins />}
        label="Tokens (input / output)"
        value={
          usage.input + usage.output > 0
            ? `${formatNumber(usage.input)} / ${formatNumber(usage.output)}`
            : '-'
        }
        hint={usage.cost > 0 ? `$${usage.cost.toFixed(3)}` : undefined}
      />
      <Fact
        icon={<Cpu />}
        label="Reasoner"
        value={`${run.backend.reasoner}@${run.backend.sandbox}`}
        hint={run.backend.model}
      />
    </div>
  )
}

function Fact({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode
  label: string
  value: string
  hint?: string
}) {
  return (
    <div className="min-w-0 px-4 first:pl-0 [&:not(:first-child)]:border-l [&:not(:first-child)]:border-border @max-[40rem]:[&:nth-child(3)]:border-l-0 @max-[40rem]:[&:nth-child(3)]:pl-0">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground [&_svg]:size-3.5 [&_svg]:shrink-0">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-1 truncate text-sm font-semibold tabular-nums">
        {value}
      </div>
      {hint && (
        <div className="truncate text-[11px] text-muted-foreground">{hint}</div>
      )}
    </div>
  )
}

const ATTACHMENT_STATUS = {
  read: { label: 'Read', className: 'text-status-succeeded' },
  skipped: { label: 'Skipped', className: 'text-status-interrupted' },
  failed: { label: 'Failed', className: 'text-status-failed' },
} as const

function Attachments({ run }: { run: RunRecord }) {
  if (run.attachments.length === 0)
    return <Empty>This request has no attachments.</Empty>
  return (
    <ul className="space-y-2">
      {run.attachments.map((item, i) => {
        const status = ATTACHMENT_STATUS[item.status]
        const Icon =
          item.kind === 'image'
            ? ImageIcon
            : item.kind === 'other'
              ? Paperclip
              : FileText
        return (
          <li key={`${item.name}-${i}`} className="surface-card flex gap-3 p-3">
            {item.file ? (
              <img
                src={artifactUrl(run.id, item.file)}
                alt={item.name}
                className="size-20 shrink-0 rounded-lg bg-white object-cover"
              />
            ) : (
              <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-well">
                <Icon className="size-4 text-muted-foreground" />
              </span>
            )}
            <div className="min-w-0 flex-1 text-sm">
              <div className="flex items-center gap-2">
                <span className="truncate font-medium">{item.name}</span>
                <span className={`text-xs ${status.className}`}>
                  {status.label}
                </span>
              </div>
              {item.source && (
                <p className="text-xs text-muted-foreground">{item.source}</p>
              )}
              {item.reason && (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {item.reason}
                </p>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="py-16 text-center text-sm text-muted-foreground">
      {children}
    </p>
  )
}
