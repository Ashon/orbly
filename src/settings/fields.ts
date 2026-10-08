import type { SandboxComponent } from "../sandbox/types.js";

/**
 * 설정 화면이 다루는 설정 파일(.env, 저장소 밖 ~/.verda/.env) 항목. 데스크톱 앱(저장, 검증)과 화면(입력 양식)이 함께 쓴다.
 * 기본값은 봇 설정(src/config.ts EnvSchema) 또는 broker 설정(src/sandbox/env.ts)과 같아야 한다. (tests/settings.test.ts)
 * 여기 없는 .env 항목은 화면에 보이지 않고 저장할 때 그대로 남는다.
 */
export type SettingGroup =
  "connection" | "mention" | "reasoner" | "render" | "history" | "sandbox" | "ops";

export interface SettingField {
  key: string;
  group: SettingGroup;
  label: string;
  help?: string;
  /** toggle 은 on/off 값이다. */
  type: "secret" | "text" | "number" | "select" | "toggle";
  options?: { value: string; label: string }[];
  /** 비워 두면 쓰는 값. 없으면 기본값 없음 */
  default?: string;
  placeholder?: string;
  /** 고급 항목은 접어서 보여 준다. */
  advanced?: boolean;
  /** 비울 수 없는 값 */
  required?: boolean;
  /** 바꾸면 무엇을 다시 적용해야 하는지. 기본은 봇 재시작 */
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
    label: "Slack 연결 (Socket Mode)",
    help: "봇은 앱 토큰으로 Socket Mode 연결을 열고, 봇 토큰으로 메시지를 읽고 씁니다.",
  },
  {
    id: "mention",
    tab: "bot",
    label: "응답 대상",
    help: "누구의 멘션에, 몇 개까지 동시에 답할지 정합니다.",
  },
  {
    id: "reasoner",
    tab: "bot",
    label: "추론",
    help: "답변을 만들 로컬 CLI 와 실행 환경입니다.",
  },
  {
    id: "render",
    tab: "bot",
    label: "그림",
    help: "답변의 다이어그램과 생성 이미지를 올리는 방식입니다.",
  },
  {
    id: "history",
    tab: "bot",
    label: "기록과 로그",
    help: "작업 기록과 로그를 남기는 방식입니다.",
  },
  {
    id: "sandbox",
    tab: "sandbox",
    label: "추론 샌드박스",
    help: "요청마다 새로 뜨는 추론 컨테이너입니다. 자격 증명은 여기서 정한 것만 들어가고, 바깥 접속은 프록시의 허용 도메인으로만 나갑니다.",
  },
  {
    id: "ops",
    tab: "sandbox",
    label: "운영 도구 (ops-broker)",
    help: "SSH 키, kubeconfig, GitHub 토큰은 broker 컨테이너에만 있고, 추론 컨테이너는 정해진 도구로만 요청합니다.",
  },
];

