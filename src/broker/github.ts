/**
 * GitHub 읽기 전용 조회. broker 의 GitHub 토큰으로 허용된 조직(GIT_ALLOWED_OWNERS)의 저장소만 본다.
 * 추론 컨테이너에는 토큰이 없고 GitHub 로 나갈 수도 없다. PR, 저장소 조회는 이 도구로만 한다.
 */
export interface RepoRef {
  owner?: string;
  repo: string;
  number?: number;
}

/**
 * owner/repo, owner/repo#123, repo, GitHub URL(저장소, PR), git 원격 주소를 읽는다.
 * owner 가 있으면 허용된 조직인지 확인한다.
 */
export function parseRepoRef(input: string, allowedOwners: readonly string[]): RepoRef {
  const text = input.trim();
  const match =
    /^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)?(?:([A-Za-z0-9_.-]+)\/)?([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/pulls?\/(\d+)|#(\d+))?\/?$/.exec(
      text
    );
  if (!match)
    throw new Error(
      `저장소 형식이 아닙니다: ${input} (예: ${allowedOwners[0] ?? "owner"}/repo)`
    );
  const [, owner, repo, pullFromUrl, pullFromHash] = match;
  if (owner && !allowedOwners.some((o) => o.toLowerCase() === owner.toLowerCase())) {
    throw new Error(
      `조회할 수 없는 조직입니다: ${owner} (허용: ${allowedOwners.join(", ")})`
    );
  }
  const number = pullFromUrl ?? pullFromHash;
  return { owner, repo: repo!, number: number ? Number(number) : undefined };
}

/**
 * 검색어의 범위를 허용된 조직으로 제한한다.
 * repo:, org:, user: 한정자가 없으면 org: 를 붙이고, 허용되지 않은 조직을 가리키면 거부한다.
 */
export function scopeSearchQuery(
  query: string,
  allowedOwners: readonly string[]
): string {
  const allowed = allowedOwners.map((o) => o.toLowerCase());
  let scoped = false;
  for (const match of query.matchAll(/(?:^|\s)(repo|org|user|owner):("?)([^\s"]+)\2/gi)) {
    const kind = match[1]!.toLowerCase();
    const value = match[3]!;
    const owner = (kind === "repo" ? value.split("/")[0]! : value).toLowerCase();
    if (!allowed.includes(owner)) {
      throw new Error(
        `조회할 수 없는 조직입니다: ${value} (허용: ${allowedOwners.join(", ")})`
      );
    }
    scoped = true;
  }
  const trimmed = query.trim();
  return scoped
    ? trimmed
    : `${trimmed} ${allowedOwners.map((o) => `org:${o}`).join(" ")}`.trim();
}

const day = (iso?: string | null) => (iso ? iso.slice(0, 10) : "-");

interface Pull {
  number: number;
  title: string;
  state: string;
  draft?: boolean;
  merged_at?: string | null;
  user?: { login: string } | null;
  created_at: string;
  updated_at: string;
  html_url: string;
  head: { ref: string; sha: string };
  base: { ref: string };
  labels?: { name: string }[];
  body?: string | null;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  commits?: number;
  mergeable_state?: string;
  requested_reviewers?: { login: string }[];
}

export function formatPullLine(pull: Pull): string {
  const state = pull.merged_at ? "merged" : pull.draft ? "draft" : pull.state;
  const labels = pull.labels?.length
    ? ` [${pull.labels.map((l) => l.name).join(", ")}]`
    : "";
  return (
    `#${pull.number} ${pull.title} (@${pull.user?.login ?? "?"}, ${state}, ` +
    `${pull.head.ref} -> ${pull.base.ref}, 생성 ${day(pull.created_at)}, 갱신 ${day(pull.updated_at)})${labels}`
  );
}

interface Review {
  user?: { login: string } | null;
  state: string;
  submitted_at?: string;
}
interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}
interface PullFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
}

