import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { isSecureOrLocalUrl, slackApiBase } from "./messengers/slack/api.js";
import { defaultHome } from "./settings/legacy.js";
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

/** Comma-separated list of Slack user IDs. (U..., W...) */
const userIds = csv.pipe(
  z.array(
    z
      .string()
      .transform((id) => id.toUpperCase())
      .pipe(z.string().regex(/^[UW][A-Z0-9]+$/, "Must be a Slack user ID (U... or W...)"))
  )
);

export const EnvSchema = z.object({
  /**
   * How this bot reaches Slack. app: its own Slack app over Socket Mode (SLACK_BOT_TOKEN, SLACK_APP_TOKEN).
   * hub: the team hub, which holds the Slack app; this desktop answers its member's mentions through it (HUB_URL, HUB_TOKEN).
   */
  SLACK_CONNECTION: z.enum(["app", "hub"]).default("app"),
  SLACK_BOT_TOKEN: z
    .string()
    .startsWith("xoxb-", "Must be a bot token starting with xoxb-")
    .optional(),
  SLACK_APP_TOKEN: z
    .string()
    .startsWith("xapp-", "Must be an app token starting with xapp-")
    .optional(),
  /** Slack's Web API base for your own app. Defaults to slack.com; GovSlack, or a local stand-in for tests */
  SLACK_API_URL: z
    .string()
    .url()
    .refine(isSecureOrLocalUrl, "Must be an https URL (http only for localhost)")
    .optional(),
  /** The team hub (README "Team hub"). https, or http only for a hub on this computer */
  HUB_URL: z
    .string()
    .url()
    .refine(isSecureOrLocalUrl, "Must be an https URL (http only for localhost)")
    .optional(),
  /** This desktop's token for the hub, set by pairing in Settings > Messengers > Slack */
  HUB_TOKEN: z
    .string()
    .regex(/^[0-9a-f]{64}$/, "Must be the token pairing stored (64 hex characters)")
    .optional(),
  /** Reconnects if no pong arrives within this time after the bot sends a ping. */
  SOCKET_CLIENT_PING_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(60_000)
    .default(5000),
  /** Reconnects if the Slack server sends no ping for this long. */
  SOCKET_SERVER_PING_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(5000)
    .max(300_000)
    .default(30_000),
  /** Logs ping/pong. (Visible when LOG_LEVEL=debug) */
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
  SANDBOX_IMAGE: z.string().default("orbly-reasoner:latest"),
  SANDBOX_NETWORK: z.string().default("orbly-sandbox"),
  SANDBOX_PROXY_URL: z.string().url().default("http://egress-proxy:8888"),
  SANDBOX_MEMORY: z
    .string()
    .regex(/^\d+(\.\d+)?[bkmg]?$/i, "Must be in docker --memory format (e.g. 2g, 1536m)")
    .default("2g"),
  SANDBOX_CPUS: z
    .string()
    .regex(/^\d+(\.\d+)?$/, "Must be a CPU count (e.g. 2, 1.5)")
    .default("2"),
  SANDBOX_CLAUDE_OAUTH_TOKEN: z.string().optional(),
  SANDBOX_ANTHROPIC_API_KEY: z.string().optional(),
  SANDBOX_CODEX_AUTH_FILE: z.string().default("~/.codex/auth.json"),

  OPS_TOOLS: z.enum(["off", "on"]).default("off"),
  OPS_BROKER_URL: z.string().url().default("http://ops-broker:8080/mcp"),

  RENDER_DIAGRAMS: z.enum(["on", "off"]).default("on"),
  RENDERER_IMAGE: z.string().default("orbly-renderer:latest"),
  /** Max px of a generated image's long side. 0 keeps the original size */
  GENERATED_IMAGE_MAX_PX: z.coerce.number().int().min(0).max(4096).default(512),

  /** Where run history, bot status, and logs live. The desktop app reads it. Defaults to the home (~/.orbly, or ~/.verda before migrating) */
  PACENOTE_DATA_DIR: z.string().optional(),
  /** Run history (PACENOTE_DATA_DIR/runs) */
  HISTORY: z.enum(["on", "off"]).default("on"),
  /** Deletes history older than this many days. 0 keeps everything. */
  HISTORY_RETENTION_DAYS: z.coerce.number().int().min(0).default(30),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export interface Config {
  slack:
    | {
        kind: "app";
        botToken: string;
        appToken: string;
        /** Web API base, with a trailing slash */
        apiUrl: string;
        socket: {
          clientPingTimeoutMs: number;
          serverPingTimeoutMs: number;
          pingPongLogging: boolean;
        };
      }
    | {
        kind: "hub";
        /** Without a trailing slash */
        hubUrl: string;
        hubToken: string;
      };
  timezone: string;
  mention: {
    /** Answers mentions only from these users. Empty means all users */
    allowedUserIds: string[];
    /** Directory to consult read-only when answering */
    workspace?: string;
    /** Number of CLIs to run concurrently */
    concurrency: number;
  };
  reasoner: {
    backend: "claude" | "codex";
    /** If empty, codex uses the model from ~/.codex/config.toml. */
    model?: string;
    codexReasoningEffort?: string;
    timeoutMs: number;
    claudeBin: string;
    codexBin: string;
    /** If set, runs the CLI inside a disposable docker container. */
    sandbox?: DockerSandboxOptions;
    /** MCP servers to attach to the reasoner CLI. With OPS_TOOLS=on, ops-broker (SSH host checks, k8s, file lookup) */
    mcpServers: McpServerRef[];
  };
  /** Renders mermaid/dot/vega-lite/svg blocks in answers to PNG and uploads them. (Requires docker) */
  render: {
    enabled: boolean;
    dockerBin: string;
    image: string;
    /** Shrinks a generated image's long side to this size before upload. 0 keeps the original */
    generatedMaxPx: number;
  };
  /** Directory for run history, bot status (bot.json), and logs (logs/bot.log) */
  dataDir: string;
  /** Run history. undefined when off */
  history?: {
    retentionDays: number;
  };
  logLevel: "debug" | "info" | "warn" | "error";
}

/** Treats entries left empty in .env, like "KEY=", as unset. */
const providedValues = (env: NodeJS.ProcessEnv) =>
  Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value.trim() !== "")
  );

