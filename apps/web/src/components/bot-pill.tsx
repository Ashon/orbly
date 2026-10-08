import { useBotStatus } from "@/lib/api";
import { useSupervisor } from "@/lib/desktop";
import { cn } from "@/lib/utils";
import { describeBot, TONE_CLASS } from "./bot-state";

export function BotPill({ active, onClick }: { active: boolean; onClick: () => void }) {
  const { data } = useBotStatus();
  const supervisor = useSupervisor();
  const { tone, label } = describeBot(data, supervisor);
  const requests = data?.alive ? (data.status?.requests.active ?? 0) : 0;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors",
        TONE_CLASS[tone].bg,
        TONE_CLASS[tone].text,
        active && "ring-2 ring-ring/40"
      )}
    >
      <span className="relative flex size-2">
        {(tone === "ok" || tone === "busy") && (
          <span
            className={cn(
              "absolute inset-0 animate-ping rounded-full opacity-50",
              TONE_CLASS[tone].dot
            )}
          />
        )}
        <span className={cn("relative size-2 rounded-full", TONE_CLASS[tone].dot)} />
      </span>
      봇 {label}
      {requests > 0 && (
        <span className="rounded-full bg-background/60 px-1.5 text-[10px] tabular-nums">
          처리 중 {requests}
        </span>
      )}
    </button>
  );
}
