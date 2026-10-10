import { setupSettingsRoute } from '@src/settings/fields'
import {
  Bot,
  History,
  LayoutDashboard,
  Settings,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react'
import { Tooltip } from '@/components/ui/tooltip'
import { useBotStatus } from '@/lib/api'
import { useSupervisor } from '@/lib/desktop'
import { formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'
import { describeBot, TONE_CLASS } from './bot-state'
import { PacenoteMark } from './logo'

export type Section = 'overview' | 'runs' | 'bot' | 'settings'

type Item = { section: Section; label: string; icon: LucideIcon }

/** The screens for watching Pace, at the top */
const ITEMS: Item[] = [
  { section: 'overview', label: 'Overview', icon: LayoutDashboard },
  { section: 'runs', label: 'Runs', icon: History },
  { section: 'bot', label: 'Pace', icon: Bot },
]
/** Setting the app up, at the bottom beside Pace's status */
const SETTINGS: Item = {
  section: 'settings',
  label: 'Settings',
  icon: Settings,
}

/**
 * The app's sections as a labeled list: the screens for watching Pace at the
 * top, and Settings at the bottom above Pace's status. A compact sidebar keeps
 * only the icons, for narrow windows.
 */
export function Sidebar({
  active,
  compact,
  onNavigate,
  onOpenRoute,
}: {
  active: Section
  compact: boolean
  onNavigate: (section: Section) => void
  /** Opens a route such as #/settings/messengers */
  onOpenRoute: (route: string) => void
}) {
  const item = (props: Item) => (
    <NavItem
      key={props.section}
      {...props}
      current={active === props.section}
      compact={compact}
      onClick={() => onNavigate(props.section)}
    />
  )
  return (
    <nav
      aria-label="Sections"
      className={cn(
        'flex shrink-0 flex-col pb-4',
        compact ? 'w-16 items-center px-2' : 'w-56 px-3'
      )}
    >
      <div
        className={cn(
          'flex items-center gap-2.5 pt-1 pb-5',
          compact ? 'justify-center' : 'px-2.5'
        )}
      >
        <PacenoteMark className="size-7" />
        {!compact && (
          <span className="text-[15px] font-semibold tracking-tight">
            Pacenote
          </span>
        )}
        {!compact && window.pacenoteDesktop?.dev && (
          <span className="rounded-md bg-status-interrupted/15 px-1.5 py-px text-[11px] font-semibold text-status-interrupted">
            Dev
          </span>
        )}
      </div>

      <div className="flex flex-col gap-1">{ITEMS.map(item)}</div>

      <div
        className={cn(
          'mt-auto flex w-full flex-col gap-3',
          compact && 'items-center'
        )}
      >
        {item(SETTINGS)}
        <div
          className={cn(
            'w-full border-t border-sidebar-border pt-3',
            compact && 'flex justify-center'
          )}
        >
          <PaceStatus compact={compact} onOpenRoute={onOpenRoute} />
        </div>
      </div>
    </nav>
  )
}

function NavItem({
  label,
  icon: Icon,
  current,
  compact,
  onClick,
}: Item & { current: boolean; compact: boolean; onClick: () => void }) {
  const button = (
    <button
      type="button"
      aria-label={compact ? label : undefined}
      aria-current={current ? 'page' : undefined}
      onClick={onClick}
      className={cn(
        'flex h-9 items-center gap-2.5 rounded-xl text-[13.5px] transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
        compact ? 'w-10 justify-center' : 'px-2.5',
        current
          ? 'bg-selected font-semibold text-foreground'
          : 'text-muted-foreground hover:bg-selected/50 hover:text-foreground'
      )}
    >
      <Icon
        className={cn('size-[18px] shrink-0', current && 'text-primary')}
        strokeWidth={1.75}
      />
      {!compact && label}
    </button>
  )
  return compact ? (
    <Tooltip content={label} side="right">
      {button}
    </Tooltip>
  ) : (
    button
  )
}

/**
 * Pace's status, to glance at from any screen: whether it is connected, what it
 * answers with, and what needs attention. When setup is needed it goes straight
 * to the settings that fix it.
 */
function PaceStatus({
  compact,
  onOpenRoute,
}: {
  compact: boolean
  onOpenRoute: (route: string) => void
}) {
  const { data } = useBotStatus()
  const supervisor = useSupervisor()
  const { tone, label } = describeBot(data, supervisor)
  const status = data?.alive ? data.status : undefined
  const active = status?.requests.active ?? 0
  const problems = status?.problems ?? []
  const setup = supervisor?.phase === 'setup'
  const open = () =>
    onOpenRoute(setup ? setupSettingsRoute(supervisor.issues) : '#/bot')

  const dot = (
    <span className="relative flex size-2 shrink-0">
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
  )

  if (compact)
    return (
      <Tooltip content={`Pace: ${label}`} side="right">
        <button
          type="button"
          onClick={open}
          aria-label={`Pace: ${label}`}
          className="grid size-10 place-items-center rounded-xl hover:bg-selected/50"
        >
          {dot}
        </button>
      </Tooltip>
    )

  const detail = [
    status?.reasoner,
    active > 0
      ? `${active} active`
      : status?.requests.lastAt
        ? `last request ${formatRelative(status.requests.lastAt)}`
        : undefined,
  ].filter(Boolean)

  return (
    <div className="flex flex-col gap-1 px-2.5">
      <button
        type="button"
        onClick={open}
        className="-mx-2 flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-selected/50"
      >
        {dot}
        <span className={cn('font-semibold', TONE_CLASS[tone].text)}>
          Pace: {label}
        </span>
      </button>
      {(setup || detail.length > 0) && (
        <p className="text-xs leading-snug text-muted-foreground">
          {setup
            ? 'A few settings are missing before Pace can start.'
            : detail.join(' · ')}
        </p>
      )}
      {problems.length > 0 && (
        <button
          type="button"
          onClick={() => onOpenRoute('#/bot')}
          title={problems.join('\n')}
          className="flex items-center gap-1.5 text-left text-xs font-medium text-status-interrupted hover:underline"
        >
          <TriangleAlert className="size-3.5 shrink-0" />
          {problems.length}{' '}
          {problems.length === 1 ? 'check issue' : 'check issues'}
        </button>
      )}
    </div>
  )
}
