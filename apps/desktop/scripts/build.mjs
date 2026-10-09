import { cp, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const desktopDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
)
const assetsDir = path.resolve(desktopDir, '../../assets')
const distDir = path.join(desktopDir, 'dist')
await rm(distDir, { recursive: true, force: true })
await mkdir(distDir, { recursive: true })

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  logLevel: 'info',
}
await build({
  ...common,
  entryPoints: [path.join(desktopDir, 'src/main.ts')],
  outfile: path.join(distDir, 'main.js'),
  external: ['electron'],
  format: 'esm',
})
await build({
  ...common,
  entryPoints: [path.join(desktopDir, 'src/preload.ts')],
  outfile: path.join(distDir, 'preload.cjs'),
  external: ['electron'],
  format: 'cjs',
})
// The tray uses the transparent mark fitted to its square (18pt, Retina @2x,
// drawn from assets/pacenote.svg by icon.swift) The dock/window icon is the app
// icon fitted to the macOS icon grid (assets/pacenote-icon.svg, pnpm --filter
// @pacenote/desktop icon)
await cp(
  path.join(assetsDir, 'pacenote-tray.png'),
  path.join(distDir, 'tray.png')
)
await cp(
  path.join(assetsDir, 'pacenote-tray@2x.png'),
  path.join(distDir, 'tray@2x.png')
)
await cp(
  path.join(assetsDir, 'pacenote-icon.png'),
  path.join(distDir, 'icon.png')
)
// Dev runs (Pacenote Dev) use the same icon with a DEV tag
await cp(
  path.join(assetsDir, 'pacenote-icon-dev.png'),
  path.join(distDir, 'icon-dev.png')
)
