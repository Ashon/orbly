import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { configFingerprint } from "../config.js";
import { readBotStatus } from "../runtime/status.js";
import { readEnvFile, readEnvValues } from "../settings/env-file.js";
import { brokerRuntimeDir } from "../settings/paths.js";
import { parseAllowlist, readAllowlistFile, REQUIRED_DOMAINS } from "./allowlist.js";
import { brokerExpected } from "./env.js";
import type {
  BrokerHealth,
  ContainerState,
  PendingApply,
  SandboxCheck,
  SandboxStatus,
} from "./types.js";

export const SANDBOX_IMAGES = [
  { name: "verda-reasoner:latest", purpose: "추론 (요청마다 실행)" },
  { name: "verda-renderer:latest", purpose: "그림 렌더링" },
  { name: "verda-egress-proxy:latest", purpose: "바깥 접속 프록시" },
  { name: "verda-ops-broker:latest", purpose: "운영 도구 broker" },
];
const CONTAINERS = {
  "egress-proxy": "verda-sandbox-egress-proxy-1",
  "ops-broker": "verda-sandbox-ops-broker-1",
} as const;
/** broker 환경 변수 중 비교에 쓰는 것만 읽는다. (GH_TOKEN 등은 읽지 않는다) */
const BROKER_ENV_KEYS = [
  "SSH_USER",
  "ALLOWED_CIDR",
  "GIT_ALLOWED_OWNERS",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "JIRA_URL",
  "JIRA_EMAIL",
  "JIRA_PROJECTS",
] as const;

export function parseHealthz(text: string): BrokerHealth | undefined {
  if (!text.startsWith("ok")) return undefined;
  const field = (name: string) =>
    new RegExp(`${name}=(\\[[^\\]]*\\]|\\S+)`).exec(text)?.[1];
  const list = (value?: string) =>
    (value ?? "")
      .replace(/^\[|\]$/g, "")
      .split(/[,|]/)
      .map((item) => item.trim())
      .filter(Boolean);
  const fs = field("fs");
  const github = field("github");
  const jira = field("jira");
  return {
    sshHosts: Number(field("hosts") ?? 0),
    k8s: list(field("k8s")),
    fs: fs && fs !== "off" ? fs : undefined,
    git: field("git") === "on",
    github: github && github !== "off" ? list(github) : [],
    jira: jira && jira !== "off" ? list(jira) : [],
  };
}

/** KEY=value 목록에서 고른 키만 남긴다. */
export function pickEnv(
  entries: string[],
  keys: readonly string[]
): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const entry of entries) {
    const index = entry.indexOf("=");
    const key = entry.slice(0, index);
    if (keys.includes(key)) picked[key] = entry.slice(index + 1);
  }
  return picked;
}

export interface PendingInput {
  /** 봇이 살아 있을 때만 */
  bot?: { configHash?: string; expectedHash: string };
  proxy?: { running: boolean; startedAt?: number; allowlistMtime?: number };
  broker?: {
    running: boolean;
    startedAt?: number;
    imageOutdated: boolean;
    sourceMtime?: number;
    imageCreatedAt?: number;
    env: Record<string, string>;
    mounts: Record<string, string>;
    hostsMtime?: number;
    kubeconfigMtime?: number;
    expected: ReturnType<typeof brokerExpected>;
    /** 다시 띄우면 쓸 커밋 작성자 (OPS_GIT_AUTHOR_*, 없으면 전역 git 설정) */
    author?: { name: string; email: string };
  };
}

const owners = (value?: string) =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .join(",");

