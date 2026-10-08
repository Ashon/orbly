import path from "node:path";
import { z } from "zod";
import type { ConfigIssue } from "../config.js";

/** compose 는 .env 값의 ~ 를 펼치지 않아서 마운트 경로는 절대 경로만 받는다. */
const absolutePath = z
  .string()
  .refine(
    (value) => value.startsWith("/"),
    "절대 경로여야 합니다. (~ 는 펼쳐지지 않습니다)"
  );

const owner = "[A-Za-z0-9][A-Za-z0-9-]*";
const projectKey = "[A-Za-z][A-Za-z0-9_]*";
const name = "[A-Za-z0-9][A-Za-z0-9._@-]*";

/**
 * ops-broker 와 그 준비 작업(sandbox-job 의 broker, kubeconfig)이 .env 에서 읽는 값.
 * sandbox/compose.yaml 의 기본값과 같아야 한다. 비어 있는 기능은 broker 가 도구 없이 뜬다.
 */
export const BrokerEnvSchema = z.object({
  /** 읽기 전용으로 마운트할 작업 디렉터리 (fs_*, ws_*). 비우면 파일 도구가 꺼진다. */
  OPS_FS_ROOT: absolutePath.optional(),
  /** PR 생성과 GitHub 조회(ws_*, gh_*)를 허용할 조직. 비우면 GitHub 도구가 꺼진다. */
  OPS_GIT_ALLOWED_OWNERS: z
    .string()
    .regex(
      new RegExp(`^\\s*${owner}(\\s*,\\s*${owner})*\\s*$`),
      "쉼표로 구분한 GitHub 조직 이름이어야 합니다"
    )
    .optional(),
  /**
   * 샌드박스가 만드는 커밋(ws_create_pr)의 작성자. 비우면 전역 git 설정(git config --global)을 쓴다.
   * 이 저장소의 git 설정과는 별개다.
   */
  OPS_GIT_AUTHOR_NAME: z.string().optional(),
  OPS_GIT_AUTHOR_EMAIL: z.email("이메일 형식이어야 합니다").optional(),
  /** Jira 조회와 이슈 생성, 댓글(jira_*). 넷 다 있어야 켜진다. 쓰기는 토큰 주인 계정으로 남는다. */
  OPS_JIRA_URL: z
    .url({
      protocol: /^https$/,
      error: "https 주소여야 합니다 (예: https://your-site.atlassian.net)",
    })
    .optional(),
  OPS_JIRA_EMAIL: z.email("이메일 형식이어야 합니다").optional(),
  OPS_JIRA_TOKEN: z.string().optional(),
  OPS_JIRA_PROJECTS: z
    .string()
    .regex(
      new RegExp(`^\\s*${projectKey}(\\s*,\\s*${projectKey})*\\s*$`),
      "쉼표로 구분한 Jira 프로젝트 키여야 합니다"
    )
    .optional(),
  /** 호스트 목록을 만들 ansible 인벤토리가 있는 디렉터리. 상대 경로는 이 저장소 기준 */
  OPS_SSH_INVENTORY_DIR: z.string().optional(),
  OPS_SSH_INVENTORY: z
    .string()
    .regex(/^[A-Za-z0-9._/-]+$/, "인벤토리 디렉터리 안의 상대 경로여야 합니다")
    .refine(
      (value) => !value.split("/").includes(".."),
      "인벤토리 디렉터리 밖을 가리킬 수 없습니다"
    )
    .optional(),
  OPS_SSH_ALLOWED_CIDR: z
    .string()
    .regex(
      /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/,
      "IPv4 CIDR 이어야 합니다 (예: 192.168.10.0/24)"
    )
    .optional(),
  OPS_SSH_USER: z
    .string()
    .regex(/^[a-z_][a-z0-9_-]{0,31}$/, "리눅스 사용자 이름 형식이어야 합니다")
    .optional(),
  OPS_SSH_KEY: absolutePath.optional(),
  OPS_SSH_KNOWN_HOSTS: absolutePath.optional(),
  /** 조회 전용 kubeconfig 를 만들 로컬 kubeconfig 컨텍스트. 비우면 k8s 도구가 꺼진다. */
  OPS_K8S_CONTEXTS: z
    .string()
    .regex(
      new RegExp(`^\\s*${name}(\\s*,\\s*${name})*\\s*$`),
      "쉼표로 구분한 kubeconfig 컨텍스트 이름이어야 합니다"
    )
    .optional(),
  OPS_K8S_SA: z
    .string()
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, "ServiceAccount 이름 형식이어야 합니다")
    .default("verda-ro"),
  OPS_K8S_SA_NAMESPACE: z
    .string()
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, "네임스페이스 이름 형식이어야 합니다")
    .default("verda"),
});

