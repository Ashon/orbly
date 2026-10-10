import { setupSettingsRoute } from '@src/settings/fields'
import { Clock, Cpu, FolderOpen, Plug, TriangleAlert } from 'lucide-react'
import type * as React from 'react'
import { Tooltip } from '@/components/ui/tooltip'
import { useBotStatus } from '@/lib/api'
import { useSupervisor } from '@/lib/desktop'
import { formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'
import { describeBot, TONE_CLASS } from './bot-state'

/**
 * The window's footer: indicators to glance at from any screen, on the chrome
 * under the sidebar and the content surface. Left: Pace (status, reasoner,
 * attached tools, check issues). Right: requests, and a button that opens the
 * run history in Finder. Narrow windows drop the less needed ones.
 */
export function StatusBar({
  onOpenRoute,
}: {
  /** Opens a route such as #/bot or #/settings/messengers */
  onOpenRoute: (route: string) => void
}) {
  const { data } = useBotStatus()
  const supervisor = useSupervisor()
  const { tone, label } = describeBot(data, supervisor)
  const status = data?.alive ? data.status : undefined
  const active = status?.requests.active ?? 0
  const problems = status?.problems ?? []
  const tools = [
    ...(status?.mcp ?? []),
    ...(status?.diagrams ? ['diagrams'] : []),
  ]
  const setup = supervisor?.phase === 'setup'
  const openBot = () => onOpenRoute('#/bot')
  const openDataDir = window.pacenoteDesktop?.settings.openDataDir

  return (
    <footer className="@container flex h-8 shrink-0 items-center gap-1 overflow-hidden px-4 text-[11.5px] whitespace-nowrap text-muted-foreground">
      {/* When setup is needed, Pace's status goes straight to the settings
          that fix it. */}
      <Item
        tip={setup ? 'Open Settings to set up Pace' : "Pace's status and logs"}
        onClick={
          setup
            ? () => onOpenRoute(setupSettingsRoute(supervisor.issues))
            : openBot
        }
      >
        <span className="relative flex size-2">
          {(tone === 'ok' || tone === 'busy') && (
            <span
              className={cn(
                'absolute inset-0 animate-ping rounded-full opacity-50',
                TONE_CLASS[tone].dot
              )}
            />
          )}
          <span
            className={cn('relative size-2 rounded-full', TONE_CLASS[tone].dot)}
          />
        </span>
        <span className={cn('font-semibold', TONE_CLASS[tone].text)}>
          Pace: {label}
        </span>
      </Item>
      {status?.reasoner && (
        <Item
          tip="Reasoner backend"
          onClick={openBot}
          className="@max-[34rem]:hidden"
        >
          <Cpu />
          {status.reasoner}
        </Item>
      )}
      {tools.length > 0 && (
        <Item
          tip="Tools attached to the reasoner (MCP), diagram rendering"
          className="min-w-0 shrink @max-[52rem]:hidden"
        >
          <Plug />
          <span className="truncate">{tools.join(', ')}</span>
        </Item>
      )}
      {problems.length > 0 && (
        <Item
          tip={problems.join('\n')}
          onClick={openBot}
          className="text-status-interrupted"
        >
          <TriangleAlert />
          {problems.length}{' '}
          {problems.length === 1 ? 'check issue' : 'check issues'}
        </Item>
      )}

      <div className="ml-auto flex shrink-0 items-center gap-1">
        {active > 0 && (
          <Item
            tip="Requests in progress now"
            onClick={openBot}
            className="text-status-running"
          >
            <span className="size-1.5 animate-pulse-dot rounded-full bg-status-running" />
            {active} active
          </Item>
        )}
        {status?.requests.lastAt && (
          <Item
            tip={`${status.requests.handled} handled since Pace started`}
            className="@max-[44rem]:hidden"
          >
            <Clock />
            Last request {formatRelative(status.requests.lastAt)}
          </Item>
        )}
        {/* Only the icon: the folder's path is in Settings > General. */}
        {openDataDir && (
          <Item
            label="Open run history in Finder"
            tip="Open run history in Finder"
            onClick={() => void openDataDir()}
          >
            <FolderOpen />
          </Item>
        )}
      </div>
    </footer>
  )
}

function Item({
  tip,
  label,
  onClick,
  className,
  children,
}: {
  tip: string
  /** For an item that is only an icon */
  label?: string
  onClick?: () => void
  className?: string
  children: React.ReactNode
}) {
  const body = cn(
    'flex h-6 shrink-0 items-center gap-1.5 rounded-md px-1.5 whitespace-nowrap [&_svg]:size-3.5 [&_svg]:shrink-0',
    onClick && 'transition-colors hover:bg-selected/50 hover:text-foreground',
    className
  )
  return (
    <Tooltip
      content={<span className="whitespace-pre-line">{tip}</span>}
      side="top"
    >
      {onClick ? (
        <button
          type="button"
          aria-label={label}
          onClick={onClick}
          className={body}
        >
          {children}
        </button>
      ) : (
        <span aria-label={label} className={body}>
          {children}
        </span>
      )}
    </Tooltip>
  )
}
