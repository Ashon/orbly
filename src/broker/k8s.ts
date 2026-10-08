/**
 * kubectl 조회 명령을 인자 배열로 만든다. 셸을 거치지 않고, 모든 값은 형식 검증을 통과해야 한다.
 * 조회 권한 자체는 클러스터 쪽 RBAC(조회 전용 ServiceAccount, secrets 제외)이 강제한다.
 */
const NAME = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;
const KIND = /^[a-z][a-z0-9.-]{0,62}$/;
const SELECTOR = /^[A-Za-z0-9._/=,!() -]{1,200}$/;
const SINCE = /^\d{1,4}[smh]$/;
const DENIED_KINDS = new Set([
  "secret",
  "secrets",
  "serviceaccounttoken",
  "tokenreviews",
]);

export const MAX_LOG_LINES = 2_000;

function check(value: string | undefined, pattern: RegExp, label: string): void {
  if (value !== undefined && !pattern.test(value)) {
    throw new Error(`${label} 형식이 올바르지 않습니다: ${value}`);
  }
}

function checkKind(kind: string): void {
  check(kind, KIND, "kind");
  const base = kind.split(".")[0]!;
  if (DENIED_KINDS.has(base)) throw new Error("secrets 는 조회할 수 없습니다.");
}

function base(cluster: string, clusters: readonly string[]): string[] {
  if (!clusters.includes(cluster)) {
    throw new Error(
      `허용된 클러스터가 아닙니다: ${cluster} (가능: ${clusters.join(", ")})`
    );
  }
  return ["--context", cluster, "--request-timeout=20s"];
}

export interface GetArgs {
  cluster: string;
  kind: string;
  namespace?: string;
  name?: string;
  selector?: string;
  allNamespaces?: boolean;
  output?: "wide" | "yaml";
}

export function getArgs(a: GetArgs, clusters: readonly string[]): string[] {
  checkKind(a.kind);
  check(a.namespace, NAME, "namespace");
  check(a.name, NAME, "name");
  check(a.selector, SELECTOR, "selector");
  const args = [...base(a.cluster, clusters), "get", a.kind];
  if (a.name) args.push(a.name);
  if (a.allNamespaces && !a.name) args.push("--all-namespaces");
  else if (a.namespace) args.push("--namespace", a.namespace);
  if (a.selector) args.push("--selector", a.selector);
  args.push("--output", a.output ?? "wide");
  return args;
}

export function describeArgs(
  a: { cluster: string; kind: string; name: string; namespace?: string },
  clusters: readonly string[]
): string[] {
  checkKind(a.kind);
  check(a.name, NAME, "name");
  check(a.namespace, NAME, "namespace");
  const args = [...base(a.cluster, clusters), "describe", a.kind, a.name];
  if (a.namespace) args.push("--namespace", a.namespace);
  return args;
}

export interface LogsArgs {
  cluster: string;
  namespace: string;
  pod: string;
  container?: string;
  tail?: number;
  since?: string;
  previous?: boolean;
}

export function logsArgs(a: LogsArgs, clusters: readonly string[]): string[] {
  check(a.namespace, NAME, "namespace");
  check(a.pod, NAME, "pod");
  check(a.container, NAME, "container");
  check(a.since, SINCE, "since");
  const tail = a.tail ?? 200;
  if (!Number.isInteger(tail) || tail < 1 || tail > MAX_LOG_LINES) {
    throw new Error(`tail 은 1-${MAX_LOG_LINES} 사이 정수여야 합니다.`);
  }
  const args = [...base(a.cluster, clusters), "logs", a.pod, "--namespace", a.namespace];
  args.push("--tail", String(tail), "--timestamps");
  if (a.container) args.push("--container", a.container);
  if (a.since) args.push("--since", a.since);
  if (a.previous) args.push("--previous");
  return args;
}

export function eventsArgs(
  a: { cluster: string; namespace?: string },
  clusters: readonly string[]
): string[] {
  check(a.namespace, NAME, "namespace");
  const args = [
    ...base(a.cluster, clusters),
    "get",
    "events",
    "--sort-by=.lastTimestamp",
  ];
  args.push(...(a.namespace ? ["--namespace", a.namespace] : ["--all-namespaces"]));
  return args;
}

export function topArgs(
  a: { cluster: string; target: "nodes" | "pods"; namespace?: string },
  clusters: readonly string[]
): string[] {
  check(a.namespace, NAME, "namespace");
  const args = [
    ...base(a.cluster, clusters),
    "top",
    a.target === "nodes" ? "nodes" : "pods",
  ];
  if (a.target === "pods") {
    args.push(...(a.namespace ? ["--namespace", a.namespace] : ["--all-namespaces"]));
  }
  return args;
}