export const SETTING_FIELDS: SettingField[] = [
  {
    key: "SLACK_APP_TOKEN",
    group: "connection",
    label: "앱 토큰",
    help: "Basic Information > App-Level Tokens (connections:write). Socket Mode 연결에 씁니다.",
    type: "secret",
    placeholder: "xapp-...",
    required: true,
  },
  {
    key: "SLACK_BOT_TOKEN",
    group: "connection",
    label: "봇 토큰",
    help: "OAuth & Permissions > Bot User OAuth Token",
    type: "secret",
    placeholder: "xoxb-...",
    required: true,
  },
  {
    key: "LOG_LEVEL",
    group: "connection",
    label: "로그 수준",
    help: "debug 이면 Socket Mode 클라이언트의 상세 로그까지 남습니다.",
    type: "select",
    options: ["debug", "info", "warn", "error"].map((value) => ({ value, label: value })),
    default: "info",
  },
  {
    key: "SOCKET_CLIENT_PING_TIMEOUT_MS",
    group: "connection",
    label: "클라이언트 ping 제한 시간 (ms)",
    help: "봇이 보낸 ping 에 이 시간 안에 응답이 없으면 다시 연결합니다. (1000 ~ 60000)",
    type: "number",
    default: "5000",
    advanced: true,
  },
  {
    key: "SOCKET_SERVER_PING_TIMEOUT_MS",
    group: "connection",
    label: "서버 ping 제한 시간 (ms)",
    help: "Slack 의 ping 이 이 시간 동안 오지 않으면 다시 연결합니다. (5000 ~ 300000)",
    type: "number",
    default: "30000",
    advanced: true,
  },
  {
    key: "SOCKET_PING_PONG_LOG",
    group: "connection",
    label: "ping/pong 로그",
    help: "연결 유지 신호를 로그에 남깁니다. 로그 수준이 debug 일 때 보입니다.",
    type: "toggle",
    default: "off",
    advanced: true,
  },
  {
    key: "MENTION_ALLOWED_USERS",
    group: "mention",
    label: "허용 사용자",
    help: "쉼표로 구분한 Slack 사용자 ID (U...). 비우면 모든 사용자에게 답합니다. ops 도구를 켜면 반드시 지정합니다.",
    type: "text",
    placeholder: "U0123ABCD, U0456EFGH",
  },
  {
    key: "MENTION_CONCURRENCY",
    group: "mention",
    label: "동시 처리 수",
    type: "number",
    default: "2",
  },
  {
    key: "TIMEZONE",
    group: "mention",
    label: "시간대",
    help: "스레드 맥락의 시각 표시에 씁니다.",
    type: "text",
    default: "Asia/Seoul",
  },
  {
    key: "MENTION_WORKSPACE",
    group: "mention",
    label: "참고 디렉터리",
    help: "답변 시 읽기 전용으로 참고할 절대 경로. 파일을 읽을 수 있는 실행 환경에서만 씁니다.",
    type: "text",
    advanced: true,
  },
  {
    key: "REASONER",
    group: "reasoner",
    label: "추론 CLI",
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
    label: "모델",
    help: "비우면 claude 는 claude-opus-5-5, codex 는 ~/.codex/config.toml 의 모델을 씁니다.",
    type: "text",
  },
  {
    key: "REASONER_TIMEOUT_SEC",
    group: "reasoner",
    label: "제한 시간 (초)",
    type: "number",
    default: "900",
  },
  {
    key: "REASONER_SANDBOX",
    group: "reasoner",
    label: "실행 환경",
    type: "select",
    options: [
      { value: "none", label: "호스트에서 실행 (none)" },
      { value: "docker", label: "도커 샌드박스 (docker)" },
    ],
    default: "none",
  },
  {
    key: "RENDER_DIAGRAMS",
    group: "render",
    label: "다이어그램 그리기",
    help: "답변의 mermaid, dot, vega-lite, svg 블록을 PNG 로 그려 올립니다. (docker 필요)",
    type: "toggle",
    default: "on",
  },
  {
    key: "GENERATED_IMAGE_MAX_PX",
    group: "render",
    label: "생성 이미지 최대 크기 (px)",
    help: "긴 변을 이 크기로 줄여 올립니다. 0 이면 원본 크기",
    type: "number",
    default: "512",
  },
  {
    key: "HISTORY",
    group: "history",
    label: "작업 기록",
    type: "toggle",
    default: "on",
  },
  {
    key: "HISTORY_RETENTION_DAYS",
    group: "history",
    label: "기록 보관 기간 (일)",
    help: "0 이면 지우지 않습니다.",
    type: "number",
    default: "30",
  },
  {
    key: "SANDBOX_MEMORY",
    group: "sandbox",
    label: "메모리 제한",
    help: "docker --memory 형식 (예: 2g, 1536m)",
    type: "text",
    default: "2g",
  },
  {
    key: "SANDBOX_CPUS",
    group: "sandbox",
    label: "CPU 제한",
    type: "text",
    default: "2",
  },
  {
    key: "SANDBOX_CLAUDE_OAUTH_TOKEN",
    group: "sandbox",
    label: "claude 토큰",
    help: "샌드박스에서 claude 를 쓸 때 필요합니다. (claude setup-token)",
    type: "secret",
  },
  {
    key: "SANDBOX_ANTHROPIC_API_KEY",
    group: "sandbox",
    label: "Anthropic API 키",
    help: "claude 토큰 대신 API 키를 쓸 때",
    type: "secret",
    advanced: true,
  },
  {
    key: "SANDBOX_CODEX_AUTH_FILE",
    group: "sandbox",
    label: "codex 로그인 파일",
    help: "샌드박스에서 codex 를 쓸 때 컨테이너에 복사해 넣습니다.",
    type: "text",
    default: "~/.codex/auth.json",
  },
  {
    key: "SANDBOX_IMAGE",
    group: "sandbox",
    label: "추론 이미지",
    type: "text",
    default: "verda-reasoner:latest",
    advanced: true,
  },
  {
    key: "SANDBOX_NETWORK",
    group: "sandbox",
    label: "도커 네트워크",
    help: "바깥으로 직접 나갈 수 없는 내부 네트워크",
    type: "text",
    default: "verda-sandbox",
    advanced: true,
  },
  {
    key: "SANDBOX_PROXY_URL",
    group: "sandbox",
    label: "프록시 주소",
    type: "text",
    default: "http://egress-proxy:8888",
    advanced: true,
  },
  {
    key: "OPS_TOOLS",
    group: "ops",
    label: "운영 도구 사용",
    help: "SSH 호스트 점검, k8s 조회, 작업 디렉터리, GitHub, PR, Jira 도구. 도커 샌드박스와 허용 사용자가 필요합니다. 아래에서 비워 둔 기능은 꺼집니다.",
    type: "toggle",
    default: "off",
  },
  {
    key: "OPS_GIT_ALLOWED_OWNERS",
    group: "ops",
    label: "GitHub 허용 조직",
    help: "PR 생성과 GitHub 조회를 이 조직(또는 사용자)의 저장소로 제한합니다. 쉼표로 구분, 비우면 GitHub 도구가 꺼집니다.",
    type: "text",
    placeholder: "my-org, my-user",
    applies: "broker",
  },
  {
    key: "OPS_GIT_AUTHOR_NAME",
    group: "ops",
    label: "PR 커밋 작성자 이름",
    help: "샌드박스가 만드는 커밋의 작성자. 비우면 전역 git 설정(git config --global user.name)을 씁니다. 이 저장소의 git 설정과는 별개입니다.",
    type: "text",
    applies: "broker",
  },
  {
    key: "OPS_GIT_AUTHOR_EMAIL",
    group: "ops",
    label: "PR 커밋 작성자 이메일",
    help: "비우면 전역 git 설정(git config --global user.email)을 씁니다.",
    type: "text",
    applies: "broker",
  },
  {
    key: "OPS_JIRA_URL",
    group: "ops",
    label: "Jira 주소",
    help: "Jira Cloud 사이트 주소. 주소, 이메일, 토큰, 프로젝트를 모두 설정해야 Jira 도구가 켜집니다.",
    type: "text",
    placeholder: "https://your-site.atlassian.net",
    applies: "broker",
  },
  {
    key: "OPS_JIRA_EMAIL",
    group: "ops",
    label: "Jira 계정 이메일",
    help: "API 토큰 주인의 Atlassian 계정. 이슈와 댓글이 이 계정 이름으로 남습니다.",
    type: "text",
    applies: "broker",
  },
  {
    key: "OPS_JIRA_TOKEN",
    group: "ops",
    label: "Jira API 토큰",
    help: "id.atlassian.com 의 보안 > API 토큰에서 만듭니다. broker 컨테이너에만 넘어갑니다.",
    type: "secret",
    applies: "broker",
  },
  {
    key: "OPS_JIRA_PROJECTS",
    group: "ops",
    label: "Jira 허용 프로젝트",
    help: "조회, 생성, 댓글을 이 프로젝트로 제한합니다. 쉼표로 구분한 프로젝트 키",
    type: "text",
    placeholder: "PROJ, OPS",
    applies: "broker",
  },
  {
    key: "OPS_FS_ROOT",
    group: "ops",
    label: "파일 조회 루트",
    help: "읽기 전용으로 마운트할 작업 디렉터리 (절대 경로). 비우면 파일 도구와 PR 도구가 꺼집니다.",
    type: "text",
    placeholder: "/Users/me/workspaces",
    applies: "broker",
  },
  {
    key: "OPS_SSH_USER",
    group: "ops",
    label: "SSH 사용자",
    help: "호스트 점검에 쓸 계정. 사용자, 허용 대역, 키를 모두 설정해야 호스트 점검이 켜집니다.",
    type: "text",
    applies: "broker",
  },
  {
    key: "OPS_SSH_ALLOWED_CIDR",
    group: "ops",
    label: "SSH 허용 대역",
    help: "이 대역 안의 호스트만 SSH 점검합니다.",
    type: "text",
    placeholder: "192.168.10.0/24",
    applies: "broker",
  },
  {
    key: "OPS_SSH_KEY",
    group: "ops",
    label: "SSH 키 경로",
    help: "절대 경로. 키 내용은 broker 컨테이너에만 마운트됩니다.",
    type: "text",
    placeholder: "/Users/me/.ssh/id_ed25519",
    applies: "broker",
  },
  {
    key: "OPS_SSH_KNOWN_HOSTS",
    group: "ops",
    label: "SSH known_hosts 경로",
    help: "절대 경로. 비우면 처음 접속한 호스트 키를 broker 안에서만 기억합니다.",
    type: "text",
    advanced: true,
    applies: "broker",
  },
  {
    key: "OPS_SSH_INVENTORY_DIR",
    group: "ops",
    label: "인벤토리 디렉터리",
    help: "호스트 목록을 만들 ansible 프로젝트 위치. 상대 경로는 이 저장소 기준. 비우면 ~/.verda/ops-broker/hosts.json 을 직접 씁니다.",
    type: "text",
    advanced: true,
    applies: "broker",
  },
  {
    key: "OPS_SSH_INVENTORY",
    group: "ops",
    label: "인벤토리 파일",
    help: "인벤토리 디렉터리 안의 상대 경로",
    type: "text",
    placeholder: "inventory.ini",
    advanced: true,
    applies: "broker",
  },
  {
    key: "OPS_K8S_CONTEXTS",
    group: "ops",
    label: "k8s 컨텍스트",
    help: "조회 전용 kubeconfig 를 만들 로컬 kubeconfig 컨텍스트. 쉼표로 구분, 바꾼 뒤 kubeconfig 를 다시 만듭니다.",
    type: "text",
    applies: "broker",
  },
  {
    key: "OPS_K8S_SA",
    group: "ops",
    label: "k8s 조회 계정",
    help: "각 클러스터의 조회 전용 ServiceAccount (sandbox/k8s/verda-ro.yaml)",
    type: "text",
    default: "verda-ro",
    advanced: true,
    applies: "broker",
  },
  {
    key: "OPS_K8S_SA_NAMESPACE",
    group: "ops",
    label: "k8s 조회 계정 네임스페이스",
    type: "text",
    default: "verda",
    advanced: true,
    applies: "broker",
  },
  {
    key: "OPS_BROKER_URL",
    group: "ops",
    label: "broker 주소",
    type: "text",
    default: "http://ops-broker:8080/mcp",
    advanced: true,
  },
];

/** null 이면 .env 에서 값을 비워 기본값으로 되돌린다. */
export type SettingsChanges = Record<string, string | null>;

export interface SettingsView {
  envFile: string;
  exists: boolean;
  dataDir: string;
  /** 비밀 값이 아닌 항목의 현재 값 (.env 에 없으면 빈 문자열) */
  values: Record<string, string>;
  /** 비밀 값은 설정 여부와 끝 4자리만 */
  secrets: Record<string, { set: boolean; hint?: string }>;
  /** 앱의 환경 변수에 있어서 .env 보다 우선하는 항목 */
  overridden: string[];
  /** 설정 화면이 다루지 않는 .env 항목 (저장해도 그대로 남는다) */
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
