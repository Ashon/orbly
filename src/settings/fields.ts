import type { SandboxComponent } from "../sandbox/types.js";

/**
 * Config file (.env, ~/.verda/.env outside the repository) entries handled by the settings screen. Shared by the desktop app (save, validation) and the screen (input form).
 * Defaults must match the bot config (src/config.ts EnvSchema) or the broker config (src/sandbox/env.ts). (tests/settings.test.ts)
 * .env entries not listed here are hidden from the screen and kept as is on save.
 */
export type SettingGroup =
  "connection" | "mention" | "reasoner" | "render" | "history" | "sandbox" | "ops";

export interface SettingField {
  key: string;
  group: SettingGroup;
  label: string;
  help?: string;
  /** toggle is an on/off value. */
  type: "secret" | "text" | "number" | "select" | "toggle";
  options?: { value: string; label: string }[];
  /** Value used when left empty. No default if absent */
  default?: string;
  placeholder?: string;
  /** Advanced fields are shown collapsed. */
  advanced?: boolean;
  /** Value that cannot be empty */
  required?: boolean;
  /** What must be applied again after a change. Defaults to restarting the bot */
  applies?: SandboxComponent;
}

export type SettingTab = "bot" | "sandbox";

export const SETTING_GROUPS: {
  id: SettingGroup;
  tab: SettingTab;
  label: string;
  help: string;
}[] = [
  {
    id: "connection",
    tab: "bot",
    label: "Slack connection (Socket Mode)",
    help: "The bot opens a Socket Mode connection with the app token and reads and writes messages with the bot token.",
  },
  {
    id: "mention",
    tab: "bot",
    label: "Mentions",
    help: "Sets whose mentions to answer and how many to answer at once.",
  },
  {
    id: "reasoner",
    tab: "bot",
    label: "Reasoning",
    help: "The local CLI that writes answers and the environment it runs in.",
  },
  {
    id: "render",
    tab: "bot",
    label: "Diagrams",
    help: "How diagrams and generated images in answers are uploaded.",
  },
  {
    id: "history",
    tab: "bot",
    label: "History and logs",
    help: "How run history and logs are kept.",
  },
  {
    id: "sandbox",
    tab: "sandbox",
    label: "Reasoner sandbox",
    help: "A fresh reasoner container starts for each request. It gets only the credentials set here, and egress goes only to the proxy's allowed domains.",
  },
  {
    id: "ops",
    tab: "sandbox",
    label: "Ops tools (ops-broker)",
    help: "SSH keys, kubeconfig, and the GitHub token live only in the broker container. The reasoner container can only make requests through fixed tools.",
  },
];