/** 바뀐 설정이 아직 적용되지 않은 구성 요소와 이유 */
export function computePending(input: PendingInput): PendingApply[] {
  const pending: PendingApply[] = [];
  const { bot, proxy, broker } = input;
  if (bot && bot.configHash && bot.configHash !== bot.expectedHash) {
    pending.push({
      component: "bot",
      reason: "봇이 시작된 뒤 .env 설정이 바뀌었습니다.",
    });
  }
  if (proxy) {
    if (!proxy.running)
      pending.push({ component: "proxy", reason: "프록시가 실행 중이 아닙니다." });
    else if (
      proxy.allowlistMtime &&
      proxy.startedAt &&
      proxy.allowlistMtime > proxy.startedAt
    ) {
      pending.push({
        component: "proxy",
        reason: "프록시가 시작된 뒤 허용 도메인 목록이 바뀌었습니다.",
      });
    }
  }
  if (broker) {
    if (!broker.running) {
      pending.push({ component: "broker", reason: "broker 가 실행 중이 아닙니다." });
      return pending;
    }
    const e = broker.expected;
    const env = broker.env;
    const diffs: string[] = [];
    if (env.SSH_USER !== undefined && env.SSH_USER !== e.sshUser)
      diffs.push("SSH 사용자");
    if (env.ALLOWED_CIDR !== undefined && env.ALLOWED_CIDR !== e.allowedCidr)
      diffs.push("SSH 허용 대역");
    if (
      env.GIT_ALLOWED_OWNERS !== undefined &&
      owners(env.GIT_ALLOWED_OWNERS) !== owners(e.allowedOwners)
    ) {
      diffs.push("GitHub 허용 조직");
    }
    if (broker.mounts["/workspace"] && broker.mounts["/workspace"] !== e.fsRoot)
      diffs.push("파일 조회 루트");
    if (
      broker.mounts["/run/secrets/ssh-key"] &&
      broker.mounts["/run/secrets/ssh-key"] !== e.sshKey
    ) {
      diffs.push("SSH 키 경로");
    }
    if (
      broker.mounts["/run/secrets/known_hosts"] &&
      broker.mounts["/run/secrets/known_hosts"] !== e.knownHosts
    ) {
      diffs.push("known_hosts 경로");
    }
    if (
      (env.JIRA_URL !== undefined && env.JIRA_URL !== e.jiraUrl) ||
      (env.JIRA_EMAIL !== undefined && env.JIRA_EMAIL !== e.jiraEmail) ||
      (env.JIRA_PROJECTS !== undefined &&
        owners(env.JIRA_PROJECTS).toUpperCase() !== owners(e.jiraProjects).toUpperCase())
    ) {
      diffs.push("Jira 설정");
    }
    const author = broker.author;
    if (
      author?.email &&
      env.GIT_AUTHOR_EMAIL !== undefined &&
      (env.GIT_AUTHOR_NAME !== author.name || env.GIT_AUTHOR_EMAIL !== author.email)
    ) {
      diffs.push("PR 커밋 작성자");
    }
    if (diffs.length > 0) {
      pending.push({
        component: "broker",
        reason: `.env 와 다릅니다: ${diffs.join(", ")}`,
      });
    }
    const started = broker.startedAt ?? 0;
    if (broker.imageOutdated) {
      pending.push({
        component: "broker",
        reason: "새로 빌드된 broker 이미지가 있습니다.",
      });
    } else if (
      broker.sourceMtime &&
      broker.imageCreatedAt &&
      broker.sourceMtime > broker.imageCreatedAt
    ) {
      pending.push({
        component: "broker",
        reason: "broker 코드가 이미지보다 새롭습니다. (다시 빌드 필요)",
      });
    }
    if (broker.hostsMtime && broker.hostsMtime > started) {
      pending.push({
        component: "broker",
        reason: "호스트 목록이 broker 시작 뒤에 바뀌었습니다.",
      });
    }
    if (broker.kubeconfigMtime && broker.kubeconfigMtime > started) {
      pending.push({
        component: "broker",
        reason: "kubeconfig 가 broker 시작 뒤에 바뀌었습니다.",
      });
    }
  }
  return pending;
}

type Run = (
  command: string,
  args: string[]
) => Promise<{ code: number; stdout: string; stderr: string }>;

