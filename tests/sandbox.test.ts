import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { parseCodexDefaults } from "../src/reasoner/codex-config.js";
import { dockerRunArgs, type DockerSandboxOptions } from "../src/reasoner/executor.js";

const options: DockerSandboxOptions = {
  dockerBin: "docker",
  image: "img:1",
  network: "sbx",
  proxyUrl: "http://egress-proxy:8888",
  memory: "2g",
  cpus: "2",
  claudeEnv: { CLAUDE_CODE_OAUTH_TOKEN: "secret-token" },
  codexAuthFile: "/home/me/.codex/auth.json",
};

const valueAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe("dockerRunArgs", () => {
  const args = dockerRunArgs(
    options,
    { tool: "claude", args: ["-p"], referenceDir: "/repo" },
    "c1"
  );

  it("격리 옵션을 모두 건다", () => {
    expect(args.slice(0, 3)).toEqual(["run", "--rm", "-i"]);
    expect(args).toContain("--read-only");
    expect(valueAfter(args, "--network")).toBe("sbx");
    expect(valueAfter(args, "--cap-drop")).toBe("ALL");
    expect(valueAfter(args, "--security-opt")).toBe("no-new-privileges");
    expect(valueAfter(args, "--user")).toBe("1000:1000");
    expect(args).toContain("HTTPS_PROXY=http://egress-proxy:8888");
  });

  it("참고 디렉터리는 읽기 전용으로만 마운트하고 비밀 값은 인자에 넣지 않는다", () => {
    expect(args).toContain("/repo:/workspace:ro");
    expect(valueAfter(args, "-w")).toBe("/workspace");
    expect(args).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(args.join(" ")).not.toContain("secret-token");
    expect(args.join(" ")).not.toContain("auth.json");
    expect(args.slice(-3)).toEqual(["img:1", "claude", "-p"]);
  });

  it("내부 서비스는 프록시를 거치지 않도록 NO_PROXY 를 넘긴다", () => {
    const withBroker = dockerRunArgs(
      { ...options, noProxy: ["ops-broker"] },
      { tool: "codex", args: [] },
      "c3"
    );
    expect(withBroker).toContain("NO_PROXY=ops-broker");
    expect(args.some((a) => a.startsWith("NO_PROXY="))).toBe(false);
  });

  it("codex 는 인증 파일만 읽기 전용으로 받고 claude 인증은 받지 않는다", () => {
    const codex = dockerRunArgs(options, { tool: "codex", args: ["exec"] }, "c2");
    expect(codex).toContain("/home/me/.codex/auth.json:/run/secrets/codex-auth.json:ro");
    expect(codex).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(valueAfter(codex, "-w")).toBe("/work");
    expect(codex.some((a) => a.endsWith(":/workspace:ro"))).toBe(false);
  });
});

describe("parseCodexDefaults", () => {
  it("최상위 키만 읽고 테이블 안의 값은 무시한다", () => {
    const toml = [
      'model = "gpt-x"',
      'model_reasoning_effort = "medium"',
      "",
      "[profiles.fast]",
      'model = "gpt-mini"',
    ].join("\n");
    expect(parseCodexDefaults(toml)).toEqual({
      model: "gpt-x",
      reasoningEffort: "medium",
    });
    expect(parseCodexDefaults('[a]\nmodel = "b"')).toEqual({
      model: undefined,
      reasoningEffort: undefined,
    });
  });
});

describe("loadConfig sandbox", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "verda-codex-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const env = {
    SLACK_BOT_TOKEN: "xoxb-1",
    SLACK_APP_TOKEN: "xapp-1",
  };

  it("claude 샌드박스는 컨테이너용 인증 값이 없으면 시작하지 않는다", () => {
    expect(() => loadConfig({ ...env, REASONER_SANDBOX: "docker" })).toThrow(
      /SANDBOX_CLAUDE_OAUTH_TOKEN/
    );
    const config = loadConfig({
      ...env,
      REASONER_SANDBOX: "docker",
      SANDBOX_CLAUDE_OAUTH_TOKEN: "tok",
    });
    expect(config.reasoner.sandbox?.claudeEnv).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: "tok",
    });
    expect(config.reasoner.sandbox?.codexAuthFile).toBeUndefined();
  });

  it("codex 샌드박스는 인증 파일이 필요하고 모델은 호스트 config.toml 에서 가져온다", () => {
    const auth = path.join(dir, "auth.json");
    expect(() =>
      loadConfig({
        ...env,
        REASONER: "codex",
        REASONER_SANDBOX: "docker",
        SANDBOX_CODEX_AUTH_FILE: auth,
      })
    ).toThrow(/로그인 파일/);

    writeFileSync(auth, "{}");
    writeFileSync(
      path.join(dir, "config.toml"),
      'model = "gpt-x"\nmodel_reasoning_effort = "low"\n'
    );
    const config = loadConfig({
      ...env,
      REASONER: "codex",
      REASONER_SANDBOX: "docker",
      SANDBOX_CODEX_AUTH_FILE: auth,
    });
    expect(config.reasoner).toMatchObject({
      model: "gpt-x",
      codexReasoningEffort: "low",
    });
    expect(config.reasoner.sandbox).toMatchObject({ codexAuthFile: auth, claudeEnv: {} });
  });
});
