import { LayoutDashboard, Monitor, Moon, Settings, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipProvider } from "@/components/ui/tooltip";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { BotPage } from "./components/bot-page";
import { BotPill } from "./components/bot-pill";
import { Overview } from "./components/overview";
import { RunDetail } from "./components/run-detail";
import { RunList } from "./components/run-list";
import { SettingsPage } from "./components/settings-page";

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

const THEME_ICON = { system: Monitor, light: Sun, dark: Moon } as const;
const THEME_LABEL = { system: "시스템 테마", light: "라이트", dark: "다크" } as const;

export default function App() {
  const [route, go] = useRoute();
  const selectedId = route.page === "run" ? route.id : undefined;
  const select = (id?: string) => go(id ? `#/runs/${id}` : "#/");
  const theme = useTheme();
  const ThemeIcon = THEME_ICON[theme.mode];
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
          <div className="ml-auto flex items-center gap-1">
            <BotPill active={route.page === "bot"} onClick={() => go("#/bot")} />
            <span className="mx-1 h-4 w-px bg-border" />
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
            <Tooltip content={THEME_LABEL[theme.mode]} side="bottom">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="테마 바꾸기"
                onClick={theme.next}
              >
                <ThemeIcon />
              </Button>
            </Tooltip>
          </div>
        </header>
        <div className="flex min-h-0 flex-1">
          <RunList selectedId={selectedId} onSelect={select} />
          <main className="min-w-0 flex-1">
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
      </div>
    </TooltipProvider>
  );
}
