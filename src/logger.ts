import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { inspect } from "node:util";
import { redactSecrets } from "./broker/redact.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  child(scope: string): Logger;
}

/** 로그 한 줄을 받는 곳. 줄 형식: <ISO 시각> <LEVEL> [<scope>] <message> */
export type LogSink = (level: LogLevel, line: string, args: unknown[]) => void;

export const consoleSink: LogSink = (level, line, args) => {
  const sink =
    level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  sink(line, ...args);
};

/**
 * 파일에 로그를 남긴다. 데스크톱 앱이 이 파일을 읽어 보여 준다.
 * 비밀 값 형식은 가리고, maxBytes 를 넘으면 <file>.1 로 넘기고 새로 쓴다.
 */
export function fileSink(file: string, maxBytes = 5 * 1024 * 1024): LogSink {
  mkdirSync(path.dirname(file), { recursive: true });
  let size = existsSync(file) ? statSync(file).size : 0;
  return (_level, line, args) => {
    const extra = args.map((arg) =>
      arg instanceof Error
        ? `\n${arg.stack ?? arg.message}`
        : ` ${typeof arg === "string" ? arg : inspect(arg, { depth: 3, breakLength: Infinity })}`
    );
    const text = `${redactLogLine(line + extra.join(""))}\n`;
    try {
      if (size + text.length > maxBytes) {
        renameSync(file, `${file}.1`);
        size = 0;
      }
      appendFileSync(file, text);
      size += Buffer.byteLength(text);
    } catch {
      // 로그 파일을 못 써도 봇은 계속 동작한다. (콘솔 로그는 남는다)
    }
  };
}

/** 로그 파일용 가림. 비밀 값 형식과 Socket Mode 접속 주소의 ticket 을 가린다. */
export function redactLogLine(text: string): string {
  return redactSecrets(text).replace(/([?&]ticket=)[^&\s"']+/g, "$1[REDACTED]");
}

export function createLogger(
  level: LogLevel,
  scope = "verda",
  sinks: LogSink[] = [consoleSink]
): Logger {
  const threshold = LEVELS[level];
  const write = (lvl: LogLevel, message: string, args: unknown[]) => {
    if (LEVELS[lvl] < threshold) return;
    const line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} [${scope}] ${message}`;
    for (const sink of sinks) sink(lvl, line, args);
  };
  return {
    debug: (message, ...args) => write("debug", message, args),
    info: (message, ...args) => write("info", message, args),
    warn: (message, ...args) => write("warn", message, args),
    error: (message, ...args) => write("error", message, args),
    child: (child) => createLogger(level, `${scope}:${child}`, sinks),
  };
}
