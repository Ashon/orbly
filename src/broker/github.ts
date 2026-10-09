/**
 * Read-only GitHub lookups. Uses the broker's GitHub token to view only
 * repositories in the allowed orgs (GIT_ALLOWED_OWNERS). The reasoner container
 * has no token and cannot reach GitHub. PR and repository lookups go through
 * these tools only.
 */
export interface RepoRef {
  owner?: string
  repo: string
  number?: number
}

/**
 * Parses owner/repo, owner/repo#123, repo, GitHub URLs (repository, PR), and
 * git remote URLs. When owner is present, checks that it is an allowed org.
 */
export function parseRepoRef(
  input: string,
  allowedOwners: readonly string[]
): RepoRef {
  const text = input.trim()
  const match =
    /^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)?(?:([A-Za-z0-9_.-]+)\/)?([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/pulls?\/(\d+)|#(\d+))?\/?$/.exec(
      text
    )
  if (!match)
    throw new Error(
      `Invalid repository format: ${input} (e.g. ${allowedOwners[0] ?? 'owner'}/repo)`
    )
  const [, owner, repo, pullFromUrl, pullFromHash] = match
  if (
    owner &&
    !allowedOwners.some((o) => o.toLowerCase() === owner.toLowerCase())
  ) {
    throw new Error(
      `Org is not allowed for lookup: ${owner} (allowed: ${allowedOwners.join(', ')})`
    )
  }
  const number = pullFromUrl ?? pullFromHash
  return { owner, repo: repo!, number: number ? Number(number) : undefined }
}

/**
 * Restricts a search query to the allowed orgs.
 * Adds org: when there is no repo:, org:, or user: qualifier, and rejects
 * qualifiers that point to other orgs.
 */
export function scopeSearchQuery(
  query: string,
  allowedOwners: readonly string[]
): string {
  const allowed = allowedOwners.map((o) => o.toLowerCase())
  let scoped = false
  for (const match of query.matchAll(
    /(?:^|\s)(repo|org|user|owner):("?)([^\s"]+)\2/gi
  )) {
    const kind = match[1]!.toLowerCase()
    const value = match[3]!
    const owner = (kind === 'repo' ? value.split('/')[0]! : value).toLowerCase()
    if (!allowed.includes(owner)) {
      throw new Error(
        `Org is not allowed for lookup: ${value} (allowed: ${allowedOwners.join(', ')})`
      )
    }
    scoped = true
  }
  const trimmed = query.trim()
  return scoped
    ? trimmed
    : `${trimmed} ${allowedOwners.map((o) => `org:${o}`).join(' ')}`.trim()
}

const day = (iso?: string | null) => (iso ? iso.slice(0, 10) : '-')

interface Pull {
  number: number
  title: string
  state: string
  draft?: boolean
  merged_at?: string | null
  user?: { login: string } | null
  created_at: string
  updated_at: string
  html_url: string
  head: { ref: string; sha: string }
  base: { ref: string }
  labels?: { name: string }[]
  body?: string | null
  additions?: number
  deletions?: number
  changed_files?: number
  commits?: number
  mergeable_state?: string
  requested_reviewers?: { login: string }[]
}

export function formatPullLine(pull: Pull): string {
  const state = pull.merged_at ? 'merged' : pull.draft ? 'draft' : pull.state
  const labels = pull.labels?.length
    ? ` [${pull.labels.map((l) => l.name).join(', ')}]`
    : ''
  return (
    `#${pull.number} ${pull.title} (@${pull.user?.login ?? '?'}, ${state}, ` +
    `${pull.head.ref} -> ${pull.base.ref}, created ${day(pull.created_at)}, updated ${day(pull.updated_at)})${labels}`
  )
}

interface Review {
  user?: { login: string } | null
  state: string
  submitted_at?: string
}
interface CheckRun {
  name: string
  status: string
  conclusion: string | null
}
interface PullFile {
  filename: string
  status: string
  additions: number
  deletions: number
}

const FILE_STATUS: Record<string, string> = {
  added: 'A',
  removed: 'D',
  modified: 'M',
  renamed: 'R',
  copied: 'C',
  changed: 'M',
}

