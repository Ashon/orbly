import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
} from 'node:fs'
import path from 'node:path'
import { inspect } from 'node:util'
import { redactSecrets } from './broker/redact.js'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

export interface Logger {
  debug(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
  child(scope: string): Logger
}

/**
 * Receives one log line. Line format: <ISO time> <LEVEL> [<scope>] <message>
 */
export type LogSink = (level: LogLevel, line: string, args: unknown[]) => void

export const consoleSink: LogSink = (level, line, args) => {
  const sink =
    level === 'error'
      ? console.error
      : level === 'warn'
        ? console.warn
        : console.log
  sink(line, ...args)
}

/**
 * Writes logs to a file. The desktop app reads and shows this file.
 * Redacts secret formats, and past maxBytes moves the file to <file>.1 and
 * starts fresh.
 */
export function fileSink(file: string, maxBytes = 5 * 1024 * 1024): LogSink {
  mkdirSync(path.dirname(file), { recursive: true })
  let size = existsSync(file) ? statSync(file).size : 0
  return (_level, line, args) => {
    const extra = args.map((arg) =>
      arg instanceof Error
        ? `\n${arg.stack ?? arg.message}`
        : ` ${typeof arg === 'string' ? arg : inspect(arg, { depth: 3, breakLength: Infinity })}`
    )
    const text = `${redactLogLine(line + extra.join(''))}\n`
    try {
      if (size + text.length > maxBytes) {
        renameSync(file, `${file}.1`)
        size = 0
      }
      appendFileSync(file, text)
      size += Buffer.byteLength(text)
    } catch {
      // The bot keeps running even if the log file cannot be written. (Console
      // logs remain)
    }
  }
}

/**
 * Redaction for the log file. Redacts secret formats and the ticket in Socket
 * Mode URLs.
 */
export function redactLogLine(text: string): string {
  return redactSecrets(text).replace(/([?&]ticket=)[^&\s"']+/g, '$1[REDACTED]')
}

export function createLogger(
  level: LogLevel,
  scope = 'pacenote',
  sinks: LogSink[] = [consoleSink]
): Logger {
  const threshold = LEVELS[level]
  const write = (lvl: LogLevel, message: string, args: unknown[]) => {
    if (LEVELS[lvl] < threshold) return
    const line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} [${scope}] ${message}`
    for (const sink of sinks) sink(lvl, line, args)
  }
  return {
    debug: (message, ...args) => write('debug', message, args),
    info: (message, ...args) => write('info', message, args),
    warn: (message, ...args) => write('warn', message, args),
    error: (message, ...args) => write('error', message, args),
    child: (child) => createLogger(level, `${scope}:${child}`, sinks),
  }
}
