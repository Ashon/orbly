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

export function formatRelative(iso: string, now = Date.now()): string {
  const sec = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (sec < 45) return "방금";
  if (sec < 3600) return `${Math.round(sec / 60)}분 전`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)}시간 전`;
  const days = Math.floor(sec / 86_400);
  return days < 7 ? `${days}일 전` : formatDateTime(iso).slice(0, 5);
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || Number.isNaN(ms)) return "-";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}초`;
  // 반올림한 초에서 분, 시간을 나눠야 "1분 60초" 가 나오지 않는다.
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const min = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (hours > 0) return min ? `${hours}시간 ${min}분` : `${hours}시간`;
  return sec ? `${min}분 ${sec}초` : `${min}분`;
}

export const formatNumber = (n: number) => n.toLocaleString("ko-KR");

/** 도구 인자를 한 줄 미리보기로 (host=web-01 check=uptime) */
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
