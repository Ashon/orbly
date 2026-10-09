import { describe, expect, it } from "vitest";
import { applyEdit, parseGithubRemote, reviewChanges } from "../src/broker/git.js";

describe("parseGithubRemote", () => {
  it("converts ssh and https remotes to owner/repo", () => {
    expect(parseGithubRemote("git@github.com:acme/k8s-manifests.git")).toEqual({
      owner: "acme",
      repo: "k8s-manifests",
    });
    expect(parseGithubRemote("https://github.com/acme/inventory")).toEqual({
      owner: "acme",
      repo: "inventory",
    });
    expect(parseGithubRemote("git@gitlab.com:a/b.git")).toBeUndefined();
    expect(parseGithubRemote("https://github.com/a/b/c")).toBeUndefined();
  });
});

describe("applyEdit", () => {
  it("replaces only a string that appears exactly once", () => {
    expect(applyEdit("a\nb\nc", "b", "B")).toBe("a\nB\nc");
    expect(() => applyEdit("a", "x", "y")).toThrow(/not found/);
    expect(() => applyEdit("b b", "b", "c")).toThrow(/2 times/);
    expect(applyEdit("b b", "b", "c", true)).toBe("c c");
  });

  it("does not treat $ patterns in the replacement as special", () => {
    expect(applyEdit("x", "x", "$& $1")).toBe("$& $1");
  });
});

describe("reviewChanges", () => {
  it("passes valid changes", () => {
    expect(
      reviewChanges(["clusters/main/rbac.yaml"], "+kind: ServiceAccount", 1)
    ).toEqual([]);
  });

  it("rejects empty changes, protected paths, secret files, secrets, and oversized changes", () => {
    expect(reviewChanges([], "", 0)).toEqual(["There are no changes."]);
    expect(reviewChanges([".github/workflows/ci.yaml"], "+x", 1).join()).toMatch(
      /Protected path/
    );
    expect(reviewChanges(["app/.env"], "+X=1", 1).join()).toMatch(/restricted path/);
    expect(reviewChanges(["a.yaml"], "+token: abcdefghijklmnop", 1).join()).toMatch(
      /secret/
    );
    expect(reviewChanges(["a.yaml"], "+x", 5000).join()).toMatch(/changed lines/);
    const many = Array.from({ length: 51 }, (_, i) => `f${i}.txt`);
    expect(reviewChanges(many, "+x", 51).join()).toMatch(/changed files/);
  });
});