/**
 * Bot config fingerprint. The bot writes it to the status file at startup, and the desktop app
 * compares it with the value computed from the current .env to decide whether a restart is
 * needed. (The values themselves are not stored)
 */
export function configFingerprint(env: NodeJS.ProcessEnv): string {
  const provided = providedValues(env);
  const entries = Object.keys(EnvSchema.shape)
    // Skips the data location, since the desktop app passes it as an absolute path when launching the bot.
    .filter((key) => key !== "PACENOTE_DATA_DIR")
    .sort()
    .flatMap((key) => (provided[key] === undefined ? [] : [[key, provided[key]]]));
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex").slice(0, 16);
}

export interface ConfigIssue {
  /** The env var at fault. For problems involving several values, the main one */
  key?: string;
  message: string;
  /**
   * The setting is required but not filled in yet (a Slack credential, the sandbox's login). Saving a partial setup is
   * fine, since the bot shows "Setup needed" until it is complete; a wrong value is not marked so and blocks saving.
   */
  missing?: boolean;
}

/** A required setting that is still empty. Carries a valid stand-in so the remaining rules can still be checked. */
export class MissingSettingError extends Error {
  constructor(
    readonly key: string,
    message: string,
    readonly standIn: string
  ) {
    super(message);
  }
}

/** Validation for the settings screen. Uses the same rules as loadConfig and returns problems per env var. */
export function checkConfig(env: NodeJS.ProcessEnv): ConfigIssue[] {
  const parsed = EnvSchema.safeParse(providedValues(env));
  if (!parsed.success) {
    return parsed.error.issues.map((issue) => ({
      key: issue.path[0] === undefined ? undefined : String(issue.path[0]),
      message: issue.message,
    }));
  }
  // A missing setting is reported and then stood in for, so the rules behind it are checked as well.
  const issues: ConfigIssue[] = [];
  const probe: NodeJS.ProcessEnv = { ...env };
  for (;;) {
    try {
      loadConfig(probe);
      return issues;
    } catch (err) {
      if (err instanceof MissingSettingError && probe[err.key] !== err.standIn) {
        issues.push({ key: err.key, message: err.message, missing: true });
        probe[err.key] = err.standIn;
        continue;
      }
      const message = (err as Error).message;
      // Treats the first env var name in the message as the main one.
      const keys = new Set(Object.keys(EnvSchema.shape));
      const key = message.match(/[A-Z][A-Z0-9_]+/g)?.find((word) => keys.has(word));
      return [...issues, { key, message }];
    }
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(providedValues(env));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `- ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Some environment variables are invalid.\n${issues}`);
  }
  const e = parsed.data;

  const workspace = e.MENTION_WORKSPACE ? expandHome(e.MENTION_WORKSPACE) : undefined;
  if (workspace && !isDirectory(workspace)) {
    throw new Error(
      `MENTION_WORKSPACE must be an absolute path to an existing directory: ${workspace}`
    );
  }

  return {
    slack: slackConnection(e),
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
    dataDir: e.PACENOTE_DATA_DIR
      ? path.resolve(expandHome(e.PACENOTE_DATA_DIR))
      : defaultHome(),
    history: e.HISTORY === "on" ? { retentionDays: e.HISTORY_RETENTION_DAYS } : undefined,
    logLevel: e.LOG_LEVEL,
  };
}

