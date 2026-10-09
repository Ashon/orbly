import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'

/** Directories excluded when any path segment matches */
const DENY_DIRS = new Set([
  '.git',
  '.venv',
  'venv',
  'node_modules',
  '.terraform',
  '__pycache__',
  '.ssh',
  '.gnupg',
  '.aws',
  '.kube',
])

/** File name deny rules. Formats likely to contain secrets */
const DENY_FILES: RegExp[] = [
  /^\.env(\..+)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|tfstate|tfstate\.backup)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(_sk)?$/i,
  /kubeconfig/i,
  /admin\.conf$/i,
  /^\.?(credentials|netrc|npmrc|pypirc)$/i,
  /secret/i,
  /vault[^/]*\.ya?ml$/i,
  /\.token$/i,
]
const ALLOWED_DESPITE_DENY: RegExp[] = [/^\.env\.example$/i]

export const MAX_READ_LINES = 400
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_LINE_CHARS = 2_000
const MAX_LIST_ENTRIES = 300

/** Whether a root-relative path matches the deny rules */
export function isDenied(relativePath: string): boolean {
  const parts = relativePath.split('/').filter(Boolean)
  if (parts.some((part) => DENY_DIRS.has(part))) return true
  const base = parts.at(-1) ?? ''
  if (ALLOWED_DESPITE_DENY.some((pattern) => pattern.test(base))) return false
  return DENY_FILES.some((pattern) => pattern.test(base))
}

/**
 * Exclude globs passed to ripgrep (the same rules as isDenied, applied
 * case-insensitively via --iglob). Globs cannot match the regexes exactly, so
 * filterRgOutput filters search results once more with isDenied.
 */
export const RG_EXCLUDE_GLOBS = [
  ...[...DENY_DIRS].map((dir) => `!**/${dir}/**`),
  '!**/.env',
  '!**/.env.*',
  '!**/*.{pem,key,p12,pfx,jks,keystore,kdbx,tfstate,tfstate.backup,token}',
  '!**/id_{rsa,dsa,ecdsa,ed25519}*',
  '!**/*kubeconfig*',
  '!**/*admin.conf',
  '!**/{credentials,netrc,npmrc,pypirc}',
  '!**/.{credentials,netrc,npmrc,pypirc}',
  '!**/*secret*',
  '!**/*vault*.y*ml',
]

/**
 * ripgrep file filter arguments. In ripgrep a later glob wins over an earlier
 * one, so the requested glob goes first and the exclude globs go after it.
 * (--iglob is applied after --glob regardless of command-line order) This keeps
 * the requested glob from lifting the exclude globs. (e.g. even if glob is
 * **\/.env, .env is not searched)
 */
export function rgFilterArgs(glob?: string): string[] {
  const include = glob?.replace(/^!+/, '')
  return [
    ...(include ? ['--glob', include] : []),
    ...RG_EXCLUDE_GLOBS.flatMap((exclude) => ['--iglob', exclude]),
  ]
}

/**
 * Drops lines for excluded files from ripgrep output and makes paths relative
 * to root. Search results use the --null format (path\0line:content); file
 * lists (--files) have one path per line. Lines that are not paths (exit code,
 * error messages) are kept as is.
 */
export function filterRgOutput(output: string, root: string): string {
  const prefix = `${root.replace(/\/+$/, '')}/`
  return output
    .split('\n')
    .flatMap((line) => {
      const nul = line.indexOf('\0')
      const file = nul >= 0 ? line.slice(0, nul) : line
      if (nul < 0 && !file.startsWith(prefix)) return [line]
      const rel = file.startsWith(prefix) ? file.slice(prefix.length) : file
      if (isDenied(rel)) return []
      return [nul >= 0 ? `${rel}:${line.slice(nul + 1)}` : rel]
    })
    .join('\n')
}

/**
 * Resolves a model-supplied path to a real path inside the root. Rejects
 * absolute paths, parent traversal, symlinks pointing outside the root, and
 * excluded paths.
 */
export async function resolveInRoot(
  root: string,
  requested: string
): Promise<string> {
  let target = requested.trim() || '.'
  if (path.isAbsolute(target)) {
    // Absolute paths under the root (/workspace/...) are accepted after
    // converting them to relative paths.
    const fromRoot = path.relative(root, target)
    if (fromRoot.startsWith('..') || path.isAbsolute(fromRoot)) {
      throw new Error(
        'Specify the path relative to the work root (e.g. my-repo/README.md).'
      )
    }
    target = fromRoot || '.'
  }
  const joined = path.resolve(root, target)
  const rel = path.relative(root, joined)
  if (rel.startsWith('..') || path.isAbsolute(rel))
    throw new Error('Paths outside the work root cannot be viewed.')
  if (rel && isDenied(rel))
    throw new Error(`Access to this path is restricted: ${rel}`)

  const real = await realpath(joined).catch(() => {
    throw new Error(`Path does not exist: ${rel || '.'}`)
  })
  const realRoot = await realpath(root)
  const realRel = path.relative(realRoot, real)
  if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
    throw new Error('The link points outside the work root.')
  }
  if (realRel && isDenied(realRel))
    throw new Error(`Access to this path is restricted: ${realRel}`)
  return real
}

export async function listDir(
  root: string,
  requested: string
): Promise<string> {
  const dir = await resolveInRoot(root, requested)
  const entries = await readdir(dir, { withFileTypes: true })
  const relDir = path.relative(await realpath(root), dir)
  const lines = entries
    .filter((entry) => !isDenied(path.join(relDir, entry.name)))
    .sort(
      (a, b) =>
        Number(b.isDirectory()) - Number(a.isDirectory()) ||
        a.name.localeCompare(b.name)
    )
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
  const shown = lines.slice(0, MAX_LIST_ENTRIES)
  const more =
    lines.length > shown.length
      ? `\n... (${lines.length - shown.length} more)`
      : ''
  return `${relDir || '.'}/\n${shown.join('\n')}${more}`
}

export async function readText(
  root: string,
  requested: string,
  offset = 1,
  limit = MAX_READ_LINES
): Promise<string> {
  const file = await resolveInRoot(root, requested)
  const info = await stat(file)
  if (!info.isFile())
    throw new Error('Not a file. Use fs_list for directories.')
  if (info.size > MAX_FILE_BYTES)
    throw new Error(`File is too large (${info.size} bytes).`)
  const buffer = await readFile(file)
  if (buffer.subarray(0, 8192).includes(0))
    throw new Error('Binary files are not read.')

  const all = buffer.toString('utf8').split('\n')
  const start = Math.max(1, offset)
  const count = Math.min(Math.max(1, limit), MAX_READ_LINES)
  const slice = all.slice(start - 1, start - 1 + count)
  const body = slice
    .map(
      (line, i) =>
        `${start + i}\t${line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}...` : line}`
    )
    .join('\n')
  const end = start - 1 + slice.length
  const tail =
    end < all.length
      ? `\n... (lines ${start}-${end} of ${all.length}, continue with offset)`
      : ''
  return `${path.relative(await realpath(root), file)}\n${body}${tail}`
}
