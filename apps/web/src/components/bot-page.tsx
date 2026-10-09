import { setupSettingsRoute } from '@src/settings/fields'
import type { BotStatus, LogLine, SupervisorState } from '@runtime/types'
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
  Settings,
  Square,
  TriangleAlert,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type * as React from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useBotLogs, useBotStatus } from '@/lib/api'
import { botControl, useSupervisor } from '@/lib/desktop'
import { formatDateTime, formatDuration, formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'
import { describeBot, TONE_CLASS } from './bot-state'
import { CodeBlock } from './code-block'

const SOCKET_LABEL: Record<BotStatus['socket']['state'], string> = {
  connecting: 'connecting',
  connected: 'connected',
  reconnecting: 'reconnecting',
  disconnecting: 'disconnecting',
  disconnected: 'disconnected',
}

export function BotPage() {
  const { data: view } = useBotStatus()
  const supervisor = useSupervisor()
  const status = view?.alive ? view.status : undefined
  const { tone, label } = describeBot(view, supervisor)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b px-8 pt-6 pb-5">
        <div className="@container mx-auto max-w-5xl">
          <div className="flex items-start gap-4">
            <span
              className={cn(
                'mt-1 grid size-10 place-items-center rounded-xl',
                TONE_CLASS[tone].bg
              )}
            >
              <Bot className={cn('size-5', TONE_CLASS[tone].text)} />
            </span>
            <div className="min-w-0 flex-1">
              <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
                Pacey
                <span
                  className={cn('text-sm font-medium', TONE_CLASS[tone].text)}
                >
                  {label}
                </span>
              </h1>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {status
                  ? `Socket Mode ${SOCKET_LABEL[status.socket.state]} ${formatRelative(status.socket.since)}` +
                    `, ${status.socket.reconnects} ${status.socket.reconnects === 1 ? 'reconnect' : 'reconnects'}`
                  : 'The process that receives your Slack mentions and answers them.'}
              </p>
            </div>
            <Controls supervisor={supervisor} />
          </div>
          {supervisor?.message && <Notice supervisor={supervisor} />}
          <div className="mt-4 grid grid-cols-2 gap-3 @min-[44rem]:grid-cols-4">
            <Info icon={<Bot />} label="Bot account">
              {status?.bot ? `@${status.bot.user}` : '-'}
              <Sub>{status?.bot?.team}</Sub>
            </Info>
            <Info icon={<Cpu />} label="Reasoner">
              {status?.reasoner ?? '-'}
              <Sub>
                {status
                  ? `MCP ${status.mcp?.length ? status.mcp.join(', ') : 'none'} / diagrams ${status.diagrams ? 'on' : 'off'}`
                  : undefined}
              </Sub>
            </Info>
            <Info icon={<Inbox />} label="Requests">
              {status ? `${status.requests.active} active` : '-'}
              <Sub>
                {status
                  ? `${status.requests.handled} handled since start` +
                    (status.requests.lastAt
                      ? `, last ${formatRelative(status.requests.lastAt)}`
                      : '')
                  : undefined}
              </Sub>
            </Info>
            <Info icon={<Square />} label="Process">
              {status
                ? `pid ${status.pid}`
                : supervisor?.pid
                  ? `pid ${supervisor.pid}`
                  : '-'}
              <Sub>
                {status
                  ? `${status.managedBy === 'desktop' ? 'Desktop app' : 'Terminal'}, up ${formatDuration(Date.now() - Date.parse(status.startedAt))}`
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
            (supervisor.phase === 'failed' ||
              supervisor.phase === 'crashed' ||
              supervisor.phase === 'building') && (
              <CodeBlock
                className="mt-3"
                label="Last output"
                code={supervisor.output.slice(-40).join('\n')}
                maxHeight="max-h-48"
              />
            )}
        </div>
      </div>
      <LogPanel />
    </div>
  )
}

/**
 * The supervisor's notice under the header. Setup needed is amber with a way to
 * Settings (and the failing values, if any); a failed start or a crash is red;
 * anything else is a quiet note.
 */
function Notice({ supervisor }: { supervisor: SupervisorState }) {
  const { phase, message, issues } = supervisor
  const tone =
    phase === 'setup'
      ? TONE_CLASS.warn
      : phase === 'failed' || phase === 'crashed'
        ? TONE_CLASS.error
        : undefined
  return (
    <div
      className={cn(
        'mt-3 flex items-start gap-3 rounded-lg border px-3 py-2.5 text-xs',
        tone
          ? [tone.bg, tone.text]
          : 'border-transparent bg-muted/60 text-muted-foreground'
      )}
    >
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="select-text">{message}</p>
        {phase === 'setup' && issues && issues.length > 0 && (
          <ul className="space-y-0.5">
            {issues.map((issue) => (
              <li key={`${issue.key}:${issue.message}`}>
                {issue.key && (
                  <span className="font-mono font-medium">{issue.key}</span>
                )}{' '}
                {issue.message}
              </li>
            ))}
          </ul>
        )}
      </div>
      {phase === 'setup' && (
        <Button
          size="xs"
          onClick={() => (window.location.hash = setupSettingsRoute(issues))}
        >
          <Settings />
          Open Settings
        </Button>
      )}
    </div>
  )
}