export const SETTING_FIELDS: SettingField[] = [
  {
    key: "SLACK_APP_TOKEN",
    group: "connection",
    label: "App token",
    help: "Basic Information > App-Level Tokens (connections:write). Used for the Socket Mode connection.",
    type: "secret",
    placeholder: "xapp-...",
    required: true,
  },
  {
    key: "SLACK_BOT_TOKEN",
    group: "connection",
    label: "Bot token",
    help: "OAuth & Permissions > Bot User OAuth Token",
    type: "secret",
    placeholder: "xoxb-...",
    required: true,
  },
  {
    key: "LOG_LEVEL",
    group: "connection",
    label: "Log level",
    help: "At debug, detailed Socket Mode client logs are also written.",
    type: "select",
    options: ["debug", "info", "warn", "error"].map((value) => ({ value, label: value })),
    default: "info",
  },
  {
    key: "SOCKET_CLIENT_PING_TIMEOUT_MS",
    group: "connection",
    label: "Client ping timeout (ms)",
    help: "Reconnects if a ping sent by the bot gets no reply within this time. (1000 to 60000)",
    type: "number",
    default: "5000",
    advanced: true,
  },
  {
    key: "SOCKET_SERVER_PING_TIMEOUT_MS",
    group: "connection",
    label: "Server ping timeout (ms)",
    help: "Reconnects if no ping arrives from Slack within this time. (5000 to 300000)",
    type: "number",
    default: "30000",
    advanced: true,
  },
  {
    key: "SOCKET_PING_PONG_LOG",
    group: "connection",
    label: "Ping/pong log",
    help: "Logs keepalive signals. Visible when the log level is debug.",
    type: "toggle",
    default: "off",
    advanced: true,
  },
  {
    key: "MENTION_ALLOWED_USERS",
    group: "mention",
    label: "Allowed users",
    help: "Comma-separated Slack user IDs (U...). Leave empty to answer everyone. Required when ops tools are on.",
    type: "text",
    placeholder: "U0123ABCD, U0456EFGH",
  },
  {
    key: "MENTION_CONCURRENCY",
    group: "mention",
    label: "Concurrent requests",
    type: "number",
    default: "2",
  },
  {
    key: "TIMEZONE",
    group: "mention",
    label: "Time zone",
    help: "Used to show times in thread context.",
    type: "text",
    default: "Asia/Seoul",
  },
  {
    key: "MENTION_WORKSPACE",
    group: "mention",
    label: "Reference directory",
    help: "Absolute path consulted read-only when answering. Used only in run environments that can read files.",
    type: "text",
    advanced: true,
  },
  {
    key: "REASONER",
    group: "reasoner",
    label: "Reasoner CLI",
    type: "select",
    options: [
      { value: "claude", label: "claude" },
      { value: "codex", label: "codex" },
    ],
    default: "claude",
  },
  {
    key: "REASONER_MODEL",
    group: "reasoner",
    label: "Model",
    help: "Leave empty to use claude-opus-5-5 for claude and the model in ~/.codex/config.toml for codex.",
    type: "text",
  },
  {
    key: "REASONER_TIMEOUT_SEC",
    group: "reasoner",
    label: "Timeout (seconds)",
    type: "number",
    default: "900",
  },
  {
    key: "REASONER_SANDBOX",
    group: "reasoner",
    label: "Run environment",
    type: "select",
    options: [
      { value: "none", label: "Run on host (none)" },
      { value: "docker", label: "Docker sandbox (docker)" },
    ],
    default: "none",
  },
  {
    key: "RENDER_DIAGRAMS",
    group: "render",
    label: "Render diagrams",
    help: "Renders mermaid, dot, vega-lite, and svg blocks in answers as PNG and uploads them. (Requires docker)",
    type: "toggle",
    default: "on",
  },
  {
    key: "GENERATED_IMAGE_MAX_PX",
    group: "render",
    label: "Generated image max size (px)",
    help: "Shrinks the long side to this size before uploading. 0 keeps the original size.",
    type: "number",
    default: "512",
  },
  {
    key: "HISTORY",
    group: "history",
    label: "Run history",
    type: "toggle",
    default: "on",
  },
  {
    key: "HISTORY_RETENTION_DAYS",
    group: "history",
    label: "History retention (days)",
    help: "Set to 0 to never delete.",
    type: "number",
    default: "30",
  },
  {
    key: "SANDBOX_MEMORY",
    group: "sandbox",
    label: "Memory limit",
    help: "docker --memory format (e.g. 2g, 1536m)",
    type: "text",
    default: "2g",
  },
  {
    key: "SANDBOX_CPUS",
    group: "sandbox",
    label: "CPU limit",
    type: "text",
    default: "2",
  },
  {
    key: "SANDBOX_CLAUDE_OAUTH_TOKEN",
    group: "sandbox",
    label: "claude token",
    help: "Required to use claude in the sandbox. (claude setup-token)",
    type: "secret",
  },
  {
    key: "SANDBOX_ANTHROPIC_API_KEY",
    group: "sandbox",
    label: "Anthropic API key",
    help: "For using an API key instead of the claude token",
    type: "secret",
    advanced: true,
  },
  {
    key: "SANDBOX_CODEX_AUTH_FILE",
    group: "sandbox",
    label: "codex login file",
    help: "Copied into the container when using codex in the sandbox.",
    type: "text",
    default: "~/.codex/auth.json",
  },
  {
    key: "SANDBOX_IMAGE",
    group: "sandbox",
    label: "Reasoner image",
    type: "text",
    default: "verda-reasoner:latest",
    advanced: true,
  },
  {
    key: "SANDBOX_NETWORK",
    group: "sandbox",
    label: "Docker network",
    help: "Internal network with no direct outbound access",
    type: "text",
    default: "verda-sandbox",
    advanced: true,
  },
  {
    key: "SANDBOX_PROXY_URL",
    group: "sandbox",
    label: "Proxy URL",
    type: "text",
    default: "http://egress-proxy:8888",
    advanced: true,
  },
  {
    key: "OPS_TOOLS",
    group: "ops",
    label: "Enable ops tools",
    help: "SSH host checks, k8s queries, work directory, GitHub, PR, and Jira tools. Requires the Docker sandbox and allowed users. Features left empty below are turned off.",
    type: "toggle",
    default: "off",
  },
  {
    key: "OPS_GIT_ALLOWED_OWNERS",
    group: "ops",
    label: "Allowed GitHub orgs",
    help: "Limits PR creation and GitHub queries to repositories of these orgs (or users). Comma-separated. Leave empty to turn off the GitHub tools.",
    type: "text",
    placeholder: "my-org, my-user",
    applies: "broker",
  },
  {
    key: "OPS_GIT_AUTHOR_NAME",
    group: "ops",
    label: "PR commit author name",
    help: "Author of commits the sandbox makes. Leave empty to use the global git config (git config --global user.name). Separate from this repository's git config.",
    type: "text",
    applies: "broker",
  },
  {
    key: "OPS_GIT_AUTHOR_EMAIL",
    group: "ops",
    label: "PR commit author email",
    help: "Leave empty to use the global git config (git config --global user.email).",
    type: "text",
    applies: "broker",
  },
  {
    key: "OPS_JIRA_URL",
    group: "ops",
    label: "Jira URL",
    help: "Jira Cloud site URL. The Jira tools turn on only when the URL, email, token, and projects are all set.",
    type: "text",
    placeholder: "https://your-site.atlassian.net",
    applies: "broker",
  },
  {
    key: "OPS_JIRA_EMAIL",
    group: "ops",
    label: "Jira account email",
    help: "Atlassian account that owns the API token. Issues and comments are posted as this account.",
    type: "text",
    applies: "broker",
  },
  {
    key: "OPS_JIRA_TOKEN",
    group: "ops",
    label: "Jira API token",
    help: "Create it under Security > API tokens at id.atlassian.com. Passed only to the broker container.",
    type: "secret",
    applies: "broker",
  },
  {
    key: "OPS_JIRA_PROJECTS",
    group: "ops",
    label: "Allowed Jira projects",
    help: "Limits queries, creation, and comments to these projects. Comma-separated project keys",
    type: "text",
    placeholder: "PROJ, OPS",
    applies: "broker",
  },
  {
    key: "OPS_FS_ROOT",
    group: "ops",
    label: "Work directory",
    help: "Work directory to mount read-only (absolute path). Leave empty to turn off the file and PR tools.",
    type: "text",
    placeholder: "/Users/me/workspaces",
    applies: "broker",
  },
  {
    key: "OPS_SSH_USER",
    group: "ops",
    label: "SSH user",
    help: "Account used for host checks. Host checks turn on only when the user, allowed range, and key are all set.",
    type: "text",
    applies: "broker",
  },
  {
    key: "OPS_SSH_ALLOWED_CIDR",
    group: "ops",
    label: "Allowed SSH range",
    help: "Only hosts in this range are checked over SSH.",
    type: "text",
    placeholder: "192.168.10.0/24",
    applies: "broker",
  },
  {
    key: "OPS_SSH_KEY",
    group: "ops",
    label: "SSH key path",
    help: "Absolute path. The key is mounted only into the broker container.",
    type: "text",
    placeholder: "/Users/me/.ssh/id_ed25519",
    applies: "broker",
  },
  {
    key: "OPS_SSH_KNOWN_HOSTS",
    group: "ops",
    label: "SSH known_hosts path",
    help: "Absolute path. Leave empty to remember host keys from the first connection only inside the broker.",
    type: "text",
    advanced: true,
    applies: "broker",
  },
  {
    key: "OPS_SSH_INVENTORY_DIR",
    group: "ops",
    label: "Inventory directory",
    help: "Location of the ansible project used to build the host list. Relative paths are relative to this repository. Leave empty to write ~/.verda/ops-broker/hosts.json directly.",
    type: "text",
    advanced: true,
    applies: "broker",
  },
  {
    key: "OPS_SSH_INVENTORY",
    group: "ops",
    label: "Inventory file",
    help: "Relative path inside the inventory directory",
    type: "text",
    placeholder: "inventory.ini",
    advanced: true,
    applies: "broker",
  },
  {
    key: "OPS_K8S_CONTEXTS",
    group: "ops",
    label: "k8s contexts",
    help: "Local kubeconfig contexts to build the read-only kubeconfig from. Comma-separated. Rebuild the kubeconfig after changing them.",
    type: "text",
    applies: "broker",
  },
  {
    key: "OPS_K8S_SA",
    group: "ops",
    label: "k8s read-only account",
    help: "Read-only ServiceAccount in each cluster (sandbox/k8s/verda-ro.yaml)",
    type: "text",
    default: "verda-ro",
    advanced: true,
    applies: "broker",
  },
  {
    key: "OPS_K8S_SA_NAMESPACE",
    group: "ops",
    label: "k8s read-only account namespace",
    type: "text",
    default: "verda",
    advanced: true,
    applies: "broker",
  },
  {
    key: "OPS_BROKER_URL",
    group: "ops",
    label: "Broker URL",
    type: "text",
    default: "http://ops-broker:8080/mcp",
    advanced: true,
  },
];

/** null clears the value in .env so the default applies again. */
export type SettingsChanges = Record<string, string | null>;

export interface SettingsView {
  envFile: string;
  exists: boolean;
  dataDir: string;
  /** Current values of non-secret fields (empty string if not in .env) */
  values: Record<string, string>;
  /** For secrets, only whether they are set and the last 4 characters */
  secrets: Record<string, { set: boolean; hint?: string }>;
  /** Fields set in the app's environment variables, which take precedence over .env */
  overridden: string[];
  /** .env entries the settings screen does not handle (kept as is on save) */
  otherKeys: string[];
}

export interface SettingsIssue {
  key?: string;
  message: string;
}

export function maskSecret(value: string): string {
  const prefix = /^(xox[a-z]-|xapp-|sk-ant-[a-z0-9]+-|sk-)/i.exec(value)?.[0] ?? "";
  return `${prefix}...${value.slice(-4)}`;
}
