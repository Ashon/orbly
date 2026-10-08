import { inspect } from "node:util";
import { LogLevel as SlackLogLevel, type Logger as SlackLogger } from "@slack/bolt";
import type { Logger, LogLevel } from "../logger.js";

const TO_SLACK: Record<LogLevel, SlackLogLevel> = {
  debug: SlackLogLevel.DEBUG,
  info: SlackLogLevel.INFO,
  warn: SlackLogLevel.WARN,
  error: SlackLogLevel.ERROR,
};

const format = (parts: unknown[]) =>
  parts
    .map((part) =>
      typeof part === "string"
        ? part
        : part instanceof Error
          ? part.message
          : inspect(part, { depth: 3, breakLength: Infinity })
    )
    .join(" ");

/**
 * Bolt, Socket Mode 클라이언트가 쓰는 로거. 봇 로거(콘솔 + 로그 파일)로 보낸다.
 * 이름(setName)은 라이브러리가 바꾸지 못하게 하고 scope 로 구분한다. 출력 수준은 LOG_LEVEL 을 따른다.
 */
export function slackLogger(log: Logger, level: LogLevel): SlackLogger {
  return {
    debug: (...msg: unknown[]) => log.debug(format(msg)),
    info: (...msg: unknown[]) => log.info(format(msg)),
    warn: (...msg: unknown[]) => log.warn(format(msg)),
    error: (...msg: unknown[]) => log.error(format(msg)),
    setLevel: () => undefined,
    getLevel: () => TO_SLACK[level],
    setName: () => undefined,
  };
}
