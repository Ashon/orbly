import { existsSync, readFileSync } from 'node:fs'

export interface CodexDefaults {
  model?: string
  reasoningEffort?: string
}

/**
 * Reads only the top-level model and model_reasoning_effort from
 * ~/.codex/config.toml. The host config file is not put in the sandbox
 * container, so only these values are passed as arguments.
 */
export function parseCodexDefaults(toml: string): CodexDefaults {
  const topLevel = toml.split(/^\s*\[/m)[0] ?? ''
  const read = (key: string) =>
    new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm').exec(topLevel)?.[1]
  return {
    model: read('model'),
    reasoningEffort: read('model_reasoning_effort'),
  }
}

export function readCodexDefaults(configFile: string): CodexDefaults {
  if (!existsSync(configFile)) return {}
  return parseCodexDefaults(readFileSync(configFile, 'utf8'))
}
