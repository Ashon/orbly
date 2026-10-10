import { ArrowLeft, MousePointerClick } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { TooltipProvider } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { BotPage } from './components/bot-page'
import {
  ResizeHandle,
  useStoredFlag,
  useStoredWidth,
  useWindowWidth,
} from './components/resize-handle'
import { Overview } from './components/overview'
import { RunDetail } from './components/run-detail'
import { RunList } from './components/run-list'
import { SearchField } from './components/search-field'
import { SettingsPage } from './components/settings-page'
import { Sidebar, type Section } from './components/sidebar'
import { StatusBar } from './components/status-bar'

type Route =
  | { page: 'overview' }
  | { page: 'runs'; id?: string }
  | { page: 'bot' }
  | { page: 'settings' }

/**
 * #/runs: the run list, #/runs/<id>: one run, #/bot: Pace's status and logs,
 * #/settings: Settings, otherwise: Overview
 */
function readRoute(): Route {
  const hash = window.location.hash
  const run = /^#\/runs\/([^/?#]+)/.exec(hash)?.[1]
  if (run) return { page: 'runs', id: decodeURIComponent(run) }
  if (hash.startsWith('#/runs')) return { page: 'runs' }
  if (hash.startsWith('#/bot')) return { page: 'bot' }
  if (hash.startsWith('#/settings')) return { page: 'settings' }
  return { page: 'overview' }
}

function useRoute(): [Route, (hash: string) => void] {
  const [route, setRoute] = useState(readRoute)
  useEffect(() => {
    const onChange = () => setRoute(readRoute())
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return [route, (hash) => (window.location.hash = hash)]
}

/** Sidebar widths, and the window width below which it keeps only icons */
const SIDEBAR = { full: 224, compact: 64, below: 900 }
/** Run list width inside the content surface: default and splitter range */
const LIST_WIDTH = { default: 320, min: 260, max: 520 }
/** What the run detail keeps beside the list; narrower shows one at a time */
const DETAIL_MIN_WIDTH = 440
/** The content surface's margin to the window's right edge */
const SURFACE_MARGIN = 12

const isMac = /Mac/.test(navigator.platform)

export default function App() {
  const [route, go] = useRoute()
  const [q, setQ] = useState('')
  const windowWidth = useWindowWidth()
  const isMacDesktop = window.pacenoteDesktop?.platform === 'darwin'
  const [collapsed, setCollapsed] = useStoredFlag(
    'pacenote.sidebar.collapsed',
    false
  )
  const compact = collapsed || windowWidth < SIDEBAR.below
  const section: Section = route.page

  // Cmd+B shows or hides the sidebar's labels, as in most macOS apps.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.key.toLowerCase() === 'b' &&
        (isMac ? e.metaKey : e.ctrlKey) &&
        !e.shiftKey
      ) {
        e.preventDefault()
        setCollapsed(!collapsed)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  // Searching is for runs, so typing moves to the run list.
  const search = (value: string) => {
    setQ(value)
    if (value && route.page !== 'runs') go('#/runs')
  }

  const surfaceWidth =
    windowWidth - (compact ? SIDEBAR.compact : SIDEBAR.full) - SURFACE_MARGIN

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full flex-col bg-sidebar">
        {/* Three columns keep the search centered on the window; the left one
            clears the traffic lights. */}
        <header className="titlebar-drag grid h-12 shrink-0 grid-cols-[1fr_minmax(0,520px)_1fr] items-center gap-3 px-3">
          <div className={cn(isMacDesktop && 'pl-[72px]')} />
          <SearchField value={q} onChange={search} />
          <div />
        </header>
        <div className="flex min-h-0 flex-1">
          <Sidebar
            active={section}
            compact={compact}
            onNavigate={(next) => go(next === 'overview' ? '#/' : `#/${next}`)}
          />
          {/* One surface holds the whole screen. Its parts are told apart by
              space and hairlines, not by cards of their own. */}
          <main
            className="content-surface mr-3 min-w-0 flex-1 overflow-hidden rounded-[20px] bg-card"
            style={{ boxShadow: 'var(--card-shadow)' }}
          >
            {route.page === 'bot' ? (
              <BotPage />
            ) : route.page === 'settings' ? (
              <SettingsPage />
            ) : route.page === 'runs' ? (
              <RunsPage
                q={q}
                selectedId={route.id}
                width={surfaceWidth}
                onSelect={(id) => go(id ? `#/runs/${id}` : '#/runs')}
              />
            ) : (
              <ScrollArea className="h-full">
                <Overview />
              </ScrollArea>
            )}
          </main>
        </div>
        <StatusBar onOpenRoute={go} />
      </div>
    </TooltipProvider>
  )
}

/**
 * The run list and the selected run, side by side in the one surface with a
 * line between them. When the surface is too narrow for both, it shows one at a
 * time: the list, or the run with a way back.
 */
function RunsPage({
  q,
  selectedId,
  width,
  onSelect,
}: {
  q: string
  selectedId?: string
  width: number
  onSelect: (id?: string) => void
}) {
  const [listWidth, setListWidth] = useStoredWidth(
    'pacenote.runList.width',
    LIST_WIDTH.default
  )
  const listMax = Math.max(
    LIST_WIDTH.min,
    Math.min(LIST_WIDTH.max, width - DETAIL_MIN_WIDTH)
  )
  const listShown = Math.min(listMax, Math.max(LIST_WIDTH.min, listWidth))
  const split = width - LIST_WIDTH.min >= DETAIL_MIN_WIDTH

  if (!split)
    return selectedId ? (
      <div className="flex h-full flex-col">
        <button
          type="button"
          onClick={() => onSelect()}
          className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border px-4 text-sm font-medium text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Runs
        </button>
        <div className="min-h-0 flex-1">
          <RunDetail key={selectedId} id={selectedId} />
        </div>
      </div>
    ) : (
      <RunList q={q} selectedId={selectedId} onSelect={onSelect} />
    )

  return (
    <div className="flex h-full">
      <div
        className="relative shrink-0 border-r border-border"
        style={{ width: listShown }}
      >
        <RunList q={q} selectedId={selectedId} onSelect={onSelect} />
        <ResizeHandle
          value={listShown}
          min={LIST_WIDTH.min}
          max={listMax}
          onChange={setListWidth}
          onReset={() => setListWidth(LIST_WIDTH.default)}
          label="Resize run list"
        />
      </div>
      <div className="min-w-0 flex-1">
        {selectedId ? (
          <RunDetail key={selectedId} id={selectedId} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
            <MousePointerClick className="size-5" strokeWidth={1.75} />
            Pick a run to see what Pace was asked, each step it took, and its
            answer.
          </div>
        )}
      </div>
    </div>
  )
}
