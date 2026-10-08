import { readFile } from "node:fs/promises";
import path from "node:path";
import type { HistoryReader } from "./history/reader.js";
import type { RunStatus } from "./history/types.js";
import { tailLogs } from "./runtime/logs.js";
import { readBotStatus } from "./runtime/status.js";

/**
 * 로컬 조회 API (읽기 전용). 데스크톱 앱의 verda:// 프로토콜과 web 개발 서버가 같이 쓴다.
 * 데이터 디렉터리는 reader.root 다. 봇 시작/중지 같은 제어는 여기 없고 데스크톱 앱 IPC 로만 한다.
 *   GET /api/health
 *   GET /api/runs?status=&q=&limit=
 *   GET /api/runs/:id
 *   GET /api/runs/:id/artifacts/:file
 *   GET /api/stats
 *   GET /api/bot                                봇 상태 (bot.json + pid 생존 여부)
 *   GET /api/bot/logs?lines=&scope=&level=      봇 로그 (logs/bot.log 의 마지막 부분)
 */
const STATUSES = new Set<RunStatus>(["running", "succeeded", "failed", "interrupted"]);

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

const notFound = () => json({ error: "not found" }, 404);

const LOG_LEVELS = new Set(["DEBUG", "INFO", "WARN", "ERROR"] as const);

export async function handleLocalApi(
  reader: HistoryReader,
  method: string,
  url: URL
): Promise<Response> {
  if (method !== "GET") return json({ error: "method not allowed" }, 405);
  const parts = url.pathname
    .replace(/^\/api\/?/, "")
    .split("/")
    .filter(Boolean)
    .map(decodeURIComponent);

  if (parts.length === 1 && parts[0] === "health")
    return json({ ok: true, root: reader.root });
  if (parts.length === 1 && parts[0] === "stats") return json(reader.stats());
  if (parts[0] === "bot") {
    if (parts.length === 1) return json(readBotStatus(reader.root));
    if (parts.length === 2 && parts[1] === "logs") {
      const level = url.searchParams.get("level")?.toUpperCase();
      return json(
        tailLogs(reader.root, {
          lines: Number(url.searchParams.get("lines") ?? "") || undefined,
          scope: url.searchParams.get("scope") || undefined,
          minLevel:
            level && LOG_LEVELS.has(level as never)
              ? (level as "DEBUG" | "INFO" | "WARN" | "ERROR")
              : undefined,
        })
      );
    }
    return notFound();
  }
  if (parts[0] !== "runs") return notFound();

  if (parts.length === 1) {
    const status = url.searchParams.get("status") as RunStatus | null;
    const limit = Number(url.searchParams.get("limit") ?? "") || undefined;
    return json(
      reader.list({
        status: status && STATUSES.has(status) ? status : undefined,
        q: url.searchParams.get("q") ?? undefined,
        limit,
      })
    );
  }
  const id = parts[1]!;
  if (parts.length === 2) {
    const run = reader.get(id);
    return run ? json(run) : notFound();
  }
  if (parts.length === 4 && parts[2] === "artifacts") {
    const file = reader.artifactPath(id, parts[3]!);
    const type = file ? IMAGE_TYPES[path.extname(file).toLowerCase()] : undefined;
    if (!file || !type) return notFound();
    return new Response(new Uint8Array(await readFile(file)), {
      headers: { "content-type": type, "cache-control": "private, max-age=3600" },
    });
  }
  return notFound();
}
