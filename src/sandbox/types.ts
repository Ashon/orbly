/**
 * Sandbox status and jobs. The desktop app produces them and the settings
 * screen shows them. (Only types also read in the browser live here) Each
 * component applies settings differently.
 * - bot: reasoner sandbox (a new container per request) settings. Applied by
 *   restarting the bot.
 * - proxy: egress allowlist. Applied by restarting egress-proxy.
 * - broker: ops-broker settings (SSH, k8s, files, GitHub, Jira). Applied by
 *   recreating the broker.
 */
export type SandboxComponent = 'bot' | 'proxy' | 'broker'

export interface ContainerState {
  service: 'egress-proxy' | 'ops-broker'
  /**
   * docker state such as running or exited. missing if there is no container
   */
  state: string
  startedAt?: string
}

export interface BrokerHealth {
  sshHosts: number
  k8s: string[]
  fs?: string
  git: boolean
  github: string[]
  jira: string[]
}

export interface SandboxCheck {
  label: string
  ok: boolean
  detail?: string
}

export interface PendingApply {
  component: SandboxComponent
  reason: string
}

export interface SandboxStatus {
  checkedAt: string
  docker: { ok: boolean; version?: string; error?: string }
  images: {
    name: string
    purpose: string
    present: boolean
    createdAt?: string
  }[]
  containers: ContainerState[]
  broker?: BrokerHealth
  /** Credentials and generated file status (values are not sent) */
  checks: SandboxCheck[]
  /** Components whose changed settings are not applied yet */
  pending: PendingApply[]
  allowlist: { file: string; domains: string[]; required: string[] }
  /**
   * Number of requests the bot is handling. If not 0, proxy/broker restarts are
   * blocked.
   */
  activeRequests: number
}

export interface AllowlistIssue {
  domain?: string
  message: string
}

export type SandboxJobKind = 'proxy' | 'broker' | 'images' | 'kubeconfig'

export const SANDBOX_JOBS: Record<
  SandboxJobKind,
  { label: string; script: string; help: string }
> = {
  proxy: {
    label: 'Restart proxy',
    script: 'sandbox:up',
    help: 'Reloads the allowed domains list.',
  },
  broker: {
    label: 'Recreate broker',
    script: 'sandbox:ops-up',
    help: 'Fetches the host list and GitHub token again, then rebuilds the image and starts it.',
  },
  images: {
    label: 'Build sandbox images',
    script: 'sandbox:build',
    help: 'Rebuilds the reasoner and diagram (renderer) images. Used from the next request.',
  },
  kubeconfig: {
    label: 'Rebuild kubeconfig',
    script: 'k8s:kubeconfig',
    help: 'Builds the broker kubeconfig from the read-only SA token. Recreate the broker afterward.',
  },
}

export interface SandboxJob {
  kind: SandboxJobKind
  state: 'running' | 'succeeded' | 'failed'
  startedAt: string
  finishedAt?: string
  exitCode?: number | null
  output: string[]
}
