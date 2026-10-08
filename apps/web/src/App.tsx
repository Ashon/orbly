import { Bot, LayoutDashboard, Settings } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { BotPage } from "./components/bot-page";
import { Overview } from "./components/overview";
import { RunDetail } from "./components/run-detail";
import { RunList } from "./components/run-list";
import { SettingsPage } from "./components/settings-page";
import { StatusBar } from "./components/status-bar";

type Route =
  | { page: "overview" }
  | { page: "bot" }
  | { page: "settings" }
  | { page: "run"; id: string };

/** #/runs/<id>: 실행 상세, #/bot: 봇 상태와 로그, #/settings: 설정, 그 밖: 개요 */
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

export default function App() {
  const [route, go] = useRoute();
  const selectedId = route.page === "run" ? route.id : undefined;
  const select = (id?: string) => go(id ? `#/runs/${id}` : "#/");
  const isMacDesktop = window.verdaDesktop?.platform === "darwin";

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full flex-col">
        <header
          className={cn(
            "titlebar-drag flex h-11 shrink-0 items-center gap-2 border-b border-sidebar-border bg-sidebar pr-3",
            isMacDesktop ? "pl-[84px]" : "pl-4"
          )}
        >
          <button
            type="button"
            onClick={() => select()}
            className="flex items-center gap-2"
          >
            <span className="verda-gradient-text text-sm font-semibold tracking-tight">
              Verda
            </span>
          </button>
          <span className="text-xs text-muted-foreground">작업 기록</span>
          {/* 위는 화면 이동만 둔다. 봇 상태와 테마는 아래 상태 막대에 있다. */}
          <div className="ml-auto flex items-center gap-1">
            <Tooltip content="개요" side="bottom">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="개요"
                onClick={() => select()}
                className={cn(
                  route.page === "overview" && "bg-accent text-accent-foreground"
                )}
              >
                <LayoutDashboard />
              </Button>
            </Tooltip>
            <Tooltip content="봇" side="bottom">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="봇"
                onClick={() => go("#/bot")}
                className={cn(route.page === "bot" && "bg-accent text-accent-foreground")}
              >
                <Bot />
              </Button>
            </Tooltip>
            <Tooltip content="설정" side="bottom">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="설정"
                onClick={() => go("#/settings")}
                className={cn(
                  route.page === "settings" && "bg-accent text-accent-foreground"
                )}
              >
                <Settings />
              </Button>
            </Tooltip>
          </div>
        </header>
        <div className="flex min-h-0 flex-1">
          <RunList selectedId={selectedId} onSelect={select} />
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
        <StatusBar onOpenBot={() => go("#/bot")} />
      </div>
    </TooltipProvider>
  );
}
