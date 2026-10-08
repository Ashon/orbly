import { describe, expect, it } from "vitest";
import { applyEdit, parseGithubRemote, reviewChanges } from "../src/broker/git.js";

describe("parseGithubRemote", () => {
  it("ssh, https 원격을 owner/repo 로 바꾼다", () => {
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
  it("한 번 나오는 문자열만 바꾼다", () => {
    expect(applyEdit("a\nb\nc", "b", "B")).toBe("a\nB\nc");
    expect(() => applyEdit("a", "x", "y")).toThrow(/찾지 못했습니다/);
    expect(() => applyEdit("b b", "b", "c")).toThrow(/2번/);
    expect(applyEdit("b b", "b", "c", true)).toBe("c c");
  });

  it("바꿀 문자열의 $ 패턴을 특수 문자로 해석하지 않는다", () => {
    expect(applyEdit("x", "x", "$& $1")).toBe("$& $1");
  });
});

describe("reviewChanges", () => {
  it("정상 변경은 통과한다", () => {
    expect(
      reviewChanges(["clusters/main/rbac.yaml"], "+kind: ServiceAccount", 1)
    ).toEqual([]);
  });

  it("빈 변경, 보호 경로, 비밀 파일, 비밀 값, 과도한 변경을 거부한다", () => {
    expect(reviewChanges([], "", 0)).toEqual(["변경 사항이 없습니다."]);
    expect(reviewChanges([".github/workflows/ci.yaml"], "+x", 1).join()).toMatch(
      /보호된 경로/
    );
    expect(reviewChanges(["app/.env"], "+X=1", 1).join()).toMatch(/제한된 경로/);
    expect(reviewChanges(["a.yaml"], "+token: abcdefghijklmnop", 1).join()).toMatch(
      /비밀 값/
    );
    expect(reviewChanges(["a.yaml"], "+x", 5000).join()).toMatch(/변경 줄/);
    const many = Array.from({ length: 51 }, (_, i) => `f${i}.txt`);
    expect(reviewChanges(many, "+x", 51).join()).toMatch(/변경 파일/);
  });
});
