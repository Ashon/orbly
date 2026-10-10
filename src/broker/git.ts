import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { ProcessExitError, runProcess } from '../sandbox/process.js'
import { isDenied } from './fs.js'
import { redactSecrets } from './redact.js'

/**
 * Git workspaces for the agent. The user's local working tree is never touched.
 * - Clones the remote repository as a bare mirror into a broker-only volume
 *   (/work) and creates a new-branch worktree per task.
 * - File edits happen only inside the worktree; the broker runs commit/push/PR
 *   only when the policy check passes.
 * - The GitHub token lives only in this process's environment variables and is
 *   never exposed to the model.
 */

export const BRANCH_PREFIX = 'pacenote/'
/**
 * Branches made before the renames (Orbly, Verda). Still recognized as the
 * agent's own, but never created.
 */
export const LEGACY_BRANCH_PREFIXES = ['orbly/', 'verda/']

/**
 * Whether a branch is one the agent made: pacenote/*, or orbly/* and verda/*
 * from before the renames
 */
export function isAgentBranch(branch: string): boolean {
  return [BRANCH_PREFIX, ...LEGACY_BRANCH_PREFIXES].some((prefix) =>
    branch.startsWith(prefix)
  )
}
const MAX_WRITE_BYTES = 512 * 1024
const MAX_CHANGED_FILES = 50
const MAX_CHANGED_LINES = 3_000
const MAX_PRS_PER_HOUR = 10
const WORKSPACE_TTL_MS = 24 * 3_600_000

/**
 * Paths the agent cannot change. CI configuration changes are made by humans.
 */
