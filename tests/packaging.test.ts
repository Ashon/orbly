import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveAppPaths } from "../apps/desktop/src/app-paths.js";
import { ensureAllowlistFile } from "../src/sandbox/allowlist.js";
import { allowlistPath } from "../src/settings/paths.js";
import { jobEnv, planJob } from "../src/tools/sandbox-job.js";

const root = mkdtempSync(path.join(tmpdir(), "pacenote-packaging-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("app paths", () => {
  it("a dev run uses the repository build outputs, the packaged app its bundled copies", () => {
    expect(resolveAppPaths("/repo/apps/desktop/dist", false)).toEqual({
      packaged: false,
      webDist: "/repo/apps/web/dist",
      botEntry: "/repo/dist/index.js",
      sandboxDir: "/repo/sandbox",
      jobRunner: "/repo/build/tools/sandbox-job.mjs",
      repoRoot: "/repo",
    });
    const app = "/Applications/Pacenote.app/Contents/Resources/app";
    expect(resolveAppPaths(`${app}/dist`, true)).toEqual({
      packaged: true,
      webDist: `${app}/web`,
      botEntry: `${app}/bot/index.mjs`,
      sandboxDir: `${app}/sandbox`,
      jobRunner: `${app}/tools/sandbox-job.mjs`,
    });
  });
});

describe("sandbox jobs", () => {
  const ctx = { sandboxDir: "/app/sandbox", envFile: "/home/me/.pacenote/.env" };
  const compose = ["compose", "-f", "/app/sandbox/compose.yaml"];

  it("each job runs its fixed steps against the same compose project", () => {
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
        "/home/me/.pacenote/.env",
        "--profile",
        "ops",
        "up",
        "-d",
        "--build",
        "--force-recreate",
        "ops-broker",
      ],
    });
    // Without a config file, --env-file is not passed.
    expect(planJob("broker", { sandboxDir: "/app/sandbox" }).at(-1)).toMatchObject({
      args: expect.not.arrayContaining(["--env-file"]),
    });
    expect(planJob("kubeconfig", ctx)).toEqual([{ kind: "kubeconfig" }]);
  });

  it("layers the environment over the config file and expands PACENOTE_HOME for compose", () => {
    const envFile = path.join(root, ".env");
    writeFileSync(envFile, "OPS_SSH_USER=from-file\nOPS_FS_ROOT=/from/file\n");
    const env = jobEnv({ OPS_SSH_USER: "from-env", HOME: "/home/me" }, envFile);
    expect(env).toMatchObject({
      OPS_SSH_USER: "from-env",
      OPS_FS_ROOT: "/from/file",
      PACENOTE_HOME: "/home/me/.pacenote",
    });
  });

  it("keeps the allowlist in PACENOTE_HOME and seeds it from the default only when missing", () => {
    const template = path.join(root, "allowed-domains.txt");
    writeFileSync(template, "api.anthropic.com\n");
    const file = allowlistPath({ PACENOTE_HOME: path.join(root, "home") });
    expect(file).toBe(path.join(root, "home/sandbox/allowed-domains.txt"));
    ensureAllowlistFile(file, template);
    expect(readFileSync(file, "utf8")).toBe("api.anthropic.com\n");
    writeFileSync(file, "edited.example.com\n");
    ensureAllowlistFile(file, template);
    expect(readFileSync(file, "utf8")).toBe("edited.example.com\n");
  });
});

describe("release", () => {
  const version = (file: string) =>
    (
      JSON.parse(readFileSync(path.join(import.meta.dirname, "..", file), "utf8")) as {
        version: string;
      }
    ).version;

  it("the packages share one version (the release workflow holds it equal to the tag)", () => {
    const shared = version("package.json");
    expect(version("apps/desktop/package.json")).toBe(shared);
    expect(version("apps/web/package.json")).toBe(shared);
  });

  it("the cask template keeps the placeholders update-tap.sh fills in", () => {
    const cask = readFileSync(
      path.join(import.meta.dirname, "../deploy/homebrew/Casks/pacenote.rb"),
      "utf8"
    );
    expect(cask).toMatch(/^ {2}version "[^"]+"$/m);
    expect(cask).toContain("REPLACE_SHA256_ARM64");
    expect(cask).toContain("REPLACE_SHA256_X64");
    expect(cask).toContain("Pacenote-v#{version}-macos-#{arch}.app.zip");
  });
});
