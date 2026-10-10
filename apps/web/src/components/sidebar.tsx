import {
  Bot,
  Bug,
  History,
  LayoutDashboard,
  Settings,
  type LucideIcon,
} from 'lucide-react'
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { PacenoteMark } from './logo'

export type Section = 'overview' | 'runs' | 'bot' | 'settings' | 'debug'

type Item = { section: Section; label: string; icon: LucideIcon }

/** The screens for watching Pace, at the top */
const ITEMS: Item[] = [
  { section: 'overview', label: 'Overview', icon: LayoutDashboard },
  { section: 'runs', label: 'Runs', icon: History },
  { section: 'bot', label: 'Pace', icon: Bot },
]
/** Setting the app up, at the bottom */
const SETTINGS: Item = {
  section: 'settings',
  label: 'Settings',
  icon: Settings,
}
/** Builds made for development only (see App), above Settings */
const DEBUG: Item = { section: 'debug', label: 'Debug', icon: Bug }

/**
 * The app's sections as a labeled list: the screens for watching Pace at the
 * top, and Settings at the bottom. (Pace's status is in the status bar.) A
 * compact sidebar keeps only the icons, for narrow windows.
 */
export function Sidebar({
  active,
  compact,
  onNavigate,
  showDebug,
}: {
  active: Section
  compact: boolean
  onNavigate: (section: Section) => void
  showDebug: boolean
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
        'flex shrink-0 flex-col pb-3',
        compact ? 'w-16 items-center px-2' : 'w-56 px-3'
      )}
    >
      <div
        className={cn(
          'flex items-center gap-2.5 pt-1 pb-5',
          compact ? 'justify-center' : 'px-2.5'
        )}
      >
        {/* Larger than the icons below, but on their center line and taking
            their width, so "Pacenote" starts where the labels do. */}
        <PacenoteMark className="-mx-[5px] size-7" />
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

      <div className="mt-auto flex flex-col gap-1">
        {showDebug && item(DEBUG)}
        {item(SETTINGS)}
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