function slackConnection(e: z.infer<typeof EnvSchema>): Config["slack"] {
  if (e.SLACK_CONNECTION === "hub") {
    if (!e.HUB_URL)
      throw new MissingSettingError(
        "HUB_URL",
        "HUB_URL is required to connect through the team hub.",
        "https://hub.invalid"
      );
    if (!e.HUB_TOKEN)
      throw new MissingSettingError(
        "HUB_TOKEN",
        "HUB_TOKEN is missing: this desktop is not paired with the hub yet. Connect in Settings > Messengers > Slack.",
        "0000000000000000000000000000000000000000000000000000000000000000"
      );
    return { kind: "hub", hubUrl: e.HUB_URL.replace(/\/+$/, ""), hubToken: e.HUB_TOKEN };
  }
  if (!e.SLACK_BOT_TOKEN)
    throw new MissingSettingError(
      "SLACK_BOT_TOKEN",
      "SLACK_BOT_TOKEN is required for your own Slack app (SLACK_CONNECTION=app).",
      "xoxb-stand-in"
    );
  if (!e.SLACK_APP_TOKEN)
    throw new MissingSettingError(
      "SLACK_APP_TOKEN",
      "SLACK_APP_TOKEN is required for your own Slack app (SLACK_CONNECTION=app).",
      "xapp-stand-in"
    );
  return {
    kind: "app",
    botToken: e.SLACK_BOT_TOKEN,
    appToken: e.SLACK_APP_TOKEN,
    apiUrl: slackApiBase(e.SLACK_API_URL),
    socket: {
      clientPingTimeoutMs: e.SOCKET_CLIENT_PING_TIMEOUT_MS,
      serverPingTimeoutMs: e.SOCKET_SERVER_PING_TIMEOUT_MS,
      pingPongLogging: e.SOCKET_PING_PONG_LOG === "on",
    },
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
    // ops-broker uses SSH keys, a cluster read token, and the work directory.
    // It stays off without the sandbox and an allowed user list.
    if (e.REASONER_SANDBOX !== "docker") {
      throw new Error("OPS_TOOLS=on requires REASONER_SANDBOX=docker.");
    }
    if (e.MENTION_ALLOWED_USERS.length === 0) {
      throw new Error(
        "OPS_TOOLS=on requires MENTION_ALLOWED_USERS to list who may use it."
      );
    }
    base.mcpServers = [{ name: "ops", url: e.OPS_BROKER_URL }];
  }
  if (e.REASONER_SANDBOX !== "docker") return base;

  // The container has no host keychain or config, so credentials are passed explicitly.
  const claudeEnv: Record<string, string> = {};
  if (e.SANDBOX_CLAUDE_OAUTH_TOKEN) {
    claudeEnv.CLAUDE_CODE_OAUTH_TOKEN = e.SANDBOX_CLAUDE_OAUTH_TOKEN;
  } else if (e.SANDBOX_ANTHROPIC_API_KEY) {
    claudeEnv.ANTHROPIC_API_KEY = e.SANDBOX_ANTHROPIC_API_KEY;
  }
  if (e.REASONER === "claude" && Object.keys(claudeEnv).length === 0) {
    throw new MissingSettingError(
      "SANDBOX_CLAUDE_OAUTH_TOKEN",
      "Using claude with REASONER_SANDBOX=docker requires SANDBOX_CLAUDE_OAUTH_TOKEN (claude setup-token) or SANDBOX_ANTHROPIC_API_KEY.",
      "sk-ant-oat01-stand-in"
    );
  }

  const codexAuthFile = expandHome(e.SANDBOX_CODEX_AUTH_FILE);
  if (e.REASONER === "codex") {
    if (!path.isAbsolute(codexAuthFile) || !existsSync(codexAuthFile)) {
      throw new Error(
        `Using codex with REASONER_SANDBOX=docker requires a codex login file: ${codexAuthFile}`
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
