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
 * Logger used by the Bolt and Socket Mode clients. Forwards to the bot logger (console + log file).
 * The library cannot change the name (setName); scope tells them apart. The output level follows LOG_LEVEL.
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