export function formatPullDetail(
  slug: string,
  pull: Pull,
  reviews: Review[],
  checks: CheckRun[],
  files: PullFile[],
  bodyLimit = 4_000
): string {
  const state = pull.merged_at
    ? `merged (${day(pull.merged_at)})`
    : pull.draft
      ? 'open (draft)'
      : pull.state
  // Keeps only each person's latest review. (COMMENTED does not overwrite
  // another state)
  const latest = new Map<string, Review>()
  for (const review of reviews) {
    const login = review.user?.login ?? '?'
    if (review.state === 'COMMENTED' && latest.has(login)) continue
    latest.set(login, review)
  }
  const conclusions = new Map<string, string[]>()
  for (const check of checks) {
    const key =
      check.status !== 'completed'
        ? 'in progress'
        : (check.conclusion ?? 'unknown')
    conclusions.set(key, [...(conclusions.get(key) ?? []), check.name])
  }
  const lines = [
    `${slug}#${pull.number} ${pull.title}`,
    `State: ${state}, author @${pull.user?.login ?? '?'}, created ${day(pull.created_at)}, updated ${day(pull.updated_at)}`,
    `Branch: ${pull.head.ref} -> ${pull.base.ref}, commits ${pull.commits ?? '?'}, files ${pull.changed_files ?? files.length}, +${pull.additions ?? '?'} -${pull.deletions ?? '?'}` +
      (pull.mergeable_state ? `, mergeable state ${pull.mergeable_state}` : ''),
  ]
  if (pull.labels?.length)
    lines.push(`Labels: ${pull.labels.map((l) => l.name).join(', ')}`)
  if (pull.requested_reviewers?.length) {
    lines.push(
      `Requested reviewers: ${pull.requested_reviewers.map((r) => `@${r.login}`).join(', ')}`
    )
  }
  lines.push(
    `Reviews: ${latest.size ? [...latest].map(([login, r]) => `@${login} ${r.state}`).join(', ') : 'none'}`
  )
  lines.push(
    `Checks: ${conclusions.size ? [...conclusions].map(([k, names]) => `${k} ${names.length}${k === 'success' ? '' : ` (${names.slice(0, 5).join(', ')})`}`).join(', ') : 'none'}`
  )
  lines.push(`Link: ${pull.html_url}`)
  const body = (pull.body ?? '').trim()
  lines.push(
    '',
    'Body:',
    body
      ? body.length > bodyLimit
        ? `${body.slice(0, bodyLimit)}\n... (body truncated, ${body.length} characters total)`
        : body
      : '(none)'
  )
  if (files.length) {
    lines.push(
      '',
      `Changed files (${files.length}${files.length >= 100 ? ', first 100' : ''}):`
    )
    for (const file of files) {
      lines.push(
        `${FILE_STATUS[file.status] ?? '?'} ${file.filename} (+${file.additions} -${file.deletions})`
      )
    }
  }
  return lines.join('\n')
}

/**
 * Keeps only the parts of a unified diff for files whose path starts with path.
 */
export function filterDiff(diff: string, path: string): string {
  const parts = diff.split(/(?=^diff --git )/m)
  const picked = parts.filter((part) => {
    const header = part.split('\n', 1)[0] ?? ''
    return header.includes(` a/${path}`) || header.includes(` b/${path}`)
  })
  return picked.join('')
}

