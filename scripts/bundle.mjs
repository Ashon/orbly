import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

/**
 * Builds single-file executables with their dependencies bundled in. The
 * packaged desktop app and the broker image use only these outputs.
 * - build/bot/index.mjs: the bot (the packaged app runs it as a utilityProcess)
 * - build/tools/sandbox-job.mjs: sandbox apply jobs (run by the packaged app)
 * - build/tools/history-mcp.mjs: the run history's MCP server (AI tools launch
 *   it with the packaged app's Node)
 * - sandbox/ops-broker/dist/server.mjs: ops-broker (goes into the image)
 * - deploy/hub/dist/hub.mjs: the team hub (goes into its image, deploy/hub)
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { version } = JSON.parse(
  readFileSync(path.join(root, 'package.json'), 'utf8')
)
const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  logLevel: 'warning',
  // The release, for what reports one (the history MCP server's name/version)
  define: { 'process.env.PACENOTE_VERSION': JSON.stringify(version) },
  // Makes require work in ESM for the bundled CommonJS dependencies.
  banner: {
    js: "import { createRequire as __pacenoteCreateRequire } from 'node:module'; const require = __pacenoteCreateRequire(import.meta.url);",
  },
}
const targets = [
  ['src/index.ts', 'build/bot/index.mjs'],
  ['src/tools/sandbox-job.ts', 'build/tools/sandbox-job.mjs'],
  ['src/tools/history-mcp.ts', 'build/tools/history-mcp.mjs'],
  ['src/broker/server.ts', 'sandbox/ops-broker/dist/server.mjs'],
  ['src/hub/index.ts', 'deploy/hub/dist/hub.mjs'],
]
for (const [entry, out] of targets) {
  await build({
    ...common,
    entryPoints: [path.join(root, entry)],
    outfile: path.join(root, out),
  })
  console.log(`${out}`)
}