const FILE_STATUS: Record<string, string> = {
  added: "A",
  removed: "D",
  modified: "M",
  renamed: "R",
  copied: "C",
  changed: "M",
};

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
      ? "open (draft)"
      : pull.state;
  // 사람마다 마지막 리뷰만 남긴다. (COMMENTED 는 다른 상태가 있으면 덮어쓰지 않는다)
  const latest = new Map<string, Review>();
  for (const review of reviews) {
    const login = review.user?.login ?? "?";
    if (review.state === "COMMENTED" && latest.has(login)) continue;
    latest.set(login, review);
  }
  const conclusions = new Map<string, string[]>();
  for (const check of checks) {
    const key =
      check.status !== "completed" ? "진행 중" : (check.conclusion ?? "unknown");
    conclusions.set(key, [...(conclusions.get(key) ?? []), check.name]);
  }
  const lines = [
    `${slug}#${pull.number} ${pull.title}`,
    `상태: ${state}, 작성자 @${pull.user?.login ?? "?"}, 생성 ${day(pull.created_at)}, 갱신 ${day(pull.updated_at)}`,
    `브랜치: ${pull.head.ref} -> ${pull.base.ref}, 커밋 ${pull.commits ?? "?"}, 파일 ${pull.changed_files ?? files.length}, +${pull.additions ?? "?"} -${pull.deletions ?? "?"}` +
      (pull.mergeable_state ? `, 병합 상태 ${pull.mergeable_state}` : ""),
  ];
  if (pull.labels?.length)
    lines.push(`라벨: ${pull.labels.map((l) => l.name).join(", ")}`);
  if (pull.requested_reviewers?.length) {
    lines.push(
      `리뷰 요청: ${pull.requested_reviewers.map((r) => `@${r.login}`).join(", ")}`
    );
  }
  lines.push(
    `리뷰: ${latest.size ? [...latest].map(([login, r]) => `@${login} ${r.state}`).join(", ") : "없음"}`
  );
  lines.push(
    `체크: ${conclusions.size ? [...conclusions].map(([k, names]) => `${k} ${names.length}${k === "success" ? "" : ` (${names.slice(0, 5).join(", ")})`}`).join(", ") : "없음"}`
  );
  lines.push(`링크: ${pull.html_url}`);
  const body = (pull.body ?? "").trim();
  lines.push(
    "",
    "본문:",
    body
      ? body.length > bodyLimit
        ? `${body.slice(0, bodyLimit)}\n... (본문 ${body.length}자 중 앞부분)`
        : body
      : "(없음)"
  );
  if (files.length) {
    lines.push(
      "",
      `변경 파일 (${files.length}개${files.length >= 100 ? ", 앞 100개" : ""}):`
    );
    for (const file of files) {
      lines.push(
        `${FILE_STATUS[file.status] ?? "?"} ${file.filename} (+${file.additions} -${file.deletions})`
      );
    }
  }
  return lines.join("\n");
}

/** unified diff 에서 path 로 시작하는 파일 부분만 남긴다. */
export function filterDiff(diff: string, path: string): string {
  const parts = diff.split(/(?=^diff --git )/m);
  const picked = parts.filter((part) => {
    const header = part.split("\n", 1)[0] ?? "";
    return header.includes(` a/${path}`) || header.includes(` b/${path}`);
  });
  return picked.join("");
}

