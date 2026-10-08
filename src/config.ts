import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { readCodexDefaults } from "./reasoner/codex-config.js";
import type { DockerSandboxOptions } from "./reasoner/executor.js";
import type { McpServerRef } from "./reasoner/index.js";

const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";

const csv = z
  .string()
  .optional()
  .transform((value) =>
    (value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  );

/** 쉼표로 구분한 Slack 사용자 ID 목록. (U..., W...) */
const userIds = csv.pipe(
  z.array(
    z
      .string()
      .transform((id) => id.toUpperCase())
      .pipe(
        z.string().regex(/^[UW][A-Z0-9]+$/, "Slack 사용자 ID(U... 또는 W...)여야 합니다")
      )
  )
);

export const EnvSchema = z.object({
  SLACK_BOT_TOKEN: z
    .string()
    .startsWith("xoxb-", "xoxb- 로 시작하는 봇 토큰이어야 합니다"),
  SLACK_APP_TOKEN: z
    .string()
    .startsWith("xapp-", "xapp- 로 시작하는 앱 토큰이어야 합니다"),
  /** 봇이 보낸 ping 에 이 시간 안에 pong 이 없으면 다시 연결한다. */
  SOCKET_CLIENT_PING_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(60_000)
    .default(5000),
  /** Slack 서버의 ping 이 이 시간 동안 없으면 다시 연결한다. */
  SOCKET_SERVER_PING_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(5000)
    .max(300_000)
    .default(30_000),
  /** ping/pong 을 로그에 남긴다. (LOG_LEVEL=debug 일 때 보인다) */
  SOCKET_PING_PONG_LOG: z.enum(["on", "off"]).default("off"),
  TIMEZONE: z.string().default("Asia/Seoul"),

  MENTION_ALLOWED_USERS: userIds,
  MENTION_WORKSPACE: z.string().optional(),
  MENTION_CONCURRENCY: z.coerce.number().int().positive().default(2),

  REASONER: z.enum(["claude", "codex"]).default("claude"),
  REASONER_MODEL: z.string().optional(),
  REASONER_TIMEOUT_SEC: z.coerce.number().int().positive().default(900),
  CLAUDE_BIN: z.string().default("claude"),
  CODEX_BIN: z.string().default("codex"),
  REASONER_SANDBOX: z.enum(["none", "docker"]).default("none"),
  DOCKER_BIN: z.string().default("docker"),
  SANDBOX_IMAGE: z.string().default("verda-reasoner:latest"),
  SANDBOX_NETWORK: z.string().default("verda-sandbox"),
  SANDBOX_PROXY_URL: z.string().url().default("http://egress-proxy:8888"),
  SANDBOX_MEMORY: z
    .string()
    .regex(/^\d+(\.\d+)?[bkmg]?$/i, "docker --memory 형식이어야 합니다 (예: 2g, 1536m)")
    .default("2g"),
  SANDBOX_CPUS: z
    .string()
    .regex(/^\d+(\.\d+)?$/, "CPU 수여야 합니다 (예: 2, 1.5)")
    .default("2"),
  SANDBOX_CLAUDE_OAUTH_TOKEN: z.string().optional(),
  SANDBOX_ANTHROPIC_API_KEY: z.string().optional(),
  SANDBOX_CODEX_AUTH_FILE: z.string().default("~/.codex/auth.json"),

  OPS_TOOLS: z.enum(["off", "on"]).default("off"),
  OPS_BROKER_URL: z.string().url().default("http://ops-broker:8080/mcp"),

  RENDER_DIAGRAMS: z.enum(["on", "off"]).default("on"),
  RENDERER_IMAGE: z.string().default("verda-renderer:latest"),
  /** 생성 이미지의 긴 변 최대 px. 0 이면 원본 크기 */
  GENERATED_IMAGE_MAX_PX: z.coerce.number().int().min(0).max(4096).default(512),

  /** 실행 기록, 봇 상태, 로그를 두는 곳. 데스크톱 앱이 읽는다. */
  VERDA_DATA_DIR: z.string().default("~/.verda"),
  /** 실행 기록(VERDA_DATA_DIR/runs) */
  HISTORY: z.enum(["on", "off"]).default("on"),
  /** 이 날짜 수보다 오래된 기록은 지운다. 0 이면 지우지 않는다. */
  HISTORY_RETENTION_DAYS: z.coerce.number().int().min(0).default(30),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export interface Config {
  slack: {
    botToken: string;
    appToken: string;
    socket: {
      clientPingTimeoutMs: number;
      serverPingTimeoutMs: number;
      pingPongLogging: boolean;
    };
  };
  timezone: string;
  mention: {
    /** 이 사용자들의 멘션에만 답한다. 비어 있으면 모든 사용자 */
    allowedUserIds: string[];
    /** 답변 시 읽기 전용으로 참고할 디렉터리 */
    workspace?: string;
    /** 동시에 실행할 CLI 수 */
    concurrency: number;
  };
  reasoner: {
    backend: "claude" | "codex";
    /** 비어 있으면 codex 는 ~/.codex/config.toml 의 모델을 쓴다. */
    model?: string;
    codexReasoningEffort?: string;
    timeoutMs: number;
    claudeBin: string;
    codexBin: string;
    /** 설정되어 있으면 CLI 를 일회용 도커 컨테이너 안에서 실행한다. */
    sandbox?: DockerSandboxOptions;
    /** 추론 CLI 에 붙일 MCP 서버. OPS_TOOLS=on 이면 ops-broker (SSH 호스트 점검, k8s, 파일 조회) */
    mcpServers: McpServerRef[];
  };
  /** 답변의 mermaid/dot/vega-lite/svg 블록을 PNG 로 그려 올린다. (docker 필요) */
  render: {
    enabled: boolean;
    dockerBin: string;
    image: string;
    /** 생성 이미지를 올리기 전에 긴 변을 이 크기로 줄인다. 0 이면 원본 */
    generatedMaxPx: number;
  };
  /** 실행 기록, 봇 상태(bot.json), 로그(logs/bot.log)를 두는 디렉터리 */
  dataDir: string;
  /** 실행 기록. 꺼져 있으면 undefined */
  history?: {
    retentionDays: number;
  };
  logLevel: "debug" | "info" | "warn" | "error";
}

/** .env 에 "KEY=" 처럼 빈 값으로 둔 항목은 설정하지 않은 것으로 본다. */
const providedValues = (env: NodeJS.ProcessEnv) =>
  Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value.trim() !== "")
  );

/**
 * 봇 설정 지문. 봇이 시작할 때 상태 파일에 남기고, 데스크톱 앱이 지금 .env 로 계산한 값과 비교해
 * 재시작이 필요한지 판단한다. (값 자체는 남기지 않는다)
 */
export function configFingerprint(env: NodeJS.ProcessEnv): string {
  const provided = providedValues(env);
  const entries = Object.keys(EnvSchema.shape)
    // 데이터 위치는 데스크톱 앱이 봇을 띄울 때 절대 경로로 넘기므로 비교하지 않는다.
    .filter((key) => key !== "VERDA_DATA_DIR")
    .sort()
    .flatMap((key) => (provided[key] === undefined ? [] : [[key, provided[key]]]));
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex").slice(0, 16);
}

export interface ConfigIssue {
  /** 문제가 된 환경 변수. 여러 값이 얽힌 문제면 대표 값 */
  key?: string;
  message: string;
}

/** 설정 화면용 검증. loadConfig 와 같은 규칙으로 보고, 문제를 환경 변수별로 돌려준다. */
export function checkConfig(env: NodeJS.ProcessEnv): ConfigIssue[] {
  const parsed = EnvSchema.safeParse(providedValues(env));
  if (!parsed.success) {
    return parsed.error.issues.map((issue) => ({
      key: issue.path[0] === undefined ? undefined : String(issue.path[0]),
      message: issue.message,
    }));
  }
  try {
    loadConfig(env);
    return [];
  } catch (err) {
    const message = (err as Error).message;
    // 메시지에 처음 나오는 환경 변수 이름을 대표 값으로 본다.
    const keys = new Set(Object.keys(EnvSchema.shape));
    const key = message.match(/[A-Z][A-Z0-9_]+/g)?.find((word) => keys.has(word));
    return [{ key, message }];
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(providedValues(env));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `- ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`환경 변수 설정이 올바르지 않습니다.\n${issues}`);
  }
  const e = parsed.data;

  const workspace = e.MENTION_WORKSPACE ? expandHome(e.MENTION_WORKSPACE) : undefined;
  if (workspace && !isDirectory(workspace)) {
    throw new Error(
      `MENTION_WORKSPACE 는 존재하는 절대 경로 디렉터리여야 합니다: ${workspace}`
    );
  }

  return {
    slack: {
      botToken: e.SLACK_BOT_TOKEN,
      appToken: e.SLACK_APP_TOKEN,
      socket: {
        clientPingTimeoutMs: e.SOCKET_CLIENT_PING_TIMEOUT_MS,
        serverPingTimeoutMs: e.SOCKET_SERVER_PING_TIMEOUT_MS,
        pingPongLogging: e.SOCKET_PING_PONG_LOG === "on",
      },
    },
    timezone: e.TIMEZONE,
    mention: {
      allowedUserIds: [...new Set(e.MENTION_ALLOWED_USERS)],
      workspace,
      concurrency: e.MENTION_CONCURRENCY,
    },
    reasoner: buildReasonerConfig(e),
    render: {
      enabled: e.RENDER_DIAGRAMS === "on",
      dockerBin: e.DOCKER_BIN,
      image: e.RENDERER_IMAGE,
      generatedMaxPx: e.GENERATED_IMAGE_MAX_PX,
    },
    dataDir: path.resolve(expandHome(e.VERDA_DATA_DIR)),
    history: e.HISTORY === "on" ? { retentionDays: e.HISTORY_RETENTION_DAYS } : undefined,
    logLevel: e.LOG_LEVEL,
  };
}

function isDirectory(dir: string): boolean {
  return path.isAbsolute(dir) && existsSync(dir) && statSync(dir).isDirectory();
}

function expandHome(file: string): string {
  return file === "~" || file.startsWith("~/")
    ? path.join(homedir(), file.slice(1))
    : file;
}

type Env = z.infer<typeof EnvSchema>;

function buildReasonerConfig(e: Env): Config["reasoner"] {
  const base: Config["reasoner"] = {
    mcpServers: [],
    backend: e.REASONER,
    model:
      e.REASONER_MODEL ?? (e.REASONER === "claude" ? DEFAULT_CLAUDE_MODEL : undefined),
    timeoutMs: e.REASONER_TIMEOUT_SEC * 1000,
    claudeBin: e.CLAUDE_BIN,
    codexBin: e.CODEX_BIN,
  };
  if (e.OPS_TOOLS === "on") {
    // ops-broker 는 SSH 키, 클러스터 조회 토큰, 작업 디렉터리를 쓴다.
    // 샌드박스와 허용 사용자 목록 없이는 켜지 않는다.
    if (e.REASONER_SANDBOX !== "docker") {
      throw new Error("OPS_TOOLS=on 은 REASONER_SANDBOX=docker 에서만 쓸 수 있습니다.");
    }
    if (e.MENTION_ALLOWED_USERS.length === 0) {
      throw new Error(
        "OPS_TOOLS=on 이면 MENTION_ALLOWED_USERS 로 사용할 사람을 지정해야 합니다."
      );
    }
    base.mcpServers = [{ name: "ops", url: e.OPS_BROKER_URL }];
  }
  if (e.REASONER_SANDBOX !== "docker") return base;

  // 컨테이너에는 호스트 키체인/설정이 없으므로 인증 수단을 명시적으로 넘긴다.
  const claudeEnv: Record<string, string> = {};
  if (e.SANDBOX_CLAUDE_OAUTH_TOKEN) {
    claudeEnv.CLAUDE_CODE_OAUTH_TOKEN = e.SANDBOX_CLAUDE_OAUTH_TOKEN;
  } else if (e.SANDBOX_ANTHROPIC_API_KEY) {
    claudeEnv.ANTHROPIC_API_KEY = e.SANDBOX_ANTHROPIC_API_KEY;
  }
  if (e.REASONER === "claude" && Object.keys(claudeEnv).length === 0) {
    throw new Error(
      "REASONER_SANDBOX=docker 에서 claude 를 쓰려면 SANDBOX_CLAUDE_OAUTH_TOKEN (claude setup-token) 또는 SANDBOX_ANTHROPIC_API_KEY 가 필요합니다."
    );
  }

  const codexAuthFile = expandHome(e.SANDBOX_CODEX_AUTH_FILE);
  if (e.REASONER === "codex") {
    if (!path.isAbsolute(codexAuthFile) || !existsSync(codexAuthFile)) {
      throw new Error(
        `REASONER_SANDBOX=docker 에서 codex 를 쓰려면 codex 로그인 파일이 필요합니다: ${codexAuthFile}`
      );
    }
    if (!e.REASONER_MODEL) {
      const defaults = readCodexDefaults(
        path.join(path.dirname(codexAuthFile), "config.toml")
      );
      base.model = defaults.model;
      base.codexReasoningEffort = defaults.reasoningEffort;
    }
  }

  return {
    ...base,
    sandbox: {
      dockerBin: e.DOCKER_BIN,
      image: e.SANDBOX_IMAGE,
      network: e.SANDBOX_NETWORK,
      proxyUrl: e.SANDBOX_PROXY_URL,
      memory: e.SANDBOX_MEMORY,
      cpus: e.SANDBOX_CPUS,
      claudeEnv: e.REASONER === "claude" ? claudeEnv : {},
      codexAuthFile: e.REASONER === "codex" ? codexAuthFile : undefined,
      noProxy: base.mcpServers.map((server) => new URL(server.url).hostname),
      requiredServices: e.OPS_TOOLS === "on" ? ["ops-broker"] : [],
    },
  };
}
