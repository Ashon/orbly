import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveAppPaths } from "../apps/desktop/src/app-paths.js";
import { ensureAllowlistFile } from "../src/sandbox/allowlist.js";
import { allowlistPath } from "../src/settings/paths.js";
import { jobEnv, planJob } from "../src/tools/sandbox-job.js";

const root = mkdtempSync(path.join(tmpdir(), "verda-packaging-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("앱 경로", () => {
  it("개발 실행은 저장소의 빌드 결과를, 패키지 앱은 앱 안의 묶음을 쓴다", () => {
    expect(resolveAppPaths("/repo/apps/desktop/dist", false)).toEqual({
      packaged: false,
      webDist: "/repo/apps/web/dist",
      botEntry: "/repo/dist/index.js",
      sandboxDir: "/repo/sandbox",
      jobRunner: "/repo/build/tools/sandbox-job.mjs",
      repoRoot: "/repo",
    });
    const app = "/Applications/Verda.app/Contents/Resources/app";
    expect(resolveAppPaths(`${app}/dist`, true)).toEqual({
      packaged: true,
      webDist: `${app}/web`,
      botEntry: `${app}/bot/index.mjs`,
      sandboxDir: `${app}/sandbox`,
      jobRunner: `${app}/tools/sandbox-job.mjs`,
    });
  });
});

describe("샌드박스 작업", () => {
  const ctx = { sandboxDir: "/app/sandbox", envFile: "/home/me/.verda/.env" };
  const compose = ["compose", "-f", "/app/sandbox/compose.yaml"];

  it("작업마다 같은 compose 프로젝트로 정해진 단계를 밟는다", () => {
    expect(planJob("images", ctx)).toEqual([
      { kind: "compose", args: [...compose, "--profile", "build", "build"] },
    ]);
    expect(planJob("proxy", ctx)).toEqual([
      { kind: "allowlist" },
      {
        kind: "compose",
        args: [...compose, "up", "-d", "--build", "--force-recreate", "egress-proxy"],
      },
    ]);
    expect(planJob("broker", ctx).map((step) => step.kind)).toEqual([
      "broker-bundle",
      "allowlist",
      "broker-files",
      "credentials",
      "compose",
    ]);
    expect(planJob("broker", ctx).at(-1)).toEqual({
      kind: "compose",
      args: [
        ...compose,
        "--env-file",
        "/home/me/.verda/.env",
        "--profile",
        "ops",
        "up",
        "-d",
        "--build",
        "--force-recreate",
        "ops-broker",
      ],
    });
    // 설정 파일이 없으면 --env-file 을 넘기지 않는다.
    expect(planJob("broker", { sandboxDir: "/app/sandbox" }).at(-1)).toMatchObject({
      args: expect.not.arrayContaining(["--env-file"]),
    });
    expect(planJob("kubeconfig", ctx)).toEqual([{ kind: "kubeconfig" }]);
  });

  it("설정 파일 위에 환경 변수를 덮고, compose 가 볼 VERDA_HOME 을 펼친다", () => {
    const envFile = path.join(root, ".env");
    writeFileSync(envFile, "OPS_SSH_USER=from-file\nOPS_FS_ROOT=/from/file\n");
    const env = jobEnv({ OPS_SSH_USER: "from-env", HOME: "/home/me" }, envFile);
    expect(env).toMatchObject({
      OPS_SSH_USER: "from-env",
      OPS_FS_ROOT: "/from/file",
      VERDA_HOME: "/home/me/.verda",
    });
  });

  it("허용 도메인 목록은 VERDA_HOME 에 두고, 없을 때만 기본 목록으로 만든다", () => {
    const template = path.join(root, "allowed-domains.txt");
    writeFileSync(template, "api.anthropic.com\n");
    const file = allowlistPath({ VERDA_HOME: path.join(root, "home") });
    expect(file).toBe(path.join(root, "home/sandbox/allowed-domains.txt"));
    ensureAllowlistFile(file, template);
    expect(readFileSync(file, "utf8")).toBe("api.anthropic.com\n");
    writeFileSync(file, "edited.example.com\n");
    ensureAllowlistFile(file, template);
    expect(readFileSync(file, "utf8")).toBe("edited.example.com\n");
  });
});
