import type { MessengerId } from '../messengers/ids.js'
import type { SandboxComponent } from '../sandbox/types.js'

/**
 * Config file (.env, ~/.pacenote/.env outside the repository) entries handled
 * by the settings screen. Shared by the desktop app (save, validation) and the
 * screen (input form). Defaults must match the bot config (src/config.ts
 * EnvSchema) or the broker config (src/sandbox/env.ts).
 * (tests/settings.test.ts) .env entries not listed here are hidden from the
 * screen and kept as is on save.
 */
/**
 * Settings screen sections, in navigation order. Each holds a few groups
 * (cards) of fields. The desktop app's own preferences (theme, autostart) are
 * not .env entries and have a "general" section of their own on the screen.
 */
export type SettingSection =
  'messengers' | 'answers' | 'sandbox' | 'ops' | 'logs'

export const SETTING_SECTIONS: {
  id: SettingSection
  label: string
  help: string
}[] = [
  {
    id: 'messengers',
    label: 'Messengers',
    help: 'The chat apps Pacey answers in, and who can ask there. Changes apply when Pacey restarts.',
  },
  {
    id: 'answers',
    label: 'Answers',
    help: 'The CLI that writes answers and how requests are handled. Changes apply when Pacey restarts.',
  },
  {
    id: 'sandbox',
    label: 'Sandbox',
    help: 'Where the reasoner CLI runs for each request. Allowed domains apply when the proxy restarts, everything else when Pacey restarts.',
  },
  {
    id: 'ops',
    label: 'Ops tools',
    help: "Tools the reasoner can call through ops-broker. SSH keys, kubeconfig, and tokens stay in the broker container, never in the reasoner's.",
  },
  {
    id: 'logs',
    label: 'History & logs',
    help: 'What Pacey keeps after answering. Changes apply when Pacey restarts.',
  },
]

export type SettingGroup =
  | 'slack'
  | 'access'
  | 'reasoner'
  | 'requests'
  | 'diagrams'
  | 'environment'
  | 'credentials'
  | 'ops'
  | 'files'
  | 'github'
  | 'jira'
  | 'k8s'
  | 'ssh'
  | 'history'
  | 'logs'

export interface SettingField {
  key: string
  group: SettingGroup
  label: string
  help?: string
  /** toggle is an on/off value. */
  type: 'secret' | 'text' | 'number' | 'select' | 'toggle'
  /**
   * Options with help are shown as a choice of cards instead of a drop-down.
   */
  options?: { value: string; label: string; help?: string }[]
  /** Value used when left empty. No default if absent */
  default?: string
  placeholder?: string
  /** Advanced fields are shown collapsed. */
  advanced?: boolean
  /** Value that cannot be empty */
  required?: boolean
  /**
   * What must be applied again after a change. Defaults to restarting the bot
   */
  applies?: SandboxComponent
  /**
   * Shown only while another field has this value (e.g. sandbox limits only for
   * the docker run environment). Hidden values stay in .env.
   */
  shownWhen?: { key: string; equals: string }
  /**
   * Saved and validated like any field but never shown as a row; the screen
   * sets it some other way (e.g. hub pairing)
   */
  internal?: boolean
}

export interface SettingGroupInfo {
  id: SettingGroup
  section: SettingSection
  /**
   * In the Messengers section: the chat app the group belongs to, shown under
   * that app's heading
   */
  messenger?: MessengerId
  label: string
  help: string
  /**
   * For an optional integration: the fields that must all be set for it to turn
   * on
   */
  requires?: string[]
}

