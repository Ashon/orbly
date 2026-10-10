import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

/**
 * Builds the installable macOS app (Pacenote.app) and its release zip. (pnpm
 * package:mac)
 *
 *   node apps/desktop/scripts/package-mac.mjs [--arch arm64|x64]
 *
 * The app carries the UI, the bot bundle, the sandbox job bundle and the
 * sandbox/ files in Contents/Resources/app, so it runs without the repository,
 * Node or pnpm. Config and run history stay outside the app (PACENOTE_HOME,
 * default ~/.pacenote).
 *
 * Output: release/Pacenote-v<version>-macos-<arch>.app.zip with a .sha256
 * sidecar (the Homebrew cask's source, deploy/homebrew; pnpm install:mac
 * unpacks it). The app is assembled in release/staging.noindex, which Spotlight
 * does not index, and removed once zipped, so Spotlight and Launchpad only list
 * the installed Pacenote. The target arch defaults to this Mac's; the other
 * arch's Electron is downloaded, since the bundles themselves are plain JS.
 *
 * The app gets an ad-hoc signature, good for this Mac (pnpm install:mac).
 * Release builds are signed and notarized from this zip outside this
 * repository, with scripts/entitlements.plist for the app and its helper.
 */
if (process.platform !== 'darwin')
  throw new Error('The macOS app can only be built on a Mac.')

const { values: flags } = parseArgs({
  options: { arch: { type: 'string', default: process.arch } },
})
const arch = flags.arch
if (arch !== 'arm64' && arch !== 'x64')
  throw new Error(`Unsupported arch: ${arch}`)

const desktopDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
)
const root = path.resolve(desktopDir, '../..')
const require = createRequire(path.join(desktopDir, 'package.json'))
const { version } = JSON.parse(
  await readFile(path.join(root, 'package.json'), 'utf8')
)
const releaseDir = path.join(root, 'release')
// A ".noindex" directory keeps Spotlight (and so Launchpad) from listing the
// build as an app.
const stagingDir = path.join(releaseDir, 'staging.noindex')
const outputDir = path.join(stagingDir, `mac-${arch}`)
const appPath = path.join(outputDir, 'Pacenote.app')
const resourcesDir = path.join(appPath, 'Contents/Resources')
const appDir = path.join(resourcesDir, 'app')
const zipName = `Pacenote-v${version}-macos-${arch}.app.zip`
const bundleId = 'io.github.ashon.pacenote'

const run = (command, args, options = {}) =>
  execFileSync(command, args, { stdio: 'inherit', ...options })
