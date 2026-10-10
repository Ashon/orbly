import path from 'node:path'

/**
 * File locations the app uses. Dev runs (electron . in the repository) and the
 * packaged app (Pacenote.app) differ.
 * - Dev: uses the repository build output. The bot is dist/index.js (tsc) and
 *   is rebuilt when sources change.
 * - Packaged: uses only the bundled files inside the app
 *   (Contents/Resources/app). No repository, pnpm, or build is needed.
 * In both cases settings and history live outside the repository
 * (PACENOTE_HOME, PACENOTE_DATA_DIR).
 */
export interface AppPaths {
  packaged: boolean
  /** UI (apps/web build) */
  webDist: string
  /** Bot entry file */
  botEntry: string
  /** sandbox/compose.yaml and image build files */
  sandboxDir: string
  /** Sandbox apply job (src/tools/sandbox-job.ts bundle) */
  jobRunner: string
  /** The run history's MCP server (src/tools/history-mcp.ts bundle) */
  historyMcp: string
  /** Dev runs only: the repository to rebuild the bot from */
  repoRoot?: string
}

/** distDir: the directory containing the app's main.js */
export function resolveAppPaths(distDir: string, packaged: boolean): AppPaths {
  if (packaged) {
    const appRoot = path.dirname(distDir)
    return {
      packaged,
      webDist: path.join(appRoot, 'web'),
      botEntry: path.join(appRoot, 'bot/index.mjs'),
      sandboxDir: path.join(appRoot, 'sandbox'),
      jobRunner: path.join(appRoot, 'tools/sandbox-job.mjs'),
      historyMcp: path.join(appRoot, 'tools/history-mcp.mjs'),
    }
  }
  const repoRoot = path.resolve(distDir, '../../..')
  return {
    packaged,
    webDist: path.join(repoRoot, 'apps/web/dist'),
    botEntry: path.join(repoRoot, 'dist/index.js'),
    sandboxDir: path.join(repoRoot, 'sandbox'),
    jobRunner: path.join(repoRoot, 'build/tools/sandbox-job.mjs'),
    historyMcp: path.join(repoRoot, 'build/tools/history-mcp.mjs'),
    repoRoot,
  }
}
