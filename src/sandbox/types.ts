/**
 * 샌드박스 상태와 작업. 데스크톱 앱이 만들고 설정 화면이 보여 준다. (브라우저에서도 읽는 타입만 둔다)
 * 구성 요소마다 설정이 적용되는 방식이 다르다.
 * - bot: 추론 샌드박스(요청마다 새 컨테이너) 설정. 봇을 재시작하면 적용된다.
 * - proxy: 바깥 접속 허용 목록. egress-proxy 를 재시작하면 적용된다.
 * - broker: ops-broker 설정(SSH, k8s, 파일, GitHub, Jira). broker 를 다시 띄우면 적용된다.
 */
export type SandboxComponent = "bot" | "proxy" | "broker";

export interface ContainerState {
  service: "egress-proxy" | "ops-broker";
  /** running, exited 등 docker 상태. 컨테이너가 없으면 missing */
  state: string;
  startedAt?: string;
}

export interface BrokerHealth {
  sshHosts: number;
  k8s: string[];
  fs?: string;
  git: boolean;
  github: string[];
  jira: string[];
}

export interface SandboxCheck {
  label: string;
  ok: boolean;
  detail?: string;
}

export interface PendingApply {
  component: SandboxComponent;
  reason: string;
}

export interface SandboxStatus {
  checkedAt: string;
  docker: { ok: boolean; version?: string; error?: string };
  images: { name: string; purpose: string; present: boolean; createdAt?: string }[];
  containers: ContainerState[];
  broker?: BrokerHealth;
  /** 자격 증명, 생성 파일 상태 (값은 보내지 않는다) */
  checks: SandboxCheck[];
  /** 바뀐 설정이 아직 적용되지 않은 구성 요소 */
  pending: PendingApply[];
  allowlist: { file: string; domains: string[]; required: string[] };
  /** 봇이 처리 중인 요청 수. 0 이 아니면 프록시/broker 재시작을 막는다. */
  activeRequests: number;
}

export interface AllowlistIssue {
  domain?: string;
  message: string;
}

export type SandboxJobKind = "proxy" | "broker" | "images" | "kubeconfig";

export const SANDBOX_JOBS: Record<
  SandboxJobKind,
  { label: string; script: string; help: string }
> = {
  proxy: {
    label: "프록시 재시작",
    script: "sandbox:up",
    help: "허용 도메인 목록을 다시 읽는다.",
  },
  broker: {
    label: "broker 다시 띄우기",
    script: "sandbox:ops-up",
    help: "호스트 목록과 GitHub 토큰을 다시 가져오고, 이미지를 다시 빌드해 띄운다.",
  },
  images: {
    label: "샌드박스 이미지 빌드",
    script: "sandbox:build",
    help: "추론(reasoner), 그림(renderer) 이미지를 다시 빌드한다. 다음 요청부터 쓴다.",
  },
  kubeconfig: {
    label: "kubeconfig 다시 만들기",
    script: "k8s:kubeconfig",
    help: "조회 전용 SA 토큰으로 broker kubeconfig 를 만든다. 만든 뒤 broker 를 다시 띄워야 한다.",
  },
};

export interface SandboxJob {
  kind: SandboxJobKind;
  state: "running" | "succeeded" | "failed";
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  output: string[];
}
