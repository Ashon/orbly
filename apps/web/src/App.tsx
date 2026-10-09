import { useEffect, useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { BotPage } from "./components/bot-page";
import { NavRail, type Section } from "./components/nav-rail";
import { ResizeHandle, useStoredWidth, useWindowWidth } from "./components/resize-handle";
import { Overview } from "./components/overview";
import { RunDetail } from "./components/run-detail";
import { RunList } from "./components/run-list";
import { SearchField } from "./components/search-field";
import { SettingsPage } from "./components/settings-page";
import { StatusBar } from "./components/status-bar";

type Route =
  | { page: "overview" }
  | { page: "bot" }
  | { page: "settings" }
  | { page: "run"; id: string };

/** #/runs/<id>: run detail, #/bot: bot status and logs, #/settings: Settings, otherwise: Overview */
function readRoute(): Route {
  const hash = window.location.hash;
  const run = /^#\/runs\/([^/?#]+)/.exec(hash)?.[1];
  if (run) return { page: "run", id: decodeURIComponent(run) };
  if (hash.startsWith("#/bot")) return { page: "bot" };
  if (hash.startsWith("#/settings")) return { page: "settings" };
  return { page: "overview" };
}

function useRoute(): [Route, (hash: string) => void] {
  const [route, setRoute] = useState(readRoute);
  useEffect(() => {
    const onChange = () => setRoute(readRoute());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return [route, (hash) => (window.location.hash = hash)];
}

/** Run list width: the default, the range the splitter allows, and what the content keeps beside the rail. */
const LIST_WIDTH = { default: 320, min: 260, max: 560 };
const RAIL_WIDTH = 56;
const CONTENT_MIN_WIDTH = 480;

export default function App() {
  const [route, go] = useRoute();
  const [q, setQ] = useState("");
  const selectedId = route.page === "run" ? route.id : undefined;
  const select = (id?: string) => go(id ? `#/runs/${id}` : "#/");
  const isMacDesktop = window.orblyDesktop?.platform === "darwin";
  const section: Section =
    route.page === "bot" ? "bot" : route.page === "settings" ? "settings" : "overview";
  // The run list belongs to the overview; the bot and settings screens use the full width.
  const showRuns = section === "overview";
  const [listWidth, setListWidth] = useStoredWidth(
    "orbly.runList.width",
    LIST_WIDTH.default
  );
  const windowWidth = useWindowWidth();
  // A narrow window lowers the limit so the content keeps its minimum width.
  const listMax = Math.max(
    LIST_WIDTH.min,
    Math.min(LIST_WIDTH.max, windowWidth - RAIL_WIDTH - CONTENT_MIN_WIDTH)
  );
  const listShown = Math.min(listMax, Math.max(LIST_WIDTH.min, listWidth));

  const search = (value: string) => {
    setQ(value);
    if (value && !showRuns) go("#/");
  };

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full flex-col">
        {/* Three columns keep the search centered on the window; the left one clears the traffic lights. */}
        <header className="titlebar-drag grid h-11 shrink-0 grid-cols-[1fr_minmax(0,520px)_1fr] items-center gap-3 border-b border-sidebar-border bg-sidebar px-3">
          {/* The left column clears the traffic lights; a run from the repository is labelled there. */}
          <div className={cn("flex items-center", isMacDesktop && "pl-[72px]")}>
            {window.orblyDesktop?.dev && (
              <span className="rounded-md bg-status-interrupted/15 px-1.5 py-px text-[11px] font-semibold text-status-interrupted">
                Dev
              </span>
            )}
          </div>
          <SearchField value={q} onChange={search} />
          <div />
        </header>
        <div className="flex min-h-0 flex-1">
          <NavRail
            active={section}
            onNavigate={(next) =>
              go(next === "bot" ? "#/bot" : next === "settings" ? "#/settings" : "#/")
            }
          />
          {showRuns && (
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
            {route.page === "bot" ? (
              <BotPage />
            ) : route.page === "settings" ? (
              <SettingsPage />
            ) : selectedId ? (
              <RunDetail key={selectedId} id={selectedId} />
            ) : (
              <ScrollArea className="h-full">
                <Overview />
              </ScrollArea>
            )}
          </main>
        </div>
        <StatusBar onOpenBot={() => go("#/bot")} onOpenSettings={go} />
      </div>
    </TooltipProvider>
  );
}
