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
import { allowlistPath, envFilePath, verdaHome } from "../settings/paths.js";

/**
 * 샌드박스 적용 작업. 데스크톱 앱과 터미널(pnpm sandbox:*)이 같은 단계를 쓴다.
 * 사용: sandbox-job <images|proxy|broker|kubeconfig> [--dry-run]
 * - sandbox 디렉터리는 VERDA_SANDBOX_DIR (앱은 번들 안의 sandbox), 없으면 현재 디렉터리의 sandbox
 * - 설정은 설정 파일(VERDA_HOME/.env)을 읽고, 이미 있는 환경 변수가 우선한다. (node --env-file 과 같음)
 * - compose 프로젝트 이름(verda-sandbox)이 같아서 저장소와 앱이 같은 컨테이너를 다룬다.
 */
export const JOB_KINDS = ["images", "proxy", "broker", "kubeconfig"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export interface JobContext {
  sandboxDir: string;
  /** 설정 파일. 있으면 compose 의 --env-file 로도 넘긴다. */
  envFile?: string;
}

export type JobStep =
  | { kind: "allowlist" }
  | { kind: "broker-files" }
  | { kind: "broker-bundle" }
  | { kind: "kubeconfig" }
  | { kind: "credentials" }
  | { kind: "compose"; args: string[] };

/** 작업을 단계로 바꾼다. (실행하지 않는다) */
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

/** 설정 파일 값 위에 지금 환경 변수를 덮는다. compose 가 ~ 기본값과 같은 위치를 보도록 VERDA_HOME 을 펼쳐 둔다. */
export function jobEnv(base: NodeJS.ProcessEnv, envFile: string): NodeJS.ProcessEnv {
  const fromFile = readEnvValues(readEnvFile(envFile));
  const merged: NodeJS.ProcessEnv = { ...fromFile };
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) merged[key] = value;
  }
  // compose 의 기본값(${HOME}/.verda)과 같은 집 디렉터리를 쓴다.
  merged.VERDA_HOME = verdaHome(base, base.HOME || homedir());
  return merged;
}

const capture = (command: string, args: string[], env: NodeJS.ProcessEnv) => {
  const result = spawnSync(command, args, { env, encoding: "utf8", timeout: 15_000 });
  return result.status === 0 ? result.stdout.trim() : "";
};

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: "inherit" });
    child.on("error", (err) => reject(new Error(`${command} 실행 실패: ${err.message}`)));
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} 가 ${code} 로 끝났습니다.`))
    );
  });
}

async function main(): Promise<void> {
  const [kind, ...flags] = process.argv.slice(2);
  if (!JOB_KINDS.includes(kind as JobKind))
    throw new Error(`사용: sandbox-job <${JOB_KINDS.join("|")}> [--dry-run]`);
  const dryRun = flags.includes("--dry-run");
  const sandboxDir = path.resolve(process.env.VERDA_SANDBOX_DIR || "sandbox");
  const envFile = envFilePath();
  const env = jobEnv(process.env, envFile);
  const log = (line: string) => console.log(line);
  const steps = planJob(kind as JobKind, {
    sandboxDir,
    envFile: existsSync(envFile) ? envFile : undefined,
  });

  for (const step of steps) {
    switch (step.kind) {
      case "allowlist": {
        const file = allowlistPath(env);
        log(`허용 도메인 목록: ${file}`);
        if (!dryRun)
          ensureAllowlistFile(file, path.join(sandboxDir, "proxy/allowed-domains.txt"));
        break;
      }
      case "broker-bundle": {
        const bundle = path.join(sandboxDir, "ops-broker/dist/server.mjs");
        if (!existsSync(bundle))
          throw new Error(`broker 번들이 없습니다: ${bundle} (저장소에서는 pnpm bundle)`);
        break;
      }
      case "broker-files":
        if (!dryRun) await prepareBrokerFiles(loadBrokerEnv(env), env, log);
        break;
      case "credentials":
        // PR 은 gh 로그인 계정으로, 커밋 작성자는 OPS_GIT_AUTHOR_* 또는 전역 git 설정으로 (저장소 로컬 설정은 보지 않는다)
        env.GH_TOKEN ||= capture("gh", ["auth", "token"], env);
        env.GIT_AUTHOR_NAME ||= capture("git", ["config", "--global", "user.name"], env);
        env.GIT_AUTHOR_EMAIL ||= capture(
          "git",
          ["config", "--global", "user.email"],
          env
        );
        log(
          `GitHub 토큰 ${env.GH_TOKEN ? "있음" : "없음 (gh auth login)"}, 커밋 작성자 ${env.GIT_AUTHOR_EMAIL || "없음"}`
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