export const SETTING_GROUPS: SettingGroupInfo[] = [
  {
    id: 'slack',
    section: 'messengers',
    messenger: 'slack',
    label: 'Connection',
    help: "How this desktop reaches Slack: through your team's hub, or a Slack app of your own.",
  },
  {
    id: 'access',
    section: 'messengers',
    messenger: 'slack',
    label: 'Who can ask',
    help: 'Mentions from anyone else are ignored.',
  },
  {
    id: 'reasoner',
    section: 'answers',
    label: 'Reasoner',
    help: 'The local CLI that writes answers.',
  },
  {
    id: 'requests',
    section: 'answers',
    label: 'Requests',
    help: 'How many mentions are answered at once and the context each one gets.',
  },
  {
    id: 'diagrams',
    section: 'answers',
    label: 'Diagrams and images',
    help: 'How diagrams and generated images in answers are uploaded.',
  },
  {
    id: 'environment',
    section: 'sandbox',
    label: 'Run environment',
    help: 'Where the reasoner CLI runs for each request.',
  },
  {
    id: 'credentials',
    section: 'sandbox',
    label: 'Reasoner login',
    help: 'Passed into the sandbox container for the selected reasoner CLI. Your own CLI login on this Mac is not used there.',
  },
  {
    id: 'ops',
    section: 'ops',
    label: 'Ops tools',
    help: 'Turning them on or off applies when Pacey restarts.',
  },
  {
    id: 'files',
    section: 'ops',
    label: 'Files',
    help: 'File tools read the work directory, and pull requests are made from repositories in it.',
    requires: ['OPS_FS_ROOT'],
  },
  {
    id: 'github',
    section: 'ops',
    label: 'GitHub and pull requests',
    help: 'GitHub queries and pull requests, limited to the orgs below. Pull requests also need the work directory.',
    requires: ['OPS_GIT_ALLOWED_OWNERS'],
  },
  {
    id: 'jira',
    section: 'ops',
    label: 'Jira',
    help: 'Issue queries, new issues, and comments in the allowed projects.',
    requires: [
      'OPS_JIRA_URL',
      'OPS_JIRA_EMAIL',
      'OPS_JIRA_TOKEN',
      'OPS_JIRA_PROJECTS',
    ],
  },
  {
    id: 'k8s',
    section: 'ops',
    label: 'Kubernetes',
    help: 'Read-only queries through a kubeconfig built for a read-only ServiceAccount.',
    requires: ['OPS_K8S_CONTEXTS'],
  },
  {
    id: 'ssh',
    section: 'ops',
    label: 'SSH hosts',
    help: 'Read-only checks on hosts in the allowed range.',
    requires: ['OPS_SSH_USER', 'OPS_SSH_ALLOWED_CIDR', 'OPS_SSH_KEY'],
  },
  {
    id: 'history',
    section: 'logs',
    label: 'Run history',
    help: 'Each request is recorded with its tool calls, replies, and outputs.',
  },
  {
    id: 'logs',
    section: 'logs',
    label: 'Logs',
    help: 'What Pacey writes to its log.',
  },
]

/**
 * Settings route for a bot waiting for setup: the section of its first issue,
 * or Messengers when there is none (the Slack tokens are missing or Slack
 * rejected them).
 */
export function setupSettingsRoute(
  issues: readonly { key?: string }[] = []
): string {
  const section = issues
    .map((issue) => settingSectionOf(issue.key))
    .find(Boolean)
  return `#/settings/${section ?? 'messengers'}`
}

/** Section that holds a field, for jumping to a validation issue. */
export function settingSectionOf(
  key: string | undefined
): SettingSection | undefined {
  const group = SETTING_FIELDS.find((field) => field.key === key)?.group
  return SETTING_GROUPS.find((info) => info.id === group)?.section
}