export type BrokerEnv = z.infer<typeof BrokerEnvSchema>;

function provided(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        entry[0] in BrokerEnvSchema.shape && Boolean(entry[1]?.trim())
    )
  );
}

export function checkBrokerEnv(env: NodeJS.ProcessEnv): ConfigIssue[] {
  const parsed = BrokerEnvSchema.safeParse(provided(env));
  if (parsed.success) return [];
  return parsed.error.issues.map((issue) => ({
    key: issue.path[0] === undefined ? undefined : String(issue.path[0]),
    message: issue.message,
  }));
}

/** .env 를 검증해서 읽는다. 준비 작업(sandbox-job 의 broker, kubeconfig)이 쓴다. */
export function loadBrokerEnv(env: NodeJS.ProcessEnv): BrokerEnv {
  const parsed = BrokerEnvSchema.safeParse(provided(env));
  if (parsed.success) return parsed.data;
  throw new Error(
    parsed.error.issues
      .map((issue) => `${String(issue.path[0] ?? "")}: ${issue.message}`)
      .join("\n")
  );
}

/** 쉼표 목록을 배열로 */
export function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * 설정하지 않은 마운트가 대신 가리키는 빈 자리. broker 작업이 만든다. (src/sandbox/prepare.ts)
 * (runtimeDir 은 brokerRuntimeDir(), sandbox/compose.yaml 과 같아야 한다)
 */
export function unsetMount(runtimeDir: string, name: string): string {
  return path.join(runtimeDir, "unset", name);
}

/** compose 가 실제로 쓰는 값 (기본값을 펼친 결과). broker 와 비교할 때 쓴다. */
export function brokerExpected(env: NodeJS.ProcessEnv, runtimeDir: string) {
  const parsed = BrokerEnvSchema.parse(provided(env));
  const unset = (name: string) => unsetMount(runtimeDir, name);
  return {
    sshUser: parsed.OPS_SSH_USER ?? "",
    allowedCidr: parsed.OPS_SSH_ALLOWED_CIDR ?? "",
    allowedOwners: parsed.OPS_GIT_ALLOWED_OWNERS ?? "",
    jiraUrl: parsed.OPS_JIRA_URL ?? "",
    jiraEmail: parsed.OPS_JIRA_EMAIL ?? "",
    jiraProjects: parsed.OPS_JIRA_PROJECTS ?? "",
    /** 설정한 값만. 빈 값은 broker 가 해당 도구 없이 뜬다. */
    configured: {
      fsRoot: Boolean(parsed.OPS_FS_ROOT),
      ssh: Boolean(
        parsed.OPS_SSH_USER && parsed.OPS_SSH_ALLOWED_CIDR && parsed.OPS_SSH_KEY
      ),
    },
    fsRoot: parsed.OPS_FS_ROOT ?? unset("workspace"),
    sshKey: parsed.OPS_SSH_KEY ?? unset("ssh-key"),
    knownHosts: parsed.OPS_SSH_KNOWN_HOSTS ?? unset("known_hosts"),
  };
}