export interface GitHubReaderOptions {
  token: string;
  allowedOwners: string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class GitHubReader {
  private readonly repoCache = new Map<string, string>();

  constructor(private readonly options: GitHubReaderOptions) {}

  get owners(): string[] {
    return this.options.allowedOwners;
  }

  async searchRepos(query: string, limit = 10): Promise<string> {
    const q = scopeSearchQuery(query, this.owners);
    const data = await this.json<{
      total_count: number;
      items: {
        full_name: string;
        private: boolean;
        archived: boolean;
        description: string | null;
        pushed_at: string;
        default_branch: string;
      }[];
    }>(
      `/search/repositories?q=${encodeURIComponent(q)}&sort=updated&per_page=${clamp(limit, 1, 30)}`
    );
    if (data.items.length === 0) return `저장소를 찾지 못했습니다. (검색어: ${q})`;
    return [
      `저장소 ${data.total_count}개 중 ${data.items.length}개 (검색어: ${q})`,
      ...data.items.map(
        (r) =>
          `${r.full_name}${r.private ? " (private)" : ""}${r.archived ? " (archived)" : ""} - 기본 브랜치 ${r.default_branch}, 최근 push ${day(r.pushed_at)}` +
          (r.description ? `\n  ${r.description}` : "")
      ),
    ].join("\n");
  }

  async listPulls(
    repoInput: string,
    state: "open" | "closed" | "all",
    limit = 20
  ): Promise<string> {
    const slug = await this.resolve(repoInput);
    const pulls = await this.json<Pull[]>(
      `/repos/${slug}/pulls?state=${state}&sort=created&direction=desc&per_page=${clamp(limit, 1, 50)}`
    );
    const label = { open: "열린", closed: "닫힌", all: "전체" }[state];
    if (pulls.length === 0) return `${slug}: ${label} PR 이 없습니다.`;
    return [
      `${slug} ${label} PR ${pulls.length}건 (최근 생성 순)`,
      ...pulls.map(formatPullLine),
    ].join("\n");
  }

  async searchPulls(query: string, limit = 20): Promise<string> {
    const q = scopeSearchQuery(
      /\bis:pr\b/.test(query) ? query : `${query} is:pr`,
      this.owners
    );
    const data = await this.json<{
      total_count: number;
      items: {
        number: number;
        title: string;
        state: string;
        draft?: boolean;
        user?: { login: string };
        created_at: string;
        updated_at: string;
        repository_url: string;
        pull_request?: { merged_at?: string | null };
      }[];
    }>(
      `/search/issues?q=${encodeURIComponent(q)}&sort=created&order=desc&per_page=${clamp(limit, 1, 50)}`
    );
    if (data.items.length === 0) return `PR 을 찾지 못했습니다. (검색어: ${q})`;
    return [
      `PR ${data.total_count}건 중 ${data.items.length}건 (검색어: ${q}, 최근 생성 순)`,
      ...data.items.map((item) => {
        const repo = item.repository_url.split("/repos/")[1] ?? "?";
        const state = item.pull_request?.merged_at
          ? "merged"
          : item.draft
            ? "draft"
            : item.state;
        return `${repo}#${item.number} ${item.title} (@${item.user?.login ?? "?"}, ${state}, 생성 ${day(item.created_at)}, 갱신 ${day(item.updated_at)})`;
      }),
    ].join("\n");
  }

  async viewPull(repoInput: string, number?: number): Promise<string> {
    const { slug, number: n } = await this.resolvePull(repoInput, number);
    const pull = await this.json<Pull>(`/repos/${slug}/pulls/${n}`);
    const [reviews, checks, files] = await Promise.all([
      this.json<Review[]>(`/repos/${slug}/pulls/${n}/reviews?per_page=100`).catch(
        () => []
      ),
      this.json<{ check_runs: CheckRun[] }>(
        `/repos/${slug}/commits/${pull.head.sha}/check-runs?per_page=100`
      )
        .then((r) => r.check_runs)
        .catch(() => []),
      this.json<PullFile[]>(`/repos/${slug}/pulls/${n}/files?per_page=100`).catch(
        () => []
      ),
    ]);
    return formatPullDetail(slug, pull, reviews, checks, files);
  }

  async pullDiff(repoInput: string, number?: number, path?: string): Promise<string> {
    const { slug, number: n } = await this.resolvePull(repoInput, number);
    const diff = await this.text(
      `/repos/${slug}/pulls/${n}`,
      "application/vnd.github.diff"
    );
    if (!path) return diff || "(변경 없음)";
    const picked = filterDiff(diff, path);
    return (
      picked || `${path} 의 변경이 없습니다. gh_pr_view 의 변경 파일 목록을 확인하세요.`
    );
  }

  private async resolvePull(
    repoInput: string,
    number?: number
  ): Promise<{ slug: string; number: number }> {
    const ref = parseRepoRef(repoInput, this.owners);
    const n = number ?? ref.number;
    if (!n) throw new Error("PR 번호가 필요합니다. (number 또는 owner/repo#번호)");
    return { slug: await this.resolve(repoInput), number: n };
  }

  /** owner 가 없으면 허용된 조직을 차례로 찾아본다. */
  private async resolve(repoInput: string): Promise<string> {
    const ref = parseRepoRef(repoInput, this.owners);
    if (ref.owner) return `${ref.owner}/${ref.repo}`;
    const cached = this.repoCache.get(ref.repo.toLowerCase());
    if (cached) return cached;
    for (const owner of this.owners) {
      const found = await this.json<{ full_name: string }>(
        `/repos/${owner}/${ref.repo}`
      ).catch(() => undefined);
      if (found) {
        this.repoCache.set(ref.repo.toLowerCase(), found.full_name);
        return found.full_name;
      }
    }
    const similar = await this.searchRepos(ref.repo, 5).catch(() => "");
    throw new Error(
      `${this.owners.join(", ")} 에서 저장소 ${ref.repo} 를 찾지 못했습니다.` +
        (similar && !similar.startsWith("저장소를 찾지 못했습니다")
          ? `\n비슷한 저장소:\n${similar}`
          : "")
    );
  }

  private async json<T>(path: string): Promise<T> {
    return JSON.parse(await this.text(path, "application/vnd.github+json")) as T;
  }

  private async text(path: string, accept: string): Promise<string> {
    const res = await (this.options.fetchImpl ?? fetch)(`https://api.github.com${path}`, {
      headers: {
        Authorization: `Bearer ${this.options.token}`,
        Accept: accept,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "verda-ops-broker",
      },
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 20_000),
    });
    const body = await res.text();
    if (!res.ok) {
      let message = body.slice(0, 300);
      try {
        message = (JSON.parse(body) as { message?: string }).message ?? message;
      } catch {
        // 본문이 JSON 이 아니면 그대로 쓴다.
      }
      if (res.status === 404)
        throw new Error(`찾을 수 없습니다 (404): ${path.split("?")[0]}`);
      if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
        throw new Error("GitHub API 요청 한도를 넘었습니다. 잠시 후 다시 시도하세요.");
      }
      throw new Error(`GitHub API 오류 ${res.status}: ${message}`);
    }
    return body;
  }
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(Math.trunc(value), min), max);
