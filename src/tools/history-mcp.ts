import { homedir } from 'node:os'
import path from 'node:path'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createHistoryServer } from '../history/mcp.js'
import { HistoryReader } from '../history/reader.js'
import { readEnvFile, readEnvValues } from '../settings/env-file.js'
import { defaultHome } from '../settings/legacy.js'
import { loadEnv } from '../settings/load-env.js'
import { envFilePath } from '../settings/paths.js'

/**
 * Pacenote's run history over MCP (stdio), for AI tools on this Mac. They
 * launch it themselves; Settings > History & logs shows the command, which
 * runs this bundle with the app's own Node (ELECTRON_RUN_AS_NODE=1), so no
 * Node install is needed. In the repository: pnpm mcp.
 * - The history is the one the desktop app shows: PACENOTE_DATA_DIR, or the
 *   home (~/.pacenote).
 * - Sharing (HISTORY_SHARE) is read from the config file on every call, so the
 *   switch in Settings applies without restarting the client. A value set in
 *   the environment at launch wins.
 * stdout carries the protocol; warnings go to stderr.
 */
const launched = process.env.HISTORY_SHARE
const envFile = envFilePath()
for (const warning of loadEnv()) console.error(`[pacenote-mcp] ${warning}`)

const server = createHistoryServer({
  reader: new HistoryReader(dataDir(process.env.PACENOTE_DATA_DIR)),
  enabled: () =>
    (launched ?? readEnvValues(readEnvFile(envFile)).HISTORY_SHARE) === 'on',
  version: process.env.PACENOTE_VERSION ?? 'dev',
})
await server.connect(new StdioServerTransport())

/** Same as the desktop app: the configured folder, or the home */
function dataDir(value: string | undefined): string {
  if (!value) return defaultHome()
  return path.resolve(
    value === '~' || value.startsWith('~/')
      ? path.join(homedir(), value.slice(1))
      : value
  )
}
