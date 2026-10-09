const pad = (n: number) => String(n).padStart(2, "0");

/** 10/08 14:03:09 */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${formatClock(iso)}`;
}

/** 14:03:09 */
export function formatClock(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 14:03 */
export function formatHourMinute(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");

/** List group label: Today, Yesterday, Mon, Oct 6 */
export function formatDayGroup(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return `${WEEKDAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

export function formatRelative(iso: string, now = Date.now()): string {
  const sec = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (sec < 45) return "just now";
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)}h ago`;
  const days = Math.floor(sec / 86_400);
  return days < 7 ? `${days}d ago` : formatDateTime(iso).slice(0, 5);
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || Number.isNaN(ms)) return "-";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  // Splitting minutes and hours from the rounded seconds avoids "1m 60s".
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const min = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (hours > 0) return min ? `${hours}h ${min}m` : `${hours}h`;
  return sec ? `${min}m ${sec}s` : `${min}m`;
}

export const formatNumber = (n: number) => n.toLocaleString("en-US");

/** Tool arguments as a one-line preview (host=web-01 check=uptime) */
export function previewArgs(args: unknown, max = 90): string {
  if (args === undefined || args === null) return "";
  let text: string;
  if (typeof args === "object" && !Array.isArray(args)) {
    text = Object.entries(args as Record<string, unknown>)
      .map(
        ([key, value]) =>
          `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`
      )
      .join(" ");
  } else {
    text = typeof args === "string" ? args : JSON.stringify(args);
  }
  text = text.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

export function stepDuration(at: string, finishedAt?: string): number | undefined {
  return finishedAt ? Date.parse(finishedAt) - Date.parse(at) : undefined;
}