export interface GitHubReaderOptions {
  token: string
  allowedOwners: string[]
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export class GitHubReader {
  private readonly repoCache = new Map<string, string>()

  constructor(private readonly options: GitHubReaderOptions) {}

  get owners(): string[] {
    return this.options.allowedOwners
  }

  async searchRepos(query: string, limit = 10): Promise<string> {
    const q = scopeSearchQuery(query, this.owners)
    const data = await this.json<{
      total_count: number
      items: {
        full_name: string
        private: boolean
        archived: boolean
        description: string | null
        pushed_at: string
        default_branch: string
      }[]
    }>(
      `/search/repositories?q=${encodeURIComponent(q)}&sort=updated&per_page=${clamp(limit, 1, 30)}`
    )
    if (data.items.length === 0) return `No repositories found. (query: ${q})`
    return [
      `${data.items.length} of ${data.total_count} ${data.total_count === 1 ? 'repository' : 'repositories'} (query: ${q})`,
      ...data.items.map(
        (r) =>
          `${r.full_name}${r.private ? ' (private)' : ''}${r.archived ? ' (archived)' : ''} - default branch ${r.default_branch}, last push ${day(r.pushed_at)}` +
          (r.description ? `\n  ${r.description}` : '')
      ),
    ].join('\n')
  }

  async listPulls(
    repoInput: string,
    state: 'open' | 'closed' | 'all',
    limit = 20
  ): Promise<string> {
    const slug = await this.resolve(repoInput)
    const pulls = await this.json<Pull[]>(
      `/repos/${slug}/pulls?state=${state}&sort=created&direction=desc&per_page=${clamp(limit, 1, 50)}`
    )
    const label = { open: 'open', closed: 'closed', all: 'open or closed' }[
      state
    ]
    if (pulls.length === 0) return `${slug}: no ${label} PRs.`
    return [
      `${slug}: ${pulls.length} ${label} ${pulls.length === 1 ? 'PR' : 'PRs'} (newest first)`,
      ...pulls.map(formatPullLine),
    ].join('\n')
  }

  async searchPulls(query: string, limit = 20): Promise<string> {
    const q = scopeSearchQuery(
      /\bis:pr\b/.test(query) ? query : `${query} is:pr`,
      this.owners
    )
    const data = await this.json<{
      total_count: number
      items: {
        number: number
        title: string
        state: string
        draft?: boolean
        user?: { login: string }
        created_at: string
        updated_at: string
        repository_url: string
        pull_request?: { merged_at?: string | null }
      }[]
    }>(
      `/search/issues?q=${encodeURIComponent(q)}&sort=created&order=desc&per_page=${clamp(limit, 1, 50)}`
    )
    if (data.items.length === 0) return `No PRs found. (query: ${q})`
    return [
      `${data.items.length} of ${data.total_count} ${data.total_count === 1 ? 'PR' : 'PRs'} (query: ${q}, newest first)`,
      ...data.items.map((item) => {
        const repo = item.repository_url.split('/repos/')[1] ?? '?'
        const state = item.pull_request?.merged_at
          ? 'merged'
          : item.draft
            ? 'draft'
            : item.state
        return `${repo}#${item.number} ${item.title} (@${item.user?.login ?? '?'}, ${state}, created ${day(item.created_at)}, updated ${day(item.updated_at)})`
      }),
    ].join('\n')
  }

  async viewPull(repoInput: string, number?: number): Promise<string> {
    const { slug, number: n } = await this.resolvePull(repoInput, number)
    const pull = await this.json<Pull>(`/repos/${slug}/pulls/${n}`)
    const [reviews, checks, files] = await Promise.all([
      this.json<Review[]>(
        `/repos/${slug}/pulls/${n}/reviews?per_page=100`
      ).catch(() => []),
      this.json<{ check_runs: CheckRun[] }>(
        `/repos/${slug}/commits/${pull.head.sha}/check-runs?per_page=100`
      )
        .then((r) => r.check_runs)
        .catch(() => []),
      this.json<PullFile[]>(
        `/repos/${slug}/pulls/${n}/files?per_page=100`
      ).catch(() => []),
    ])
    return formatPullDetail(slug, pull, reviews, checks, files)
  }

  async pullDiff(
    repoInput: string,
    number?: number,
    path?: string
  ): Promise<string> {
    const { slug, number: n } = await this.resolvePull(repoInput, number)
    const diff = await this.text(
      `/repos/${slug}/pulls/${n}`,
      'application/vnd.github.diff'
    )
    if (!path) return diff || '(no changes)'
    const picked = filterDiff(diff, path)
    return (
      picked ||
      `No changes for ${path}. Check the changed file list from gh_pr_view.`
    )
  }

  private async resolvePull(
    repoInput: string,
    number?: number
  ): Promise<{ slug: string; number: number }> {
    const ref = parseRepoRef(repoInput, this.owners)
    const n = number ?? ref.number
    if (!n)
      throw new Error('A PR number is required (number or owner/repo#number).')
    return { slug: await this.resolve(repoInput), number: n }
  }

  /** When owner is missing, tries each allowed org in turn. */
  private async resolve(repoInput: string): Promise<string> {
    const ref = parseRepoRef(repoInput, this.owners)
    if (ref.owner) return `${ref.owner}/${ref.repo}`
    const cached = this.repoCache.get(ref.repo.toLowerCase())
    if (cached) return cached
    for (const owner of this.owners) {
      const found = await this.json<{ full_name: string }>(
        `/repos/${owner}/${ref.repo}`
      ).catch(() => undefined)
      if (found) {
        this.repoCache.set(ref.repo.toLowerCase(), found.full_name)
        return found.full_name
      }
    }
    const similar = await this.searchRepos(ref.repo, 5).catch(() => '')
    throw new Error(
      `Repository ${ref.repo} not found in ${this.owners.join(', ')}.` +
        (similar && !similar.startsWith('No repositories found')
          ? `\nSimilar repositories:\n${similar}`
          : '')
    )
  }

  private async json<T>(path: string): Promise<T> {
    return JSON.parse(await this.text(path, 'application/vnd.github+json')) as T
  }

  private async text(path: string, accept: string): Promise<string> {
    const res = await (this.options.fetchImpl ?? fetch)(
      `https://api.github.com${path}`,
      {
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          Accept: accept,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'pacenote-ops-broker',
        },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 20_000),
      }
    )
    const body = await res.text()
    if (!res.ok) {
      let message = body.slice(0, 300)
      try {
        message = (JSON.parse(body) as { message?: string }).message ?? message
      } catch {
        // Uses the body as is when it is not JSON.
      }
      if (res.status === 404)
        throw new Error(`Not found (404): ${path.split('?')[0]}`)
      if (
        res.status === 403 &&
        res.headers.get('x-ratelimit-remaining') === '0'
      ) {
        throw new Error('GitHub API rate limit exceeded. Try again shortly.')
      }
      throw new Error(`GitHub API error ${res.status}: ${message}`)
    }
    return body
  }
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(Math.trunc(value), min), max)
