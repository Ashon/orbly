import { Bot, LayoutDashboard, Settings, type LucideIcon } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type Section = "overview" | "bot" | "settings";

const TOP: { section: Section; label: string; icon: LucideIcon }[] = [
  { section: "overview", label: "Overview", icon: LayoutDashboard },
  { section: "bot", label: "Pacey", icon: Bot },
];
const BOTTOM: { section: Section; label: string; icon: LucideIcon } = {
  section: "settings",
  label: "Settings",
  icon: Settings,
};

/** Left icon rail: the app's sections. Settings sits at the bottom, as in most macOS apps. */
export function NavRail({
  active,
  onNavigate,
}: {
  active: Section;
  onNavigate: (section: Section) => void;
}) {
  const item = ({ section, label, icon: Icon }: (typeof TOP)[number]) => (
    <Tooltip key={section} content={label} side="right">
      <button
        type="button"
        aria-label={label}
        aria-current={active === section ? "page" : undefined}
        onClick={() => onNavigate(section)}
        className={cn(
          "relative grid size-9 place-items-center rounded-xl text-muted-foreground transition-colors outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50",
          active === section && "bg-card text-foreground shadow-xs hover:bg-card"
        )}
      >
        {/* The active section is marked with the Pacenote gradient at the rail's edge. */}
        {active === section && (
          <span className="pacenote-gradient absolute top-1/2 -left-2.5 h-5 w-[3px] -translate-y-1/2 rounded-r-full" />
        )}
        <Icon className="size-[18px]" strokeWidth={1.75} />
      </button>
    </Tooltip>
  );

  return (
    <nav
      aria-label="Sections"
      className="flex w-14 shrink-0 flex-col items-center gap-1 border-r border-sidebar-border bg-sidebar py-3"
    >
      {TOP.map(item)}
      <div className="mt-auto">{item(BOTTOM)}</div>
    </nav>
  );
}