export const SETTING_FIELDS: SettingField[] = [
  {
    key: 'SLACK_CONNECTION',
    group: 'slack',
    label: 'Connection',
    type: 'select',
    options: [
      {
        value: 'hub',
        label: 'Team hub',
        help: "Your team's hub server holds the Slack app. This desktop answers your own mentions through it, and keeps no Slack token.",
      },
      {
        value: 'app',
        label: 'Your own Slack app',
        help: 'Socket Mode with the app token and bot token of a Slack app you created. For using Pacenote on your own.',
      },
    ],
    default: 'app',
  },
  {
    key: 'HUB_URL',
    group: 'slack',
    label: 'Hub URL',
    help: "The address your team's hub admin gave you.",
    type: 'text',
    placeholder: 'https://pacenote-hub.example.com',
    shownWhen: { key: 'SLACK_CONNECTION', equals: 'hub' },
  },
  {
    key: 'HUB_TOKEN',
    group: 'slack',
    label: 'Hub token',
    help: 'Stored by pairing with the hub. The hub keeps only its hash.',
    type: 'secret',
    internal: true,
  },
  {
    key: 'SLACK_APP_TOKEN',
    group: 'slack',
    label: 'App token',
    help: 'Basic Information > App-Level Tokens (connections:write). Used for the Socket Mode connection.',
    type: 'secret',
    placeholder: 'xapp-...',
    shownWhen: { key: 'SLACK_CONNECTION', equals: 'app' },
  },
  {
    key: 'SLACK_BOT_TOKEN',
    group: 'slack',
    label: 'Bot token',
    help: 'OAuth & Permissions > Bot User OAuth Token',
    type: 'secret',
    placeholder: 'xoxb-...',
    shownWhen: { key: 'SLACK_CONNECTION', equals: 'app' },
  },
  {
    key: 'SOCKET_CLIENT_PING_TIMEOUT_MS',
    group: 'slack',
    label: 'Client ping timeout (ms)',
    help: 'Reconnects if a ping sent by Pacey gets no reply within this time. (1000 to 60000)',
    type: 'number',
    default: '5000',
    advanced: true,
    shownWhen: { key: 'SLACK_CONNECTION', equals: 'app' },
  },
  {
    key: 'SOCKET_SERVER_PING_TIMEOUT_MS',
    group: 'slack',
    label: 'Server ping timeout (ms)',
    help: 'Reconnects if no ping arrives from Slack within this time. (5000 to 300000)',
    type: 'number',
    default: '30000',
    advanced: true,
    shownWhen: { key: 'SLACK_CONNECTION', equals: 'app' },
  },
  {
    key: 'MENTION_ALLOWED_USERS',
    group: 'access',
    label: 'Allowed users',
    help: 'Comma-separated Slack user IDs (U...). Leave empty to answer everyone. Required when ops tools are on.',
    type: 'text',
    placeholder: 'U0123ABCD, U0456EFGH',
  },
  {
    key: 'REASONER',
    group: 'reasoner',
    label: 'Reasoner CLI',
    type: 'select',
    options: [
      { value: 'claude', label: 'claude' },
      { value: 'codex', label: 'codex' },
    ],
    default: 'claude',
  },
  {
    key: 'REASONER_MODEL',
    group: 'reasoner',
    label: 'Model',
    help: 'Leave empty to use claude-opus-5-5 for claude and the model in ~/.codex/config.toml for codex.',
    type: 'text',
  },
  {
    key: 'REASONER_TIMEOUT_SEC',
    group: 'reasoner',
    label: 'Timeout (seconds)',
    type: 'number',
    default: '900',
  },
  {
    key: 'MENTION_CONCURRENCY',
    group: 'requests',
    label: 'Concurrent requests',
    type: 'number',
    default: '2',
  },
  {
    key: 'TIMEZONE',
    group: 'requests',
    label: 'Time zone',
    help: 'Used to show times in thread context.',
    type: 'text',
    default: 'Asia/Seoul',
  },
  {
    key: 'MENTION_WORKSPACE',
    group: 'requests',
    label: 'Reference directory',
    help: 'Absolute path consulted read-only when answering. Used only in run environments that can read files.',
    type: 'text',
    advanced: true,
  },
  {
    key: 'RENDER_DIAGRAMS',
    group: 'diagrams',
    label: 'Render diagrams',
    help: 'Renders mermaid, dot, vega-lite, and svg blocks in answers as PNG and uploads them. (Requires docker)',
    type: 'toggle',
    default: 'on',
  },
  {
    key: 'GENERATED_IMAGE_MAX_PX',
    group: 'diagrams',
    label: 'Generated image max size (px)',
    help: 'Shrinks the long side to this size before uploading. 0 keeps the original size.',
    type: 'number',
    default: '512',
  },
  {
    key: 'REASONER_SANDBOX',
    group: 'environment',
    label: 'Run environment',
    type: 'select',
    options: [
      {
        value: 'none',
        label: 'On this Mac',
        help: 'The CLI runs directly with your own login. Quick to set up, but nothing isolates it from this Mac.',
      },
      {
        value: 'docker',
        label: 'Docker sandbox',
        help: 'A fresh container for each request, with only the login set below and outbound traffic limited to allowed domains. Ops tools need it.',
      },
    ],
    default: 'none',
  },
  {
    key: 'SANDBOX_MEMORY',
    group: 'environment',
    label: 'Memory limit',
    help: 'docker --memory format (e.g. 2g, 1536m)',
    type: 'text',
    default: '2g',
    shownWhen: { key: 'REASONER_SANDBOX', equals: 'docker' },
  },
  {
    key: 'SANDBOX_CPUS',
    group: 'environment',
    label: 'CPU limit',
    type: 'text',
    default: '2',
    shownWhen: { key: 'REASONER_SANDBOX', equals: 'docker' },
  },
  {
    key: 'SANDBOX_IMAGE',
    group: 'environment',
    label: 'Reasoner image',
    type: 'text',
    default: 'pacenote-reasoner:latest',
    advanced: true,
    shownWhen: { key: 'REASONER_SANDBOX', equals: 'docker' },
  },
  {
    key: 'SANDBOX_NETWORK',
    group: 'environment',
    label: 'Docker network',
    help: 'Internal network with no direct outbound access',
    type: 'text',
    default: 'pacenote-sandbox',
    advanced: true,
    shownWhen: { key: 'REASONER_SANDBOX', equals: 'docker' },
  },
  {
    key: 'SANDBOX_PROXY_URL',
    group: 'environment',
    label: 'Proxy URL',
    type: 'text',
    default: 'http://egress-proxy:8888',
    advanced: true,
    shownWhen: { key: 'REASONER_SANDBOX', equals: 'docker' },
  },
  {
    key: 'SANDBOX_CLAUDE_OAUTH_TOKEN',
    group: 'credentials',
    label: 'claude token',
    help: 'Required to use claude in the sandbox. (claude setup-token)',
    type: 'secret',
    shownWhen: { key: 'REASONER', equals: 'claude' },
  },
  {
    key: 'SANDBOX_ANTHROPIC_API_KEY',
    group: 'credentials',
    label: 'Anthropic API key',
    help: 'For using an API key instead of the claude token',
    type: 'secret',
    advanced: true,
    shownWhen: { key: 'REASONER', equals: 'claude' },
  },
  {
    key: 'SANDBOX_CODEX_AUTH_FILE',
    group: 'credentials',
    label: 'codex login file',
    help: 'Copied into the container when using codex in the sandbox.',
    type: 'text',
    default: '~/.codex/auth.json',
    shownWhen: { key: 'REASONER', equals: 'codex' },
  },
  {
    key: 'OPS_TOOLS',
    group: 'ops',
    label: 'Enable ops tools',
    help: 'Offers the integrations below to the reasoner. Each one stays off until its fields are filled in.',
    type: 'toggle',
    default: 'off',
  },
  {
    key: 'OPS_BROKER_URL',
    group: 'ops',
    label: 'Broker URL',
    type: 'text',
    default: 'http://ops-broker:8080/mcp',
    advanced: true,
  },
  {
    key: 'OPS_FS_ROOT',
    group: 'files',
    label: 'Work directory',
    help: 'Work directory to mount read-only (absolute path). Leave empty to turn off the file and PR tools.',
    type: 'text',
    placeholder: '/Users/me/workspaces',
    applies: 'broker',
  },
  {
    key: 'OPS_GIT_ALLOWED_OWNERS',
    group: 'github',
    label: 'Allowed GitHub orgs',
    help: 'Limits PR creation and GitHub queries to repositories of these orgs (or users). Comma-separated. Leave empty to turn off the GitHub tools.',
    type: 'text',
    placeholder: 'my-org, my-user',
    applies: 'broker',
  },
  {
    key: 'OPS_GIT_AUTHOR_NAME',
    group: 'github',
    label: 'PR commit author name',
    help: "Author of commits the sandbox makes. Leave empty to use the global git config (git config --global user.name). Separate from this repository's git config.",
    type: 'text',
    applies: 'broker',
  },
  {
    key: 'OPS_GIT_AUTHOR_EMAIL',
    group: 'github',
    label: 'PR commit author email',
    help: 'Leave empty to use the global git config (git config --global user.email).',
    type: 'text',
    applies: 'broker',
  },
  {
    key: 'OPS_JIRA_URL',
    group: 'jira',
    label: 'Jira URL',
    help: 'Jira Cloud site URL. The Jira tools turn on only when the URL, email, token, and projects are all set.',
    type: 'text',
    placeholder: 'https://your-site.atlassian.net',
    applies: 'broker',
  },
  {
    key: 'OPS_JIRA_EMAIL',
    group: 'jira',
    label: 'Jira account email',
    help: 'Atlassian account that owns the API token. Issues and comments are posted as this account.',
    type: 'text',
    applies: 'broker',
  },
  {
    key: 'OPS_JIRA_TOKEN',
    group: 'jira',
    label: 'Jira API token',
    help: 'Create it under Security > API tokens at id.atlassian.com. Passed only to the broker container.',
    type: 'secret',
    applies: 'broker',
  },
  {
    key: 'OPS_JIRA_PROJECTS',
    group: 'jira',
    label: 'Allowed Jira projects',
    help: 'Limits queries, creation, and comments to these projects. Comma-separated project keys',
    type: 'text',
    placeholder: 'PROJ, OPS',
    applies: 'broker',
  },
  {
    key: 'OPS_K8S_CONTEXTS',
    group: 'k8s',
    label: 'k8s contexts',
    help: 'Local kubeconfig contexts to build the read-only kubeconfig from. Comma-separated. Rebuild the kubeconfig after changing them.',
    type: 'text',
    applies: 'broker',
  },
  {
    key: 'OPS_K8S_SA',
    group: 'k8s',
    label: 'k8s read-only account',
    help: 'Read-only ServiceAccount in each cluster (sandbox/k8s/pacenote-ro.yaml)',
    type: 'text',
    default: 'pacenote-ro',
    advanced: true,
    applies: 'broker',
  },
  {
    key: 'OPS_K8S_SA_NAMESPACE',
    group: 'k8s',
    label: 'k8s read-only account namespace',
    type: 'text',
    default: 'pacenote',
    advanced: true,
    applies: 'broker',
  },
  {
    key: 'OPS_SSH_USER',
    group: 'ssh',
    label: 'SSH user',
    help: 'Account used for host checks. Host checks turn on only when the user, allowed range, and key are all set.',
    type: 'text',
    applies: 'broker',
  },
  {
    key: 'OPS_SSH_ALLOWED_CIDR',
    group: 'ssh',
    label: 'Allowed SSH range',
    help: 'Only hosts in this range are checked over SSH.',
    type: 'text',
    placeholder: '192.168.10.0/24',
    applies: 'broker',
  },
  {
    key: 'OPS_SSH_KEY',
    group: 'ssh',
    label: 'SSH key path',
    help: 'Absolute path. The key is mounted only into the broker container.',
    type: 'text',
    placeholder: '/Users/me/.ssh/id_ed25519',
    applies: 'broker',
  },
  {
    key: 'OPS_SSH_KNOWN_HOSTS',
    group: 'ssh',
    label: 'SSH known_hosts path',
    help: 'Absolute path. Leave empty to remember host keys from the first connection only inside the broker.',
    type: 'text',
    advanced: true,
    applies: 'broker',
  },
  {
    key: 'OPS_SSH_INVENTORY_DIR',
    group: 'ssh',
    label: 'Inventory directory',
    help: 'Location of the ansible project used to build the host list. Relative paths are relative to this repository. Leave empty to write ~/.pacenote/ops-broker/hosts.json directly.',
    type: 'text',
    advanced: true,
    applies: 'broker',
  },
  {
    key: 'OPS_SSH_INVENTORY',
    group: 'ssh',
    label: 'Inventory file',
    help: 'Relative path inside the inventory directory',
    type: 'text',
    placeholder: 'inventory.ini',
    advanced: true,
    applies: 'broker',
  },
  {
    key: 'HISTORY',
    group: 'history',
    label: 'Record runs',
    type: 'toggle',
    default: 'on',
  },
  {
    key: 'HISTORY_RETENTION_DAYS',
    group: 'history',
    label: 'History retention (days)',
    help: 'Set to 0 to never delete.',
    type: 'number',
    default: '30',
  },
  {
    key: 'LOG_LEVEL',
    group: 'logs',
    label: 'Log level',
    help: 'At debug, detailed Socket Mode client logs are also written.',
    type: 'select',
    options: ['debug', 'info', 'warn', 'error'].map((value) => ({
      value,
      label: value,
    })),
    default: 'info',
  },
  {
    key: 'SOCKET_PING_PONG_LOG',
    group: 'logs',
    label: 'Ping/pong log',
    help: 'Logs keepalive signals. Visible when the log level is debug.',
    type: 'toggle',
    default: 'off',
    advanced: true,
  },
]

/** null clears the value in .env so the default applies again. */
export type SettingsChanges = Record<string, string | null>

export interface SettingsView {
  envFile: string
  exists: boolean
  dataDir: string
  /** Current values of non-secret fields (empty string if not in .env) */
  values: Record<string, string>
  /** For secrets, only whether they are set and the last 4 characters */
  secrets: Record<string, { set: boolean; hint?: string }>
  /**
   * Fields set in the app's environment variables, which take precedence over
   * .env
   */
  overridden: string[]
  /** .env entries the settings screen does not handle (kept as is on save) */
  otherKeys: string[]
}

export interface SettingsIssue {
  key?: string
  message: string
}

export function maskSecret(value: string): string {
  const prefix =
    /^(xox[a-z]-|xapp-|sk-ant-[a-z0-9]+-|sk-)/i.exec(value)?.[0] ?? ''
  return `${prefix}...${value.slice(-4)}`
}