function Controls({ supervisor }: { supervisor: SupervisorState | undefined }) {
  const control = botControl()
  const [pending, setPending] = useState(false)
  if (!control || !supervisor) {
    return (
      <p className="shrink-0 text-right text-xs text-muted-foreground">
        Start and stop Pacey
        <br />
        from the desktop app.
      </p>
    )
  }
  const phase = supervisor.phase
  const run = (action: () => Promise<void>) => {
    setPending(true)
    void action().finally(() => setPending(false))
  }
  const busy = pending || phase === 'building' || phase === 'stopping'
  const live = phase === 'running' || phase === 'starting'
  return (
    <div className="flex shrink-0 flex-col items-end gap-2">
      <div className="flex items-center gap-1.5">
        {!live && (
          <Button
            size="sm"
            // When setup is needed, the notice's "Open Settings" is the main
            // action; Start only checks again.
            variant={phase === 'setup' ? 'outline' : 'default'}
            disabled={busy || phase === 'external'}
            onClick={() => run(() => control.start())}
          >
            <Play />
            Start
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
            Restart
          </Button>
        )}
        {supervisor.canBuild && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy || phase === 'external'}
            onClick={() => run(() => control.restart(true))}
          >
            <Hammer />
            Rebuild and restart
          </Button>
        )}
        {live && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => run(() => control.stop())}
          >
            <Square />
            Stop
          </Button>
        )}
      </div>
    </div>
  )
}

function Info({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="surface-card min-w-0 px-4 py-3.5">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground [&_svg]:size-3.5">
        {icon}
        {label}
      </div>
      <div className="mt-1 truncate text-sm font-medium">{children}</div>
    </div>
  )
}

function Sub({ children }: { children?: React.ReactNode }) {
  return children ? (
    <div className="truncate text-[11px] font-normal text-muted-foreground">
      {children}
    </div>
  ) : null
}

type LogView = 'all' | 'socket' | 'mention' | 'problems'

const LOG_VIEWS: { value: LogView; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'socket', label: 'Socket Mode' },
  { value: 'mention', label: 'Mentions' },
  { value: 'problems', label: 'Warnings and errors' },
]

const matchesView = (line: LogLine, view: LogView) => {
  // Lines logged before the renames have orbly or verda scopes; all read the
  // same.
  const scope = (line.scope ?? '').replace(/^(orbly|verda)(?=:|$)/, 'pacenote')
  switch (view) {
    case 'socket':
      return (
        scope.startsWith('pacenote:socket') || scope.startsWith('pacenote:bolt')
      )
    case 'mention':
      return (
        scope.startsWith('pacenote:mention') ||
        scope.startsWith('pacenote:history')
      )
    case 'problems':
      return line.level === 'WARN' || line.level === 'ERROR'
    default:
      return true
  }
}

const LEVEL_CLASS: Record<string, string> = {
  DEBUG: 'text-muted-foreground',
  INFO: 'text-status-succeeded',
  WARN: 'text-status-interrupted',
  ERROR: 'text-status-failed',
}

function LogPanel() {
  const [view, setView] = useState<LogView>('all')
  const [q, setQ] = useState('')
  const [follow, setFollow] = useState(true)
  const { data, isError } = useBotLogs({ lines: 1500 })
  const scroller = useRef<HTMLDivElement>(null)
  const lines = useMemo(() => {
    const query = q.trim().toLowerCase()
    return (data ?? []).filter(
      (line) =>
        matchesView(line, view) &&
        (!query || line.message.toLowerCase().includes(query))
    )
  }, [data, view, q])

  useEffect(() => {
    const el = scroller.current
    if (follow && el) el.scrollTop = el.scrollHeight
  }, [lines, follow])

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-8 py-2">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-2 gap-y-1.5">
          <span className="text-sm font-medium">Logs</span>
          <div className="ml-2 flex gap-1">
            {LOG_VIEWS.map((item) => (
              <button
                key={item.value}
                type="button"
                onClick={() => setView(item.value)}
                className={cn(
                  'h-6 rounded-full px-2.5 text-xs font-medium transition-colors',
                  view === item.value
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
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
              placeholder="Search logs"
              className="h-7 pl-7 text-xs"
            />
          </div>
          <Button
            variant={follow ? 'secondary' : 'ghost'}
            size="xs"
            onClick={() => setFollow((v) => !v)}
            aria-pressed={follow}
          >
            <ArrowDownToLine />
            Follow
          </Button>
          {botControl() && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Open logs folder"
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
          if (e.deltaY < 0) setFollow(false)
        }}
        className="min-h-0 flex-1 overflow-auto bg-muted/30 px-8 py-2 font-mono text-[11.5px] leading-[1.6] select-text"
      >
        <div className="mx-auto max-w-5xl">
          {lines.map((line, i) => (
            <LogRow key={`${line.at}-${i}`} line={line} />
          ))}
          {lines.length === 0 && (
            <p className="py-10 text-center font-sans text-sm text-muted-foreground">
              {isError ? 'Could not load logs.' : 'No logs to show.'}
            </p>
          )}
        </div>
      </div>
    </section>
  )
}

function LogRow({ line }: { line: LogLine }) {
  // Lines logged before the renames have orbly or verda scopes.
  const scope =
    (line.scope ?? '').replace(/^(pacenote|orbly|verda):?/, '') || 'main'
  const socket = scope.startsWith('socket') || scope.startsWith('bolt')
  return (
    <div
      className={cn(
        'flex gap-3 rounded px-1.5 hover:bg-accent/50',
        line.level === 'ERROR' && 'bg-status-failed/5'
      )}
    >
      <span className="shrink-0 text-muted-foreground tabular-nums">
        {line.at ? formatDateTime(line.at).slice(6) : ''}
      </span>
      <span
        className={cn(
          'w-10 shrink-0 font-semibold',
          LEVEL_CLASS[line.level ?? 'INFO']
        )}
      >
        {line.level ?? ''}
      </span>
      <span
        className={cn(
          'w-16 shrink-0 truncate',
          socket ? 'text-status-running' : 'text-muted-foreground'
        )}
      >
        {scope}
      </span>
      <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">
        {line.message}
      </span>
    </div>
  )
}
