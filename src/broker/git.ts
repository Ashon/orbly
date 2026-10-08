import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { ProcessExitError, runProcess } from "../reasoner/process.js";
import { isDenied } from "./fs.js";
import { redactSecrets } from "./redact.js";

/**
 * 에이전트용 git 작업 공간. 사용자 로컬 작업 트리는 건드리지 않는다.
 * - 원격 저장소를 broker 전용 볼륨(/work)에 bare 미러로 받고, 작업마다 새 브랜치 worktree 를 만든다.
 * - 파일 수정은 worktree 안에서만, 커밋/push/PR 은 정책 검사를 통과한 경우에만 broker 가 실행한다.
 * - GitHub 토큰은 이 프로세스의 환경 변수에만 있고 모델에는 노출되지 않는다.
 */

export const BRANCH_PREFIX = "verda/";
const MAX_WRITE_BYTES = 512 * 1024;
const MAX_CHANGED_FILES = 50;
const MAX_CHANGED_LINES = 3_000;
const MAX_PRS_PER_HOUR = 10;
const WORKSPACE_TTL_MS = 24 * 3_600_000;

/** 에이전트가 바꿀 수 없는 경로. CI 설정 변경은 사람이 직접 한다. */
const PROTECTED_PATHS: RegExp[] = [/^\.github\/workflows\//, /^\.gitmodules$/];

export interface RepoSlug {
  owner: string;
  repo: string;
}

/** git@github.com:o/r(.git), https://github.com/o/r(.git) 형식만 받는다. */
export function parseGithubRemote(url: string): RepoSlug | undefined {
  const match =
    /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(
      url.trim()
    );
  return match ? { owner: match[1]!, repo: match[2]! } : undefined;
}

/** old 를 new 로 바꾼다. 없거나(0회) 여러 번인데 replaceAll 이 아니면 거부한다. */
export function applyEdit(
  content: string,
  oldText: string,
  newText: string,
  replaceAll = false
): string {
  if (!oldText) throw new Error("old_string 이 비어 있습니다.");
  const count = content.split(oldText).length - 1;
  if (count === 0)
    throw new Error(
      "old_string 을 파일에서 찾지 못했습니다. ws_read 로 정확한 내용을 확인하세요."
    );
  if (count > 1 && !replaceAll) {
    throw new Error(
      `old_string 이 ${count}번 나옵니다. 더 넓은 범위로 지정하거나 replace_all 을 쓰세요.`
    );
  }
  return replaceAll
    ? content.split(oldText).join(newText)
    : content.replace(oldText, () => newText);
}

/** PR 전 정책 검사. 문제 목록을 돌려준다. */
export function reviewChanges(
  files: string[],
  diff: string,
  addedLines: number
): string[] {
  const problems: string[] = [];
  if (files.length === 0) problems.push("변경 사항이 없습니다.");
  if (files.length > MAX_CHANGED_FILES)
    problems.push(`변경 파일이 너무 많습니다 (${files.length} > ${MAX_CHANGED_FILES}).`);
  if (addedLines > MAX_CHANGED_LINES)
    problems.push(`변경 줄이 너무 많습니다 (${addedLines} > ${MAX_CHANGED_LINES}).`);
  for (const file of files) {
    if (isDenied(file)) problems.push(`제한된 경로를 바꿀 수 없습니다: ${file}`);
    if (PROTECTED_PATHS.some((p) => p.test(file)))
      problems.push(`보호된 경로입니다 (사람이 직접 변경): ${file}`);
  }
  if (redactSecrets(diff) !== diff)
    problems.push("diff 에 비밀 값으로 보이는 내용이 있습니다.");
  return problems;
}

interface Workspace {
  id: string;
  dir: string;
  slug: RepoSlug;
  branch: string;
  base: string;
  createdAt: number;
  prUrl?: string;
}

export interface GitWorkspaceOptions {
  /** 로컬 저장소 루트(읽기 전용 마운트). 저장소 이름으로 원격 주소를 찾는다. */
  localRoot: string;
  /** 미러와 worktree 를 두는 쓰기 가능 디렉터리 */
  workRoot: string;
  token: string;
  authorName: string;
  authorEmail: string;
  allowedOwners: string[];
  timeoutMs: number;
}

export class GitWorkspaces {
  private readonly workspaces = new Map<string, Workspace>();
  private readonly prTimes: number[] = [];

  constructor(private readonly options: GitWorkspaceOptions) {}

  private gitEnv(): NodeJS.ProcessEnv {
    const basic = Buffer.from(`x-access-token:${this.options.token}`).toString("base64");
    return {
      PATH: process.env.PATH,
      HOME: "/tmp",
      GIT_TERMINAL_PROMPT: "0",
      // 토큰을 인자나 설정 파일에 남기지 않고 이 프로세스 환경으로만 넘긴다.
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
      GIT_CONFIG_KEY_1: "safe.directory",
      GIT_CONFIG_VALUE_1: "*",
      GIT_AUTHOR_NAME: this.options.authorName,
      GIT_AUTHOR_EMAIL: this.options.authorEmail,
      GIT_COMMITTER_NAME: this.options.authorName,
      GIT_COMMITTER_EMAIL: this.options.authorEmail,
    };
  }

  private async git(args: string[], cwd = "/tmp"): Promise<string> {
    try {
      const { stdout } = await runProcess("git", args, {
        cwd,
        input: "",
        timeoutMs: this.options.timeoutMs,
        env: this.gitEnv(),
      });
      return stdout;
    } catch (err) {
      if (err instanceof ProcessExitError) {
        throw new Error(
          `git ${args[0]} 실패: ${redactSecrets(err.stderr.trim()).slice(-500)}`,
          { cause: err }
        );
      }
      throw err;
    }
  }

  /** 로컬 저장소 디렉터리 이름으로 GitHub 원격을 찾고 허용 조직인지 확인한다. */
  async resolveRepo(name: string): Promise<RepoSlug> {
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || name.startsWith(".")) {
      throw new Error(`저장소 이름 형식이 올바르지 않습니다: ${name}`);
    }
    const local = path.join(this.options.localRoot, name);
    if (!existsSync(path.join(local, ".git"))) {
      throw new Error(`로컬에 git 저장소가 없습니다: ${name} (fs_list 로 확인)`);
    }
    const url = (
      await this.git(["-C", local, "remote", "get-url", "origin"]).catch(() => {
        throw new Error(`origin 원격이 없는 저장소입니다: ${name}`);
      })
    ).trim();
    const slug = parseGithubRemote(url);
    if (!slug) throw new Error(`GitHub 원격이 아닙니다: ${name}`);
    const allowed = this.options.allowedOwners.map((o) => o.toLowerCase());
    if (!allowed.includes(slug.owner.toLowerCase())) {
      throw new Error(`허용된 조직의 저장소가 아닙니다: ${slug.owner}/${slug.repo}`);
    }
    return slug;
  }

  /** 원격 기본 브랜치(또는 base)에서 새 브랜치 작업 공간을 만든다. */
  async prepare(name: string, base?: string): Promise<Workspace> {
    await this.cleanupExpired();
    const slug = await this.resolveRepo(name);
    if (base !== undefined && !/^[A-Za-z0-9._/-]{1,100}$/.test(base)) {
      throw new Error(`base 브랜치 이름 형식이 올바르지 않습니다: ${base}`);
    }
    const mirror = path.join(
      this.options.workRoot,
      "mirrors",
      `${slug.owner}__${slug.repo}.git`
    );
    const url = `https://github.com/${slug.owner}/${slug.repo}.git`;
    if (!existsSync(mirror)) {
      await mkdir(path.dirname(mirror), { recursive: true });
      await this.git(["clone", "--bare", "--filter=blob:none", url, mirror]);
    } else {
      await this.git([
        "-C",
        mirror,
        "fetch",
        "--prune",
        "origin",
        "+refs/heads/*:refs/heads/*",
      ]);
      await this.git(["-C", mirror, "worktree", "prune"]);
    }
    const baseBranch =
      base ?? (await this.git(["-C", mirror, "symbolic-ref", "--short", "HEAD"])).trim();

    const id = randomBytes(4).toString("hex");
    const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    const branch = `${BRANCH_PREFIX}${date}-${id}`;
    const dir = path.join(this.options.workRoot, "ws", id);
    await mkdir(path.dirname(dir), { recursive: true });
    await this.git(["-C", mirror, "worktree", "add", "-b", branch, dir, baseBranch]);

    const workspace: Workspace = {
      id,
      dir,
      slug,
      branch,
      base: baseBranch,
      createdAt: Date.now(),
    };
    this.workspaces.set(id, workspace);
    return workspace;
  }

  get(id: string): Workspace {
    const workspace = this.workspaces.get(id);
    if (!workspace)
      throw new Error(`작업 공간이 없습니다: ${id} (ws_prepare 로 먼저 만드세요)`);
    return workspace;
  }

  /** 작업 공간 안의 쓰기 대상 경로. 없는 파일도 허용하되 루트 밖, 제한 경로, 보호 경로는 거부한다. */
  private target(workspace: Workspace, requested: string): { abs: string; rel: string } {
    const rel = path.posix.normalize(requested.trim().replace(/^\/+/, ""));
    if (!rel || rel === "." || rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error("작업 공간 기준 상대 경로로 지정하세요.");
    }
    if (isDenied(rel)) throw new Error(`제한된 경로입니다: ${rel}`);
    if (PROTECTED_PATHS.some((p) => p.test(rel)))
      throw new Error(`보호된 경로입니다: ${rel}`);
    return { abs: path.join(workspace.dir, rel), rel };
  }

  async write(id: string, requested: string, content: string): Promise<string> {
    const workspace = this.get(id);
    const { abs, rel } = this.target(workspace, requested);
    if (Buffer.byteLength(content) > MAX_WRITE_BYTES)
      throw new Error("파일이 너무 큽니다.");
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
    return `작성함: ${rel} (${Buffer.byteLength(content)} bytes)`;
  }

  async edit(
    id: string,
    requested: string,
    oldText: string,
    newText: string,
    replaceAll?: boolean
  ): Promise<string> {
    const workspace = this.get(id);
    const { abs, rel } = this.target(workspace, requested);
    const content = await readFile(abs, "utf8").catch(() => {
      throw new Error(`파일이 없습니다: ${rel}`);
    });
    await writeFile(abs, applyEdit(content, oldText, newText, replaceAll));
    return `수정함: ${rel}`;
  }

  async remove(id: string, requested: string): Promise<string> {
    const workspace = this.get(id);
    const { abs, rel } = this.target(workspace, requested);
    if (!(await stat(abs).catch(() => undefined))?.isFile())
      throw new Error(`파일이 없습니다: ${rel}`);
    await unlink(abs);
    return `삭제함: ${rel}`;
  }

  async diff(id: string): Promise<string> {
    const workspace = this.get(id);
    await this.git(["add", "--all"], workspace.dir);
    const stat = await this.git(["diff", "--cached", "--stat"], workspace.dir);
    const diff = await this.git(["diff", "--cached"], workspace.dir);
    return `${workspace.slug.owner}/${workspace.slug.repo} ${workspace.branch} (base ${workspace.base})\n${stat}\n${diff}`;
  }

  async createPullRequest(id: string, title: string, body: string): Promise<string> {
    const workspace = this.get(id);
    if (workspace.prUrl) return `이미 PR 이 있습니다: ${workspace.prUrl}`;
    const now = Date.now();
    while (this.prTimes.length && now - this.prTimes[0]! > 3_600_000)
      this.prTimes.shift();
    if (this.prTimes.length >= MAX_PRS_PER_HOUR)
      throw new Error("시간당 PR 생성 한도를 넘었습니다.");
    if (!title.trim() || title.length > 200)
      throw new Error("PR 제목은 1-200자여야 합니다.");

    await this.git(["add", "--all"], workspace.dir);
    const files = (await this.git(["diff", "--cached", "--name-only"], workspace.dir))
      .split("\n")
      .filter(Boolean);
    const diff = await this.git(["diff", "--cached"], workspace.dir);
    const added = diff
      .split("\n")
      .filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
    const problems = reviewChanges(files, diff, added);
    if (problems.length > 0)
      throw new Error(`PR 을 만들 수 없습니다:\n- ${problems.join("\n- ")}`);

    await this.git(["commit", "--quiet", "-m", title.trim()], workspace.dir);
    if (!workspace.branch.startsWith(BRANCH_PREFIX))
      throw new Error("에이전트 브랜치가 아닙니다.");
    await this.git(
      ["push", "origin", `HEAD:refs/heads/${workspace.branch}`],
      workspace.dir
    );

    const res = await fetch(
      `https://api.github.com/repos/${workspace.slug.owner}/${workspace.slug.repo}/pulls`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({
          title: title.trim(),
          head: workspace.branch,
          base: workspace.base,
          body: `${body.trim()}\n\n---\n_Verda 가 Slack 요청으로 작성한 draft PR 입니다. 머지 전에 검토가 필요합니다._`,
          draft: true,
        }),
      }
    );
    const json = (await res.json()) as { html_url?: string; message?: string };
    if (!res.ok || !json.html_url) {
      throw new Error(
        `PR 생성 실패 (${res.status}): ${json.message ?? ""} (브랜치 ${workspace.branch} 는 push 됨)`
      );
    }
    this.prTimes.push(now);
    workspace.prUrl = json.html_url;
    return `draft PR 생성: ${json.html_url} (${files.length}개 파일)`;
  }

  /** 오래된 작업 공간을 정리한다. */
  private async cleanupExpired(): Promise<void> {
    const now = Date.now();
    for (const [id, workspace] of this.workspaces) {
      if (now - workspace.createdAt < WORKSPACE_TTL_MS) continue;
      await rm(workspace.dir, { recursive: true, force: true });
      this.workspaces.delete(id);
    }
    // broker 재시작으로 기록이 사라진 작업 공간 디렉터리도 정리한다.
    const wsRoot = path.join(this.options.workRoot, "ws");
    for (const name of await readdir(wsRoot).catch(() => [] as string[])) {
      if (this.workspaces.has(name)) continue;
      const info = await stat(path.join(wsRoot, name)).catch(() => undefined);
      if (info && now - info.mtimeMs > WORKSPACE_TTL_MS) {
        await rm(path.join(wsRoot, name), { recursive: true, force: true });
      }
    }
  }
}
