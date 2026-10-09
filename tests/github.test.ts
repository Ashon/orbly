import { describe, expect, it } from "vitest";
import {
  filterDiff,
  formatPullDetail,
  GitHubReader,
  parseRepoRef,
  scopeSearchQuery,
} from "../src/broker/github.js";

const OWNERS = ["acme", "acme-labs"];

describe("repository reference", () => {
  it("accepts only owner/repo, PR numbers, URLs, git remotes, and repository names", () => {
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

  it("rejects disallowed orgs and malformed input", () => {
    expect(() => parseRepoRef("octo/infra", OWNERS)).toThrow(/not allowed for lookup/);
    expect(() => parseRepoRef("../../etc", OWNERS)).toThrow(/Invalid repository format/);
  });
});

describe("search scope", () => {
  it("adds the allowed orgs when there is no org qualifier and rejects other orgs", () => {
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

describe("PR display", () => {
  const pull = {
    number: 20,
    title: "auth: Keycloak playbook",
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
    body: "Body text",
    additions: 120,
    deletions: 4,
    changed_files: 2,
    commits: 3,
    mergeable_state: "clean",
    requested_reviewers: [{ login: "bob" }],
  };

  it("keeps each reviewer's latest review and groups checks by conclusion", () => {
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
    expect(text).toContain("acme/infra#20 auth: Keycloak playbook");
    expect(text).toContain(
      "Branch: feat/auth -> main, commits 3, files 2, +120 -4, mergeable state clean"
    );
    expect(text).toContain("Requested reviewers: @bob");
    expect(text).toContain("Reviews: @bob CHANGES_REQUESTED, @carol APPROVED");
    expect(text).toContain("Checks: failure 1 (lint), success 1, in progress 1 (build)");
    expect(text).toContain("A roles/auth/main.yml (+100 -0)");
  });

  it("keeps only the selected files in a diff", () => {
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

  it("tries each allowed org for a bare repository name and only the broker uses the token", async () => {
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
    expect(text.split("\n")[0]).toBe("acme-labs/k8s-manifests: 1 open PR (newest first)");
    expect(text).toContain(
      "#20 auth: Keycloak playbook (@alice, open, feat/auth -> main"
    );
    expect(calls).toEqual([
      "/repos/acme/k8s-manifests",
      "/repos/acme-labs/k8s-manifests",
      "/repos/acme-labs/k8s-manifests/pulls?state=open&sort=created&direction=desc&per_page=5",
    ]);
    await expect(reader.listPulls("octo/x", "open")).rejects.toThrow(
      /not allowed for lookup/
    );
  });
});
