import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { LOG_FILE } from "./status.js";
import type { LogLine } from "./types.js";

const LINE =
  /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z) (DEBUG|INFO|WARN|ERROR)\s+\[([^\]]+)\] ?(.*)$/;

export function parseLogLine(raw: string): LogLine {
  const match = LINE.exec(raw);
  if (!match) return { message: raw };
  return {
    at: match[1],
    level: match[2] as LogLine["level"],
    scope: match[3],
    message: match[4] ?? "",
  };
}

export interface LogQuery {
  /** 최대 줄 수 (뒤에서부터) */
  lines?: number;
  /** scope 앞부분 (예: verda:socket) */
  scope?: string;
  /** 이 수준 이상만 */
  minLevel?: "DEBUG" | "INFO" | "WARN" | "ERROR";
}

const ORDER = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 } as const;
const TAIL_BYTES = 512 * 1024;

/**
 * 봇 로그 파일의 마지막 부분을 읽는다. 여러 줄 로그(스택 등)는 앞 줄에 붙인다.
 */
export function tailLogs(dataDir: string, query: LogQuery = {}): LogLine[] {
  const file = path.join(dataDir, LOG_FILE);
  if (!existsSync(file)) return [];
  const fd = openSync(file, "r");
  let text: string;
  try {
    const { size } = fstatSync(fd);
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    text = buffer.toString("utf8");
    // 중간부터 읽었으면 잘린 첫 줄은 버린다.
    if (length < size) text = text.slice(text.indexOf("\n") + 1);
  } finally {
    closeSync(fd);
  }
  const entries: LogLine[] = [];
  for (const raw of text.split("\n")) {
    if (!raw) continue;
    const line = parseLogLine(raw);
    const last = entries.at(-1);
    if (!line.at && last) last.message += `\n${raw}`;
    else entries.push(line);
  }
  const limit = Math.min(Math.max(query.lines ?? 500, 1), 5_000);
  const min = query.minLevel ? ORDER[query.minLevel] : 0;
  return entries
    .filter(
      (line) =>
        (!query.scope || line.scope?.startsWith(query.scope)) &&
        (!line.level || ORDER[line.level] >= min)
    )
    .slice(-limit);
}