export function commandRunner(env: NodeJS.ProcessEnv, cwd: string): Run {
  return (command, args) =>
    new Promise((resolve) => {
      execFile(
        command,
        args,
        { env, cwd, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const code = err
            ? typeof (err as { code?: unknown }).code === "number"
              ? (err as { code: number }).code
              : 1
            : 0;
          resolve({ code, stdout: String(stdout), stderr: String(stderr) });
        }
      );
    });
}

const mtime = (file: string) => (existsSync(file) ? statSync(file).mtimeMs : undefined);
const newest = (dir: string): number =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).reduce(
        (max, item) =>
          Math.max(
            max,
            item.isDirectory()
              ? newest(path.join(dir, item.name))
              : statSync(path.join(dir, item.name)).mtimeMs
          ),
        0
      )
    : 0;
const expandHome = (value: string, home: string) =>
  value === "~" || value.startsWith("~/") ? path.join(home, value.slice(1)) : value;

/**
 * 샌드박스 커밋 작성자. sandbox:ops-up 과 같은 순서로 정한다: .env 의 OPS_GIT_AUTHOR_*, 없으면 전역 git 설정.
 * 이 저장소의 로컬 git 설정은 보지 않는다.
 */
async function sandboxAuthor(
  values: NodeJS.ProcessEnv,
  run: Run
): Promise<{ name: string; email: string; source: string }> {
  const fromGlobal = async (key: string) =>
    (await run("git", ["config", "--global", key])).stdout.trim();
  const name = values.OPS_GIT_AUTHOR_NAME?.trim() || (await fromGlobal("user.name"));
  const email = values.OPS_GIT_AUTHOR_EMAIL?.trim() || (await fromGlobal("user.email"));
  const fromEnv = Boolean(
    values.OPS_GIT_AUTHOR_NAME?.trim() || values.OPS_GIT_AUTHOR_EMAIL?.trim()
  );
  return { name, email, source: fromEnv ? ".env" : "전역 git 설정" };
}

/**
 * 샌드박스 상태를 모은다. docker, 이미지, 컨테이너, broker 상태, 자격 증명 파일, 적용 대기 항목.
 * 비밀 값은 읽지 않는다. (파일이 있는지, GitHub 로그인이 되어 있는지만 본다)
 */
