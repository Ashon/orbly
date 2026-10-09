import type { RunEvent, StepStatus } from './types.js'

/**
 * Helpers for turning a reasoner CLI's output into run history steps. Each
 * CLI's own format is read by its adapter (src/reasoners/claude.ts, codex.ts).
 */

/** Records tool results and command output only up to this length. */
const MAX_OUTPUT_CHARS = 8_000

export const clip = (text: string) =>
  text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n... (truncated, ${text.length} chars total)`
    : text

export const stepStatus = (status: unknown): StepStatus =>
  status === 'completed'
    ? 'completed'
    : status === 'failed'
      ? 'failed'
      : 'running'

export const contentText = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) =>
      part && typeof part === 'object' && 'text' in part
        ? String((part as { text: unknown }).text)
        : ''
    )
    .filter(Boolean)
    .join('\n')
}

/** Returns the last message (the final answer) from a step list. */
export function lastMessage(events: RunEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!
    if (event.kind === 'message') return event.text
  }
  return undefined
}

/**
 * mcp__ops__host_check -> { server: ops, tool: host_check }, Read -> { server:
 * claude, tool: Read }
 */
export function splitToolName(name: string): { server: string; tool: string } {
  const match = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name)
  return match
    ? { server: match[1]!, tool: match[2]! }
    : { server: 'claude', tool: name }
}