const plistSet = (file, values) => {
  for (const [key, value] of Object.entries(values)) {
    // Some prebuilt helper bundles lack a key, so delete and add rather than
    // set.
    try {
      execFileSync('/usr/libexec/PlistBuddy', ['-c', `Delete :${key}`, file], {
        stdio: 'ignore',
      })
    } catch {
      // The key was not there.
    }
    run('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${value}`, file])
  }
}

/**
 * Where electronApp() unpacked the other arch's Electron, removed after
 * packaging.
 */
let extractedElectron

/**
 * Electron.app for the target arch: this install's own, or the release zip for
 * the other arch.
 */
async function electronApp() {
  const binary = require('electron')
  if (arch === process.arch) return path.resolve(binary, '../../..')
  // @electron/get is electron's own downloader (checksum-verified, cached).
  const electronRequire = createRequire(require.resolve('electron'))
  const { downloadArtifact } = electronRequire('@electron/get')
  const { version: electronVersion } = electronRequire('./package.json')
  const zip = await downloadArtifact({
    version: electronVersion,
    platform: 'darwin',
    arch,
    artifactName: 'electron',
  })
  const dir = path.join(stagingDir, `electron-${electronVersion}-${arch}`)
  extractedElectron = dir
  await rm(dir, { recursive: true, force: true })
  run('/usr/bin/ditto', ['-x', '-k', zip, dir])
  return path.join(dir, 'Electron.app')
}

// Outputs of pnpm desktop:build (package:mac runs it first)
const inputs = {
  'apps/desktop/dist': 'dist',
  'apps/web/dist': 'web',
  'build/bot': 'bot',
  'build/tools': 'tools',
  sandbox: 'sandbox',
}
const required = [
  'apps/desktop/dist/main.js',
  'apps/web/dist/index.html',
  'build/bot/index.mjs',
  'build/tools/sandbox-job.mjs',
  'build/tools/history-mcp.mjs',
  'sandbox/ops-broker/dist/server.mjs',
]
for (const file of required) {
  if (!existsSync(path.join(root, file)))
    throw new Error(`${file} is missing. Run pnpm desktop:build first.`)
}

await rm(outputDir, { recursive: true, force: true })
await mkdir(outputDir, { recursive: true })
run('/usr/bin/ditto', [await electronApp(), appPath])
await rm(path.join(resourcesDir, 'default_app.asar'), { force: true })
await rm(path.join(resourcesDir, 'electron.icns'), { force: true })
await mkdir(appDir, { recursive: true })
for (const [from, to] of Object.entries(inputs)) {
  await cp(path.join(root, from), path.join(appDir, to), { recursive: true })
}
await writeFile(
  path.join(appDir, 'package.json'),
  `${JSON.stringify({ name: 'pacenote', productName: 'Pacenote', version, type: 'module', main: 'dist/main.js' }, null, 2)}\n`
)

// Icon: the full-bleed icon set drawn from the svg. The system applies the grid
// and effects.
const iconset = path.join(outputDir, 'Pacenote.iconset')
run('/usr/bin/swift', [
  '-module-cache-path',
  path.join(releaseDir, '.swift-cache'),
  path.join(desktopDir, 'scripts/icon.swift'),
  '--iconset',
  iconset,
])
run('/usr/bin/iconutil', [
  '-c',
  'icns',
  iconset,
  '-o',
  path.join(resourcesDir, 'pacenote.icns'),
])
await rm(iconset, { recursive: true, force: true })

const infoPlist = path.join(appPath, 'Contents/Info.plist')
plistSet(infoPlist, {
  CFBundleDisplayName: 'Pacenote',
  CFBundleName: 'Pacenote',
  CFBundleIdentifier: bundleId,
  CFBundleExecutable: 'Pacenote',
  CFBundleIconFile: 'pacenote.icns',
  CFBundleVersion: version,
  CFBundleShortVersionString: version,
  LSApplicationCategoryType: 'public.app-category.developer-tools',
})
try {
  execFileSync(
    '/usr/libexec/PlistBuddy',
    ['-c', 'Delete :ElectronAsarIntegrity', infoPlist],
    {
      stdio: 'ignore',
    }
  )
} catch {
  // The key was not there.
}
await rename(
  path.join(appPath, 'Contents/MacOS/Electron'),
  path.join(appPath, 'Contents/MacOS/Pacenote')
)

const frameworksDir = path.join(appPath, 'Contents/Frameworks')
for (const name of await readdir(frameworksDir)) {
  if (!name.startsWith('Electron Helper') || !name.endsWith('.app')) continue
  const oldName = name.slice(0, -4)
  const newName = oldName.replace('Electron', 'Pacenote')
  const helperDir = path.join(frameworksDir, name)
  const suffix = oldName
    .replace('Electron Helper', '')
    .replace(/[ ()]/g, '')
    .toLowerCase()
  plistSet(path.join(helperDir, 'Contents/Info.plist'), {
    CFBundleDisplayName: newName,
    CFBundleName: newName,
    CFBundleExecutable: newName,
    CFBundleIdentifier: `${bundleId}.helper${suffix ? `.${suffix}` : ''}`,
  })
  await rename(
    path.join(helperDir, 'Contents/MacOS', oldName),
    path.join(helperDir, 'Contents/MacOS', newName)
  )
  await rename(helperDir, path.join(frameworksDir, `${newName}.app`))
}

run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath])
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath])

// ditto rather than zip: it keeps the signature intact.
const zipPath = path.join(releaseDir, zipName)
await rm(zipPath, { force: true })
run('/usr/bin/ditto', [
  '-c',
  '-k',
  '--sequesterRsrc',
  '--keepParent',
  appPath,
  zipPath,
])
const sha256 = createHash('sha256')
  .update(await readFile(zipPath))
  .digest('hex')
await writeFile(`${zipPath}.sha256`, `${sha256}  ${zipName}\n`)
// Only the zip stays: an unpacked Pacenote.app here would show up next to the
// installed one.
await rm(outputDir, { recursive: true, force: true })
if (extractedElectron)
  await rm(extractedElectron, { recursive: true, force: true })
// Fails while staging still holds another arch's build in progress
await rmdir(stagingDir).catch(() => {})
console.log(`\nZip: ${zipPath}\nInstall locally: pnpm install:mac`)