const PROTECTED_PATHS: RegExp[] = [/^\.github\/workflows\//, /^\.gitmodules$/]

export interface RepoSlug {
  owner: string
  repo: string
}

/**
 * Accepts only the git@github.com:o/r(.git) and https://github.com/o/r(.git)
 * formats.
 */
export function parseGithubRemote(url: string): RepoSlug | undefined {
  const match =
    /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(
      url.trim()
    )
  return match ? { owner: match[1]!, repo: match[2]! } : undefined
}

/**
 * Replaces old with new. Rejects when old is missing (0 matches) or appears
 * more than once without replaceAll.
 */
export function applyEdit(
  content: string,
  oldText: string,
  newText: string,
  replaceAll = false
): string {
  if (!oldText) throw new Error('old_string is empty.')
  const count = content.split(oldText).length - 1
  if (count === 0)
    throw new Error(
      'old_string was not found in the file. Check the exact content with ws_read.'
    )
  if (count > 1 && !replaceAll) {
    throw new Error(
      `old_string appears ${count} times. Include more surrounding text or use replace_all.`
    )
  }
  return replaceAll
    ? content.split(oldText).join(newText)
    : content.replace(oldText, () => newText)
}

/** Policy check before a PR. Returns the list of problems. */
export function reviewChanges(
  files: string[],
  diff: string,
  addedLines: number
): string[] {
  const problems: string[] = []
  if (files.length === 0) problems.push('There are no changes.')
  if (files.length > MAX_CHANGED_FILES)
    problems.push(
      `Too many changed files (${files.length} > ${MAX_CHANGED_FILES}).`
    )
  if (addedLines > MAX_CHANGED_LINES)
    problems.push(
      `Too many changed lines (${addedLines} > ${MAX_CHANGED_LINES}).`
    )
  for (const file of files) {
    if (isDenied(file))
      problems.push(`Cannot change a restricted path: ${file}`)
    if (PROTECTED_PATHS.some((p) => p.test(file)))
      problems.push(`Protected path (must be changed by a human): ${file}`)
  }
  if (redactSecrets(diff) !== diff)
    problems.push('The diff contains what looks like a secret.')
  return problems
}

interface Workspace {
  id: string
  dir: string
  slug: RepoSlug
  branch: string
  base: string
  createdAt: number
  prUrl?: string
}

export interface GitWorkspaceOptions {
  /**
   * Local repository root (read-only mount). Remote URLs are looked up by
   * repository name.
   */
  localRoot: string
  /** Writable directory that holds mirrors and worktrees */
  workRoot: string
  token: string
  authorName: string
  authorEmail: string
  allowedOwners: string[]
  timeoutMs: number
}

export class GitWorkspaces {
  private readonly workspaces = new Map<string, Workspace>()
  private readonly prTimes: number[] = []

  constructor(private readonly options: GitWorkspaceOptions) {}

  private gitEnv(): NodeJS.ProcessEnv {
    const basic = Buffer.from(`x-access-token:${this.options.token}`).toString(
      'base64'
    )
    return {
      PATH: process.env.PATH,
      HOME: '/tmp',
      GIT_TERMINAL_PROMPT: '0',
      // Passes the token only through this process environment, never via
      // arguments or config files.
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
      GIT_CONFIG_KEY_1: 'safe.directory',
      GIT_CONFIG_VALUE_1: '*',
      GIT_AUTHOR_NAME: this.options.authorName,
      GIT_AUTHOR_EMAIL: this.options.authorEmail,
      GIT_COMMITTER_NAME: this.options.authorName,
      GIT_COMMITTER_EMAIL: this.options.authorEmail,
    }
  }

  private async git(args: string[], cwd = '/tmp'): Promise<string> {
    try {
      const { stdout } = await runProcess('git', args, {
        cwd,
        input: '',
        timeoutMs: this.options.timeoutMs,
        env: this.gitEnv(),
      })
      return stdout
    } catch (err) {
      if (err instanceof ProcessExitError) {
        throw new Error(
          `git ${args[0]} failed: ${redactSecrets(err.stderr.trim()).slice(-500)}`,
          { cause: err }
        )
      }
      throw err
    }
  }

  /**
   * Finds the GitHub remote by local repository directory name and checks that
   * its owner is allowed.
   */
  async resolveRepo(name: string): Promise<RepoSlug> {
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || name.startsWith('.')) {
      throw new Error(`Invalid repository name format: ${name}`)
    }
    const local = path.join(this.options.localRoot, name)
    if (!existsSync(path.join(local, '.git'))) {
      throw new Error(`No local git repository: ${name} (check with fs_list)`)
    }
    const url = (
      await this.git(['-C', local, 'remote', 'get-url', 'origin']).catch(() => {
        throw new Error(`Repository has no origin remote: ${name}`)
      })
    ).trim()
    const slug = parseGithubRemote(url)
    if (!slug) throw new Error(`Not a GitHub remote: ${name}`)
    const allowed = this.options.allowedOwners.map((o) => o.toLowerCase())
    if (!allowed.includes(slug.owner.toLowerCase())) {
      throw new Error(
        `Repository is not in an allowed org: ${slug.owner}/${slug.repo}`
      )
    }
    return slug
  }

  /**
   * Creates a new-branch workspace from the remote default branch (or base).
   */
  async prepare(name: string, base?: string): Promise<Workspace> {
    await this.cleanupExpired()
    const slug = await this.resolveRepo(name)
    if (base !== undefined && !/^[A-Za-z0-9._/-]{1,100}$/.test(base)) {
      throw new Error(`Invalid base branch name format: ${base}`)
    }
    const mirror = path.join(
      this.options.workRoot,
      'mirrors',
      `${slug.owner}__${slug.repo}.git`
    )
    const url = `https://github.com/${slug.owner}/${slug.repo}.git`
    if (!existsSync(mirror)) {
      await mkdir(path.dirname(mirror), { recursive: true })
      await this.git(['clone', '--bare', '--filter=blob:none', url, mirror])
    } else {
      await this.git([
        '-C',
        mirror,
        'fetch',
        '--prune',
        'origin',
        '+refs/heads/*:refs/heads/*',
      ])
      await this.git(['-C', mirror, 'worktree', 'prune'])
    }
    const baseBranch =
      base ??
      (await this.git(['-C', mirror, 'symbolic-ref', '--short', 'HEAD'])).trim()

    const id = randomBytes(4).toString('hex')
    const date = new Date().toISOString().slice(0, 10).replaceAll('-', '')
    const branch = `${BRANCH_PREFIX}${date}-${id}`
    const dir = path.join(this.options.workRoot, 'ws', id)
    await mkdir(path.dirname(dir), { recursive: true })
    await this.git([
      '-C',
      mirror,
      'worktree',
      'add',
      '-b',
      branch,
      dir,
      baseBranch,
    ])

    const workspace: Workspace = {
      id,
      dir,
      slug,
      branch,
      base: baseBranch,
      createdAt: Date.now(),
    }
    this.workspaces.set(id, workspace)
    return workspace
  }

  get(id: string): Workspace {
    const workspace = this.workspaces.get(id)
    if (!workspace)
      throw new Error(
        `Workspace not found: ${id} (create one with ws_prepare first)`
      )
    return workspace
  }

  /**
   * Write target path inside the workspace. New files are allowed, but paths
   * outside the root, restricted paths, and protected paths are rejected.
   */
  private target(
    workspace: Workspace,
    requested: string
  ): { abs: string; rel: string } {
    const rel = path.posix.normalize(requested.trim().replace(/^\/+/, ''))
    if (!rel || rel === '.' || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error('Specify a path relative to the workspace.')
    }
    if (isDenied(rel)) throw new Error(`Restricted path: ${rel}`)
    if (PROTECTED_PATHS.some((p) => p.test(rel)))
      throw new Error(`Protected path: ${rel}`)
    return { abs: path.join(workspace.dir, rel), rel }
  }

  async write(id: string, requested: string, content: string): Promise<string> {
    const workspace = this.get(id)
    const { abs, rel } = this.target(workspace, requested)
    if (Buffer.byteLength(content) > MAX_WRITE_BYTES)
      throw new Error('File is too large.')
    await mkdir(path.dirname(abs), { recursive: true })
    await writeFile(abs, content)
    return `Wrote: ${rel} (${Buffer.byteLength(content)} bytes)`
  }

  async edit(
    id: string,
    requested: string,
    oldText: string,
    newText: string,
    replaceAll?: boolean
  ): Promise<string> {
    const workspace = this.get(id)
    const { abs, rel } = this.target(workspace, requested)
    const content = await readFile(abs, 'utf8').catch(() => {
      throw new Error(`File not found: ${rel}`)
    })
    await writeFile(abs, applyEdit(content, oldText, newText, replaceAll))
    return `Edited: ${rel}`
  }

  async remove(id: string, requested: string): Promise<string> {
    const workspace = this.get(id)
    const { abs, rel } = this.target(workspace, requested)
    if (!(await stat(abs).catch(() => undefined))?.isFile())
      throw new Error(`File not found: ${rel}`)
    await unlink(abs)
    return `Deleted: ${rel}`
  }

  async diff(id: string): Promise<string> {
    const workspace = this.get(id)
    await this.git(['add', '--all'], workspace.dir)
    const stat = await this.git(['diff', '--cached', '--stat'], workspace.dir)
    const diff = await this.git(['diff', '--cached'], workspace.dir)
    return `${workspace.slug.owner}/${workspace.slug.repo} ${workspace.branch} (base ${workspace.base})\n${stat}\n${diff}`
  }

  async createPullRequest(
    id: string,
    title: string,
    body: string
  ): Promise<string> {
    const workspace = this.get(id)
    if (workspace.prUrl) return `A PR already exists: ${workspace.prUrl}`
    const now = Date.now()
    while (this.prTimes.length && now - this.prTimes[0]! > 3_600_000)
      this.prTimes.shift()
    if (this.prTimes.length >= MAX_PRS_PER_HOUR)
      throw new Error('Hourly PR creation limit exceeded.')
    if (!title.trim() || title.length > 200)
      throw new Error('PR title must be 1-200 characters.')

    await this.git(['add', '--all'], workspace.dir)
    const files = (
      await this.git(['diff', '--cached', '--name-only'], workspace.dir)
    )
      .split('\n')
      .filter(Boolean)
    const diff = await this.git(['diff', '--cached'], workspace.dir)
    const added = diff
      .split('\n')
      .filter((l) => l.startsWith('+') && !l.startsWith('+++')).length
    const problems = reviewChanges(files, diff, added)
    if (problems.length > 0)
      throw new Error(`Cannot create the PR:\n- ${problems.join('\n- ')}`)

    await this.git(['commit', '--quiet', '-m', title.trim()], workspace.dir)
    if (!isAgentBranch(workspace.branch))
      throw new Error('Not an agent branch.')
    await this.git(
      ['push', 'origin', `HEAD:refs/heads/${workspace.branch}`],
      workspace.dir
    )

    const res = await fetch(
      `https://api.github.com/repos/${workspace.slug.owner}/${workspace.slug.repo}/pulls`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({
          title: title.trim(),
          head: workspace.branch,
          base: workspace.base,
          body: `${body.trim()}\n\n---\n_This draft PR was written by Pace (Pacenote) from a Slack request. It needs review before merging._`,
          draft: true,
        }),
      }
    )
    const json = (await res.json()) as { html_url?: string; message?: string }
    if (!res.ok || !json.html_url) {
      throw new Error(
        `PR creation failed (${res.status}): ${json.message ?? ''} (branch ${workspace.branch} was pushed)`
      )
    }
    this.prTimes.push(now)
    workspace.prUrl = json.html_url
    return `Created draft PR: ${json.html_url} (${files.length} ${files.length === 1 ? 'file' : 'files'})`
  }

  /** Cleans up old workspaces. */
  private async cleanupExpired(): Promise<void> {
    const now = Date.now()
    for (const [id, workspace] of this.workspaces) {
      if (now - workspace.createdAt < WORKSPACE_TTL_MS) continue
      await rm(workspace.dir, { recursive: true, force: true })
      this.workspaces.delete(id)
    }
    // Also cleans up workspace directories whose records were lost when the
    // broker restarted.
    const wsRoot = path.join(this.options.workRoot, 'ws')
    for (const name of await readdir(wsRoot).catch(() => [] as string[])) {
      if (this.workspaces.has(name)) continue
      const info = await stat(path.join(wsRoot, name)).catch(() => undefined)
      if (info && now - info.mtimeMs > WORKSPACE_TTL_MS) {
        await rm(path.join(wsRoot, name), { recursive: true, force: true })
      }
    }
  }
}
