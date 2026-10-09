import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ensureAllowlistFile } from "../sandbox/allowlist.js";
import { loadBrokerEnv } from "../sandbox/env.js";
import { writeKubeconfig } from "../sandbox/kubeconfig.js";
import { prepareBrokerFiles } from "../sandbox/prepare.js";
import { readEnvFile, readEnvValues } from "../settings/env-file.js";
import {
  applyLegacyEnv,
  envValue,
  legacyHomeWarning,
  warnOnce,
} from "../settings/legacy.js";
import { allowlistPath, envFilePath, pacenoteHome } from "../settings/paths.js";

/**
 * Sandbox apply jobs. The desktop app and the terminal (pnpm sandbox:*) use the same steps.
 * Usage: sandbox-job <images|proxy|broker|kubeconfig> [--dry-run]
 * - The sandbox directory is PACENOTE_SANDBOX_DIR (the sandbox inside the bundle for the app), otherwise sandbox in the current directory
 * - Settings are read from the config file (PACENOTE_HOME/.env), and existing environment variables take precedence. (Same as node --env-file)
 * - The compose project name (pacenote-sandbox) is the same, so the repository and the app manage the same containers.
 */
export const JOB_KINDS = ["images", "proxy", "broker", "kubeconfig"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export interface JobContext {
  sandboxDir: string;
  /** Config file. If present, it is also passed to compose as --env-file. */
  envFile?: string;
}

export type JobStep =
  | { kind: "allowlist" }
  | { kind: "broker-files" }
  | { kind: "broker-bundle" }
  | { kind: "kubeconfig" }
  | { kind: "credentials" }
  | { kind: "compose"; args: string[] };

/** Turns a job into steps. (Does not run them) */
export function planJob(kind: JobKind, ctx: JobContext): JobStep[] {
  const compose = (...args: string[]) => ({
    kind: "compose" as const,
    args: ["compose", "-f", path.join(ctx.sandboxDir, "compose.yaml"), ...args],
  });
  switch (kind) {
    case "images":
      return [compose("--profile", "build", "build")];
    case "proxy":
      return [
        { kind: "allowlist" },
        compose("up", "-d", "--build", "--force-recreate", "egress-proxy"),
      ];
    case "broker":
      return [
        { kind: "broker-bundle" },
        { kind: "allowlist" },
        { kind: "broker-files" },
        { kind: "credentials" },
        compose(
          ...(ctx.envFile ? ["--env-file", ctx.envFile] : []),
          "--profile",
          "ops",
          "up",
          "-d",
          "--build",
          "--force-recreate",
          "ops-broker"
        ),
      ];
    case "kubeconfig":
      return [{ kind: "kubeconfig" }];
  }
}

/**
 * Overlays the current environment variables on the config file values and maps the names from before the
 * renames (ORBLY_*, VERDA_* -> PACENOTE_*, reported through warn). PACENOTE_HOME is always passed resolved, so
 * compose uses the same location as the app even when it is still ~/.orbly or ~/.verda.
 */
export function jobEnv(
  base: NodeJS.ProcessEnv,
  envFile: string,
  warn: (message: string) => void = () => {}
): NodeJS.ProcessEnv {
  const fromFile = readEnvValues(readEnvFile(envFile));
  const merged: NodeJS.ProcessEnv = { ...fromFile };
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) merged[key] = value;
  }
  const home = base.HOME || homedir();
  warnOnce(
    [legacyHomeWarning(base, home), ...applyLegacyEnv(merged)].filter(
      (message): message is string => message !== undefined
    ),
    warn
  );
  merged.PACENOTE_HOME = pacenoteHome(base, home);
  return merged;
}

const capture = (command: string, args: string[], env: NodeJS.ProcessEnv) => {
  const result = spawnSync(command, args, { env, encoding: "utf8", timeout: 15_000 });
  return result.status === 0 ? result.stdout.trim() : "";
};

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: "inherit" });
    child.on("error", (err) =>
      reject(new Error(`Failed to run ${command}: ${err.message}`))
    );
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}.`))
    );
  });
}

async function main(): Promise<void> {
  const [kind, ...flags] = process.argv.slice(2);
  if (!JOB_KINDS.includes(kind as JobKind))
    throw new Error(`Usage: sandbox-job <${JOB_KINDS.join("|")}> [--dry-run]`);
  const dryRun = flags.includes("--dry-run");
  const sandboxDir = path.resolve(envValue(process.env, "SANDBOX_DIR") || "sandbox");
  const envFile = envFilePath();
  const env = jobEnv(process.env, envFile, (message) => console.warn(`WARN ${message}`));
  const log = (line: string) => console.log(line);
  const steps = planJob(kind as JobKind, {
    sandboxDir,
    envFile: existsSync(envFile) ? envFile : undefined,
  });

  for (const step of steps) {
    switch (step.kind) {
      case "allowlist": {
        const file = allowlistPath(env);
        log(`Allowed domains list: ${file}`);
        if (!dryRun)
          ensureAllowlistFile(file, path.join(sandboxDir, "proxy/allowed-domains.txt"));
        break;
      }
      case "broker-bundle": {
        const bundle = path.join(sandboxDir, "ops-broker/dist/server.mjs");
        if (!existsSync(bundle))
          throw new Error(
            `Broker bundle not found: ${bundle} (run pnpm bundle in the repository)`
          );
        break;
      }
      case "broker-files":
        if (!dryRun) await prepareBrokerFiles(loadBrokerEnv(env), env, log);
        break;
      case "credentials":
        // PRs use the gh login account, the commit author uses OPS_GIT_AUTHOR_* or the global git config (repository local config is not consulted)
        env.GH_TOKEN ||= capture("gh", ["auth", "token"], env);
        env.GIT_AUTHOR_NAME ||= capture("git", ["config", "--global", "user.name"], env);
        env.GIT_AUTHOR_EMAIL ||= capture(
          "git",
          ["config", "--global", "user.email"],
          env
        );
        log(
          `GitHub token ${env.GH_TOKEN ? "present" : "missing (gh auth login)"}, commit author ${env.GIT_AUTHOR_EMAIL || "none"}`
        );
        break;
      case "kubeconfig":
        if (!dryRun) await writeKubeconfig(loadBrokerEnv(env), env, log);
        break;
      case "compose":
        log(`$ docker ${step.args.join(" ")}`);
        if (!dryRun) await run("docker", step.args, env);
        break;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error((err as Error).message);
    process.exitCode = 1;
  });
}