export async function collectSandboxStatus(options: {
  repoRoot: string;
  /** 설정 파일 (저장소 밖, src/settings/paths.ts) */
  envFile: string;
  dataDir: string;
  /** 봇과 같은 우선순위로 쓰는 앱의 환경 변수 */
  env: NodeJS.ProcessEnv;
  run: Run;
  home?: string;
}): Promise<SandboxStatus> {
  const { repoRoot, run } = options;
  const home = options.home ?? homedir();
  const values: NodeJS.ProcessEnv = {
    ...readEnvValues(readEnvFile(options.envFile)),
    ...options.env,
  };
  const reasoner = values.REASONER === "codex" ? "codex" : "claude";
  const useDocker = values.REASONER_SANDBOX === "docker";
  const opsOn = values.OPS_TOOLS === "on";
  const allowlistFile = path.join(repoRoot, "sandbox/proxy/allowed-domains.txt");

  const status: SandboxStatus = {
    checkedAt: new Date().toISOString(),
    docker: { ok: false },
    images: [],
    containers: [],
    checks: [],
    pending: [],
    allowlist: {
      file: allowlistFile,
      domains: parseAllowlist(readAllowlistFile(allowlistFile)),
      required: REQUIRED_DOMAINS[reasoner],
    },
    activeRequests: 0,
  };

  const version = await run("docker", ["version", "--format", "{{.Server.Version}}"]);
  status.docker =
    version.code === 0
      ? { ok: true, version: version.stdout.trim() }
      : {
          ok: false,
          error: (version.stderr || version.stdout).trim().split("\n").at(-1),
        };

  const images = new Map<string, { id: string; createdAt: number }>();
  if (status.docker.ok) {
    for (const image of SANDBOX_IMAGES) {
      const result = await run("docker", [
        "image",
        "inspect",
        "--format",
        "{{.Id}} {{.Created}}",
        image.name,
      ]);
      const [id, created] = result.stdout.trim().split(" ");
      if (result.code === 0 && id && created)
        images.set(image.name, { id, createdAt: Date.parse(created) });
      status.images.push({
        ...image,
        present: result.code === 0,
        createdAt:
          created && result.code === 0
            ? new Date(Date.parse(created)).toISOString()
            : undefined,
      });
    }
  }

  interface Inspect {
    Image: string;
    Created: string;
    State: { Status: string; StartedAt: string };
    Config: { Env?: string[] };
    Mounts?: { Source: string; Destination: string }[];
  }
  const inspect = async (name: string): Promise<Inspect | undefined> => {
    if (!status.docker.ok) return undefined;
    const result = await run("docker", ["inspect", "--format", "{{json .}}", name]);
    if (result.code !== 0) return undefined;
    try {
      return JSON.parse(result.stdout) as Inspect;
    } catch {
      return undefined;
    }
  };
  const proxy = await inspect(CONTAINERS["egress-proxy"]);
  const broker = await inspect(CONTAINERS["ops-broker"]);
  for (const [service, data] of [
    ["egress-proxy", proxy],
    ["ops-broker", broker],
  ] as const) {
    const state: ContainerState = { service, state: data?.State.Status ?? "missing" };
    if (data?.State.Status === "running") state.startedAt = data.State.StartedAt;
    status.containers.push(state);
  }

  if (broker?.State.Status === "running") {
    const health = await run("docker", [
      "exec",
      CONTAINERS["ops-broker"],
      "node",
      "-e",
      "fetch('http://127.0.0.1:8080/healthz').then(r=>r.text()).then(t=>process.stdout.write(t)).catch(()=>process.exit(1))",
    ]);
    if (health.code === 0) status.broker = parseHealthz(health.stdout.trim());
  }

  // 자격 증명과 생성 파일 (값은 읽지 않는다)
  const runtimeDir = brokerRuntimeDir(options.env, home);
  const expected = brokerExpected(values, runtimeDir);
  let author: Awaited<ReturnType<typeof sandboxAuthor>> | undefined;
  const hostsFile = path.join(runtimeDir, "hosts.json");
  const kubeconfig = path.join(runtimeDir, "kubeconfig");
  const fileCheck = (label: string, file: string): SandboxCheck =>
    existsSync(file)
      ? { label, ok: true, detail: file }
      : { label, ok: false, detail: `없음: ${file}` };
  if (useDocker && reasoner === "codex") {
    status.checks.push(
      fileCheck(
        "codex 로그인 파일",
        expandHome(values.SANDBOX_CODEX_AUTH_FILE || "~/.codex/auth.json", home)
      )
    );
  }
  if (useDocker && reasoner === "claude") {
    const set = Boolean(
      values.SANDBOX_CLAUDE_OAUTH_TOKEN || values.SANDBOX_ANTHROPIC_API_KEY
    );
    status.checks.push({
      label: "샌드박스 claude 토큰",
      ok: set,
      detail: set ? "설정됨" : "SANDBOX_CLAUDE_OAUTH_TOKEN 필요",
    });
  }
  // 설정한 기능만 확인한다. 비운 기능은 broker 가 도구 없이 뜬다. (broker 도구 줄에 꺼짐으로 보인다)
  if ((opsOn || broker) && expected.configured.ssh) {
    status.checks.push(fileCheck("SSH 키", expected.sshKey));
    if (values.OPS_SSH_KNOWN_HOSTS?.trim())
      status.checks.push(fileCheck("SSH known_hosts", expected.knownHosts));
    let hostCount = 0;
    try {
      hostCount = Object.keys(
        JSON.parse(readFileSync(hostsFile, "utf8")) as object
      ).length;
    } catch {
      // 없거나 비어 있다.
    }
    const fromInventory = Boolean(
      values.OPS_SSH_INVENTORY_DIR?.trim() && values.OPS_SSH_INVENTORY?.trim()
    );
    status.checks.push({
      label: "호스트 목록",
      ok: hostCount > 0,
      detail:
        hostCount > 0
          ? `${hostCount}개 (${fromInventory ? "broker 를 띄울 때 인벤토리에서 다시 만든다" : "hosts.json 을 직접 관리"})`
          : fromInventory
            ? "없음 (broker 를 띄울 때 만든다)"
            : "없음 (OPS_SSH_INVENTORY 를 설정하거나 hosts.json 을 직접 쓴다)",
    });
  }
  if (opsOn || broker) {
    const kubeSize = existsSync(kubeconfig) ? statSync(kubeconfig).size : 0;
    status.checks.push({
      label: "k8s kubeconfig",
      ok: kubeSize > 0,
      detail:
        kubeSize > 0 ? "있음" : "비어 있음 (k8s 도구 꺼짐, kubeconfig 다시 만들기 필요)",
    });
    const jiraKeys = [
      "OPS_JIRA_URL",
      "OPS_JIRA_EMAIL",
      "OPS_JIRA_TOKEN",
      "OPS_JIRA_PROJECTS",
    ] as const;
    if (jiraKeys.some((key) => values[key]?.trim())) {
      const missing = jiraKeys.filter((key) => !values[key]?.trim());
      status.checks.push({
        label: "Jira",
        ok: missing.length === 0,
        detail:
          missing.length === 0
            ? `${values.OPS_JIRA_URL} (${values.OPS_JIRA_PROJECTS}, ${values.OPS_JIRA_EMAIL})`
            : `${missing.join(", ")} 필요`,
      });
    }
    const gh = await run("gh", [
      "auth",
      "status",
      "--active",
      "--hostname",
      "github.com",
    ]);
    const account = /account (\S+)/.exec(gh.stdout + gh.stderr)?.[1];
    status.checks.push({
      label: "GitHub 로그인 (gh)",
      ok: gh.code === 0,
      detail:
        gh.code === 0
          ? `${account ?? "로그인됨"} (broker 를 띄울 때 토큰을 넘긴다)`
          : "gh auth login 필요",
    });
    author = await sandboxAuthor(values, run);
    status.checks.push({
      label: "PR 커밋 작성자",
      ok: Boolean(author.name && author.email),
      detail:
        author.name && author.email
          ? `${author.name} <${author.email}> (${author.source})`
          : "OPS_GIT_AUTHOR_NAME, OPS_GIT_AUTHOR_EMAIL 또는 git config --global 필요",
    });
  }

  // 적용 대기
  const bot = readBotStatus(options.dataDir);
  status.activeRequests = bot.alive ? (bot.status?.requests.active ?? 0) : 0;
  const brokerImage = images.get("verda-ops-broker:latest");
  status.pending = computePending({
    bot: bot.alive
      ? { configHash: bot.status?.configHash, expectedHash: configFingerprint(values) }
      : undefined,
    proxy:
      useDocker || proxy
        ? {
            running: proxy?.State.Status === "running",
            startedAt: proxy ? Date.parse(proxy.State.StartedAt) : undefined,
            allowlistMtime: mtime(allowlistFile),
          }
        : undefined,
    broker:
      opsOn || broker
        ? {
            running: broker?.State.Status === "running",
            startedAt: broker ? Date.parse(broker.State.StartedAt) : undefined,
            imageOutdated: Boolean(
              broker && brokerImage && broker.Image !== brokerImage.id
            ),
            imageCreatedAt: brokerImage?.createdAt,
            sourceMtime: newest(path.join(repoRoot, "src/broker")),
            env: pickEnv(broker?.Config.Env ?? [], BROKER_ENV_KEYS),
            mounts: Object.fromEntries(
              (broker?.Mounts ?? []).map((m) => [m.Destination, m.Source])
            ),
            hostsMtime: mtime(hostsFile),
            kubeconfigMtime: mtime(kubeconfig),
            expected,
            author,
          }
        : undefined,
  });
  return status;
}
