import { describe, expect, it } from "vitest";
import {
  filterDiff,
  formatPullDetail,
  GitHubReader,
  parseRepoRef,
  scopeSearchQuery,
} from "../src/broker/github.js";

const OWNERS = ["acme", "acme-labs"];

describe("저장소 지정", () => {
  it("owner/repo, PR 번호, URL, git 원격, 저장소 이름만 받는다", () => {
    expect(parseRepoRef("acme/infra", OWNERS)).toEqual({
      owner: "acme",
      repo: "infra",
      number: undefined,
    });
    expect(parseRepoRef("acme/infra#20", OWNERS).number).toBe(20);
    expect(parseRepoRef("https://github.com/acme/infra/pull/19", OWNERS)).toMatchObject({
      repo: "infra",
      number: 19,
    });
    expect(
      parseRepoRef("git@github.com:acme-labs/k8s-manifests.git", OWNERS)
    ).toMatchObject({
      owner: "acme-labs",
      repo: "k8s-manifests",
    });
    expect(parseRepoRef("infra", OWNERS)).toEqual({
      owner: undefined,
      repo: "infra",
      number: undefined,
    });
  });

  it("허용되지 않은 조직과 이상한 형식은 거부한다", () => {
    expect(() => parseRepoRef("octo/infra", OWNERS)).toThrow(/조회할 수 없는 조직/);
    expect(() => parseRepoRef("../../etc", OWNERS)).toThrow(/저장소 형식/);
  });
});

describe("검색 범위", () => {
  it("조직 한정자가 없으면 허용된 조직을 붙이고, 다른 조직은 거부한다", () => {
    expect(scopeSearchQuery("is:open is:pr", OWNERS)).toBe(
      "is:open is:pr org:acme org:acme-labs"
    );
    expect(scopeSearchQuery("is:open repo:acme/infra repo:acme-labs/x", OWNERS)).toBe(
      "is:open repo:acme/infra repo:acme-labs/x"
    );
    expect(() => scopeSearchQuery("repo:acme/a repo:octo/b", OWNERS)).toThrow(/octo\/b/);
    expect(() => scopeSearchQuery("user:someone", OWNERS)).toThrow(/someone/);
  });
});

describe("PR 표시", () => {
  const pull = {
    number: 20,
    title: "auth: Keycloak 플레이북",
    state: "open",
    draft: false,
    merged_at: null,
    user: { login: "alice" },
    created_at: "2026-10-07T01:00:00Z",
    updated_at: "2026-10-08T02:00:00Z",
    html_url: "https://github.com/acme/infra/pull/20",
    head: { ref: "feat/auth", sha: "abc" },
    base: { ref: "main" },
    labels: [{ name: "infra" }],
    body: "본문",
    additions: 120,
    deletions: 4,
    changed_files: 2,
    commits: 3,
    mergeable_state: "clean",
    requested_reviewers: [{ login: "bob" }],
  };

  it("리뷰는 사람마다 마지막 결과, 체크는 결과별로 묶는다", () => {
    const text = formatPullDetail(
      "acme/infra",
      pull,
      [
        { user: { login: "bob" }, state: "CHANGES_REQUESTED" },
        { user: { login: "bob" }, state: "COMMENTED" },
        { user: { login: "carol" }, state: "APPROVED" },
      ],
      [
        { name: "lint", status: "completed", conclusion: "failure" },
        { name: "test", status: "completed", conclusion: "success" },
        { name: "build", status: "in_progress", conclusion: null },
      ],
      [{ filename: "roles/auth/main.yml", status: "added", additions: 100, deletions: 0 }]
    );
    expect(text).toContain("acme/infra#20 auth: Keycloak 플레이북");
    expect(text).toContain(
      "브랜치: feat/auth -> main, 커밋 3, 파일 2, +120 -4, 병합 상태 clean"
    );
    expect(text).toContain("리뷰 요청: @bob");
    expect(text).toContain("리뷰: @bob CHANGES_REQUESTED, @carol APPROVED");
    expect(text).toContain("체크: failure 1 (lint), success 1, 진행 중 1 (build)");
    expect(text).toContain("A roles/auth/main.yml (+100 -0)");
  });

  it("diff 에서 고른 파일만 남긴다", () => {
    const diff = [
      "diff --git a/a.tf b/a.tf",
      "+x",
      "diff --git a/roles/b.yml b/roles/b.yml",
      "+y",
      "",
    ].join("\n");
    expect(filterDiff(diff, "roles/")).toBe(
      "diff --git a/roles/b.yml b/roles/b.yml\n+y\n"
    );
    expect(filterDiff(diff, "none")).toBe("");
  });

  it("조직 없이 저장소 이름만 주면 허용된 조직을 차례로 찾고 토큰은 broker 만 쓴다", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url).replace("https://api.github.com", "");
      calls.push(path);
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        "Bearer ghp_test"
      );
      if (path === "/repos/acme/k8s-manifests")
        return new Response("{}", { status: 404 });
      if (path === "/repos/acme-labs/k8s-manifests") {
        return new Response(JSON.stringify({ full_name: "acme-labs/k8s-manifests" }));
      }
      if (path.startsWith("/repos/acme-labs/k8s-manifests/pulls"))
        return new Response(JSON.stringify([pull]));
      return new Response("{}", { status: 500 });
    }) as typeof fetch;
    const reader = new GitHubReader({
      token: "ghp_test",
      allowedOwners: OWNERS,
      fetchImpl,
    });
    const text = await reader.listPulls("k8s-manifests", "open", 5);
    expect(text.split("\n")[0]).toBe(
      "acme-labs/k8s-manifests 열린 PR 1건 (최근 생성 순)"
    );
    expect(text).toContain(
      "#20 auth: Keycloak 플레이북 (@alice, open, feat/auth -> main"
    );
    expect(calls).toEqual([
      "/repos/acme/k8s-manifests",
      "/repos/acme-labs/k8s-manifests",
      "/repos/acme-labs/k8s-manifests/pulls?state=open&sort=created&direction=desc&per_page=5",
    ]);
    await expect(reader.listPulls("octo/x", "open")).rejects.toThrow(
      /조회할 수 없는 조직/
    );
  });
});
