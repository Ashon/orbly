import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipProvider } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { BotPage } from './components/bot-page'
import { NavRail, type Section } from './components/nav-rail'
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
import { StatusBar } from './components/status-bar'

type Route =
  | { page: 'overview' }
  | { page: 'bot' }
  | { page: 'settings' }
  | { page: 'run'; id: string }

/**
 * #/runs/<id>: run detail, #/bot: bot status and logs, #/settings: Settings,
 * otherwise: Overview
 */
function readRoute(): Route {
  const hash = window.location.hash
  const run = /^#\/runs\/([^/?#]+)/.exec(hash)?.[1]
  if (run) return { page: 'run', id: decodeURIComponent(run) }
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

/**
 * Run list width: the default, the range the splitter allows, and what the
 * content keeps beside the rail.
 */
const LIST_WIDTH = { default: 320, min: 260, max: 560 }
const RAIL_WIDTH = 56
const CONTENT_MIN_WIDTH = 480
/**
 * What an open overlay list leaves visible of the content, so it still reads as
 * a layer over it
 */
const OVERLAY_GUTTER = 48

const isMac = /Mac/.test(navigator.platform)

export default function App() {
  const [route, go] = useRoute()
  const [q, setQ] = useState('')
  const selectedId = route.page === 'run' ? route.id : undefined
  const select = (id?: string) => go(id ? `#/runs/${id}` : '#/')
  const isMacDesktop = window.pacenoteDesktop?.platform === 'darwin'
  const section: Section =
    route.page === 'bot'
      ? 'bot'
      : route.page === 'settings'
        ? 'settings'
        : 'overview'
  // The run list belongs to the overview; the bot and settings screens use the
  // full width.
  const showRuns = section === 'overview'
  const [listWidth, setListWidth] = useStoredWidth(
    'pacenote.runList.width',
    LIST_WIDTH.default
  )
  const windowWidth = useWindowWidth()
  // A narrow window lowers the limit so the content keeps its minimum width.
  const listMax = Math.max(
    LIST_WIDTH.min,
    Math.min(LIST_WIDTH.max, windowWidth - RAIL_WIDTH - CONTENT_MIN_WIDTH)
  )
  const listShown = Math.min(listMax, Math.max(LIST_WIDTH.min, listWidth))

  // The list sits beside the content when both fit and the viewer has not
  // hidden it. Otherwise it opens as an overlay over the content (the toggle,
  // Cmd+B, or typing a search) and closes on a pick, Esc, or a click outside
  // it.
  const [listPinned, setListPinned] = useStoredFlag(
    'pacenote.runList.pinned',
    true
  )
  const [overlayOpen, setOverlayOpen] = useState(false)
  const canDock = windowWidth - RAIL_WIDTH - LIST_WIDTH.min >= CONTENT_MIN_WIDTH
  const docked = showRuns && listPinned && canDock
  const overlayShown = showRuns && !docked && overlayOpen
  const overlayMax = Math.max(
    LIST_WIDTH.min,
    Math.min(LIST_WIDTH.max, windowWidth - RAIL_WIDTH - OVERLAY_GUTTER)
  )
  const overlayWidth = Math.min(overlayMax, Math.max(LIST_WIDTH.min, listWidth))
  const toggleList = () => {
    if (canDock) {
      setListPinned(!listPinned)
      setOverlayOpen(false)
    } else setOverlayOpen(!overlayOpen)
  }

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.key.toLowerCase() === 'b' &&
        (isMac ? e.metaKey : e.ctrlKey) &&
        !e.shiftKey
      ) {
        e.preventDefault()
        if (showRuns) toggleList()
        else {
          go('#/')
          if (!(listPinned && canDock)) setOverlayOpen(true)
        }
      } else if (e.key === 'Escape' && overlayShown) setOverlayOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  const search = (value: string) => {
    setQ(value)
    if (value && !showRuns) go('#/')
    if (value && !(listPinned && canDock)) setOverlayOpen(true)
  }
  const pick = (id?: string) => {
    select(id)
    setOverlayOpen(false)
  }
  const listOpen = docked || overlayShown

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full flex-col">
        {/* Three columns keep the search centered on the window; the left
            one clears the traffic lights. */}
        <header className="titlebar-drag grid h-11 shrink-0 grid-cols-[1fr_minmax(0,520px)_1fr] items-center gap-3 border-b border-sidebar-border bg-sidebar px-3">
          {/* The left column clears the traffic lights; a run from the
              repository is labelled there. */}
          <div
            className={cn(
              'flex items-center gap-1.5',
              isMacDesktop && 'pl-[72px]'
            )}
          >
            {showRuns && (
              <Tooltip
                content={`${listOpen ? 'Hide' : 'Show'} run list (${isMac ? 'Cmd' : 'Ctrl'}+B)`}
                side="bottom"
              >
                <button
                  type="button"
                  aria-label={listOpen ? 'Hide run list' : 'Show run list'}
                  aria-expanded={listOpen}
                  onClick={toggleList}
                  className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  {listOpen ? (
                    <PanelLeftClose className="size-4" strokeWidth={1.75} />
                  ) : (
                    <PanelLeftOpen className="size-4" strokeWidth={1.75} />
                  )}
                </button>
              </Tooltip>
            )}
            {window.pacenoteDesktop?.dev && (
              <span className="rounded-md bg-status-interrupted/15 px-1.5 py-px text-[11px] font-semibold text-status-interrupted">
                Dev
              </span>
            )}
          </div>
          <SearchField value={q} onChange={search} />
          <div />
        </header>
        {/* isolate keeps the rail, overlay and scrim layers inside the
            body, so the status bar stays above all of them */}
        <div className="relative isolate flex min-h-0 flex-1">
          {/* Above the overlay list, which slides out from under it */}
          <div className="relative z-40 flex">
            <NavRail
              active={section}
              onNavigate={(next) =>
                go(
                  next === 'bot'
                    ? '#/bot'
                    : next === 'settings'
                      ? '#/settings'
                      : '#/'
                )
              }
            />
          </div>
          {docked && (
            <div className="relative shrink-0" style={{ width: listShown }}>
              <RunList q={q} selectedId={selectedId} onSelect={select} />
              <ResizeHandle
                value={listShown}
                min={LIST_WIDTH.min}
                max={listMax}
                onChange={setListWidth}
                onReset={() => setListWidth(LIST_WIDTH.default)}
                label="Resize run list"
              />
            </div>
          )}
          <main className="min-w-0 flex-1 bg-canvas">
            {route.page === 'bot' ? (
              <BotPage />
            ) : route.page === 'settings' ? (
              <SettingsPage />
            ) : selectedId ? (
              <RunDetail key={selectedId} id={selectedId} />
            ) : (
              <ScrollArea className="h-full">
                <Overview />
              </ScrollArea>
            )}
          </main>
          {showRuns && !docked && (
            <>
              <div
                aria-hidden
                onClick={() => setOverlayOpen(false)}
                className={cn(
                  'absolute inset-y-0 right-0 left-14 z-20 bg-foreground/10 transition-opacity duration-200 motion-reduce:transition-none dark:bg-black/40',
                  overlayShown ? 'opacity-100' : 'pointer-events-none opacity-0'
                )}
              />
              <div
                role="dialog"
                aria-label="Runs"
                inert={!overlayShown}
                style={{ width: overlayWidth }}
                className={cn(
                  'absolute inset-y-0 left-14 z-30 border-r border-sidebar-border shadow-xl transition-transform duration-200 ease-out motion-reduce:transition-none',
                  overlayShown ? 'translate-x-0' : '-translate-x-full'
                )}
              >
                <RunList q={q} selectedId={selectedId} onSelect={pick} />
                <ResizeHandle
                  value={overlayWidth}
                  min={LIST_WIDTH.min}
                  max={overlayMax}
                  onChange={setListWidth}
                  onReset={() => setListWidth(LIST_WIDTH.default)}
                  label="Resize run list"
                />
              </div>
            </>
          )}
        </div>
        <StatusBar onOpenBot={() => go('#/bot')} onOpenSettings={go} />
      </div>
    </TooltipProvider>
  )
}
