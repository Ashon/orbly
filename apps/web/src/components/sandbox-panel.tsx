import {
  SANDBOX_JOBS,
  type AllowlistIssue,
  type PendingApply,
  type SandboxComponent,
  type SandboxJob,
  type SandboxJobKind,
  type SandboxStatus,
} from "@src/sandbox/types";
import {
  CircleCheck,
  CircleX,
  Lock,
  LoaderCircle,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  TriangleAlert,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { botControl, useSupervisor, type useSandbox } from "@/lib/desktop";
import { formatDuration, formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

type Sandbox = ReturnType<typeof useSandbox>;

export const APPLY_LABEL: Record<SandboxComponent, string> = {
  bot: "봇 재시작",
  proxy: "프록시 재시작",
  broker: "broker 다시 띄우기",
};

function Card({
  title,
  help,
  action,
  children,
}: {
  title: string;
  help?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border bg-card">
      <header className="flex items-start gap-3 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">{title}</h2>
          {help && <div className="mt-0.5 text-xs text-muted-foreground">{help}</div>}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

const Dot = ({ ok, warn }: { ok: boolean; warn?: boolean }) => (
  <span
    className={cn(
      "inline-block size-2 shrink-0 rounded-full",
      ok ? "bg-status-succeeded" : warn ? "bg-status-interrupted" : "bg-status-failed"
    )}
  />
);

/** 상태, 적용이 필요한 항목, 점검 결과 */
export function SandboxStatusCard({ sandbox }: { sandbox: Sandbox }) {
  const { status, loading, refresh } = sandbox;
  return (
    <Card
      title="샌드박스 상태"
      help={status ? `확인 ${formatRelative(status.checkedAt)}` : "확인하는 중"}
      action={
        <Button size="sm" variant="outline" onClick={refresh} disabled={loading}>
          <RefreshCw className={cn(loading && "animate-spin")} />
          새로 고침
        </Button>
      }
    >
      {status && (
        <div className="divide-y">
          {status.pending.length > 0 && (
            <PendingList pending={status.pending} sandbox={sandbox} />
          )}
          <Line label="docker">
            <Dot ok={status.docker.ok} />
            {status.docker.ok
              ? `엔진 ${status.docker.version}`
              : (status.docker.error ?? "사용할 수 없음")}
          </Line>
          <Line label="이미지">
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {status.images.map((image) => (
                <span
                  key={image.name}
                  className="flex items-center gap-1.5"
                  title={image.purpose}
                >
                  <Dot ok={image.present} />
                  {image.name.replace(/^verda-|:latest$/g, "")}
                  {image.createdAt && (
                    <span className="text-muted-foreground">
                      ({formatRelative(image.createdAt)} 빌드)
                    </span>
                  )}
                </span>
              ))}
            </div>
          </Line>
          <Line label="컨테이너">
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {status.containers.map((c) => (
                <span key={c.service} className="flex items-center gap-1.5">
                  <Dot ok={c.state === "running"} warn={c.state === "missing"} />
                  {c.service}
                  <span className="text-muted-foreground">
                    {c.state === "running"
                      ? `실행 중${c.startedAt ? `, ${formatDuration(Date.now() - Date.parse(c.startedAt))}째` : ""}`
                      : c.state === "missing"
                        ? "없음"
                        : c.state}
                  </span>
                </span>
              ))}
            </div>
          </Line>
          {status.broker && (
            <Line label="broker 도구">
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                <span className="flex items-center gap-1.5">
                  <Dot ok={status.broker.sshHosts > 0} warn />
                  {status.broker.sshHosts > 0
                    ? `SSH 호스트 ${status.broker.sshHosts}개`
                    : "SSH 꺼짐"}
                </span>
                <span className="flex items-center gap-1.5">
                  <Dot ok={status.broker.k8s.length > 0} warn />
                  k8s {status.broker.k8s.length ? status.broker.k8s.join(", ") : "꺼짐"}
                </span>
                <span className="flex items-center gap-1.5">
                  <Dot ok={Boolean(status.broker.fs)} warn />
                  파일 {status.broker.fs ? "켜짐" : "꺼짐"}
                </span>
                <span className="flex items-center gap-1.5">
                  <Dot ok={status.broker.github.length > 0} warn />
                  GitHub{" "}
                  {status.broker.github.length ? status.broker.github.join(", ") : "꺼짐"}
                </span>
                <span className="flex items-center gap-1.5">
                  <Dot ok={status.broker.git} warn />
                  PR {status.broker.git ? "켜짐" : "꺼짐"}
                </span>
                <span className="flex items-center gap-1.5">
                  <Dot ok={status.broker.jira.length > 0} warn />
                  Jira{" "}
                  {status.broker.jira.length ? status.broker.jira.join(", ") : "꺼짐"}
                </span>
              </div>
            </Line>
          )}
          {status.checks.map((check) => (
            <Line key={check.label} label={check.label}>
              {check.ok ? (
                <CircleCheck className="size-3.5 shrink-0 text-status-succeeded" />
              ) : (
                <CircleX className="size-3.5 shrink-0 text-status-failed" />
              )}
              <span className={cn("break-all", !check.ok && "text-status-failed")}>
                {check.detail}
              </span>
            </Line>
          ))}
        </div>
      )}
    </Card>
  );
}

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 px-4 py-2.5 text-xs">
      <span className="w-28 shrink-0 font-medium">{label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">{children}</div>
    </div>
  );
}

function PendingList({
  pending,
  sandbox,
}: {
  pending: PendingApply[];
  sandbox: Sandbox;
}) {
  const supervisor = useSupervisor();
  const components = [...new Set(pending.map((item) => item.component))];
  const busy = sandbox.job?.state === "running";
  const active = sandbox.status?.activeRequests ?? 0;
  const apply = (component: SandboxComponent) => {
    if (component === "bot") {
      const live = supervisor?.phase === "running" || supervisor?.phase === "starting";
      void (live ? botControl()?.restart() : botControl()?.start());
      setTimeout(sandbox.refresh, 4_000);
    } else {
      sandbox.run(component);
    }
  };
  return (
    <div className="space-y-2 bg-status-interrupted/8 px-4 py-3">
      {components.map((component) => (
        <div key={component} className="flex items-start gap-3 text-xs">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-status-interrupted" />
          <div className="min-w-0 flex-1">
            <p className="font-medium text-status-interrupted">
              {APPLY_LABEL[component]} 필요
            </p>
            <ul className="mt-0.5 text-muted-foreground">
              {pending
                .filter((item) => item.component === component)
                .map((item) => (
                  <li key={item.reason}>{item.reason}</li>
                ))}
            </ul>
          </div>
          {component === "bot" && supervisor?.phase === "external" ? (
            <span className="text-muted-foreground">터미널 봇은 직접 재시작</span>
          ) : (
            <Button
              size="xs"
              variant="outline"
              disabled={
                busy ||
                (component !== "bot" && active > 0) ||
                (component === "bot" && !supervisor)
              }
              onClick={() => apply(component)}
              title={
                component !== "bot" && active > 0
                  ? `처리 중인 요청 ${active}건이 끝난 뒤`
                  : undefined
              }
            >
              {APPLY_LABEL[component]}
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}

/** 바깥 접속 허용 도메인 편집 */
export function AllowlistCard({ sandbox }: { sandbox: Sandbox }) {
  const status = sandbox.status;
  const saved = status?.allowlist.domains ?? [];
  const required = status?.allowlist.required ?? [];
  const [draft, setDraft] = useState<string[]>();
  const [input, setInput] = useState("");
  const [issues, setIssues] = useState<AllowlistIssue[]>([]);
  const [notice, setNotice] = useState<string>();
  const domains = draft ?? saved;
  const dirty = draft !== undefined && JSON.stringify(draft) !== JSON.stringify(saved);

  const add = () => {
    const domain = input.trim().toLowerCase().replace(/\.$/, "");
    if (!domain || domains.includes(domain)) return;
    setDraft([...domains, domain]);
    setInput("");
  };
  const save = () => {
    void window.verdaDesktop?.sandbox.saveAllowlist(domains).then((found) => {
      setIssues(found);
      if (found.length === 0) {
        setDraft(undefined);
        setNotice("저장했습니다. 프록시를 재시작해야 적용됩니다.");
        sandbox.refresh();
      }
    });
  };

  return (
    <Card
      title="바깥 접속 허용 도메인"
      help={
        <>
          추론 컨테이너가 프록시를 거쳐 직접 접속할 수 있는 도메인입니다. HTTPS(443)만,
          이름이 정확히 같을 때만 허용합니다.
          <span className="ml-1 whitespace-nowrap text-status-interrupted">
            적용: 프록시 재시작
          </span>
        </>
      }
    >
      <div className="space-y-3 px-4 py-3">
        <p className="flex items-start gap-1.5 rounded-lg border border-status-interrupted/30 bg-status-interrupted/8 px-3 py-2 text-xs text-status-interrupted">
          <TriangleAlert className="mt-px size-3.5 shrink-0" />
          도메인을 열면 추론 컨테이너가 그곳으로 직접 데이터를 보낼 수 있습니다. 토큰이
          필요한 내부 시스템(GitHub 등)은 도메인을 여는 대신 ops-broker 도구로 붙이는 것을
          권합니다. (토큰이 샌드박스에 들어가지 않습니다)
        </p>
        <ul className="divide-y rounded-lg border">
          {domains.map((domain) => {
            const isRequired = required.includes(domain);
            const issue = issues.find((item) => item.domain === domain);
            return (
              <li key={domain} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                <span className="font-mono">{domain}</span>
                {isRequired && (
                  <span className="flex items-center gap-1 rounded bg-muted px-1.5 text-[10px] text-muted-foreground">
                    <Lock className="size-2.5" />
                    추론 CLI 필요
                  </span>
                )}
                {!saved.includes(domain) && (
                  <span className="text-[10px] text-primary">추가됨</span>
                )}
                {issue && <span className="text-status-failed">{issue.message}</span>}
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="ml-auto size-6"
                  disabled={isRequired}
                  aria-label={`${domain} 빼기`}
                  onClick={() => setDraft(domains.filter((item) => item !== domain))}
                >
                  <X />
                </Button>
              </li>
            );
          })}
        </ul>
        <div className="flex items-center gap-2">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
            placeholder="api.example.com"
            className="h-7 w-72 font-mono text-xs"
          />
          <Button size="sm" variant="outline" onClick={add} disabled={!input.trim()}>
            <Plus />
            추가
          </Button>
          <div className="ml-auto flex items-center gap-1.5">
            {dirty && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => (setDraft(undefined), setIssues([]))}
              >
                <RotateCcw />
                되돌리기
              </Button>
            )}
            <Button size="sm" onClick={save} disabled={!dirty}>
              <Save />
              저장
            </Button>
          </div>
        </div>
        {issues.some((item) => !domains.includes(item.domain ?? "")) && (
          <ul className="text-xs text-status-failed">
            {issues
              .filter((item) => !domains.includes(item.domain ?? ""))
              .map((item) => (
                <li key={`${item.domain}-${item.message}`}>
                  {item.domain}: {item.message}
                </li>
              ))}
          </ul>
        )}
        {notice && !dirty && <p className="text-xs text-status-interrupted">{notice}</p>}
      </div>
    </Card>
  );
}

const JOB_ORDER: SandboxJobKind[] = ["images", "kubeconfig", "proxy", "broker"];

/** 적용 작업 실행과 출력 */
export function JobsCard({ sandbox }: { sandbox: Sandbox }) {
  const { job, run, error, status } = sandbox;
  const running = job?.state === "running";
  const active = status?.activeRequests ?? 0;
  const output = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (output.current) output.current.scrollTop = output.current.scrollHeight;
  }, [job?.output.length]);

  return (
    <Card
      title="적용 작업"
      help="저장소의 pnpm 스크립트를 앱에서 실행합니다. 한 번에 하나씩 돌고, 출력의 비밀 값은 가려집니다."
    >
      <div className="divide-y">
        {JOB_ORDER.map((kind) => {
          const disruptive = kind === "proxy" || kind === "broker";
          return (
            <div key={kind} className="flex items-center gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{SANDBOX_JOBS[kind].label}</div>
                <div className="text-xs text-muted-foreground">
                  {SANDBOX_JOBS[kind].help}{" "}
                  <span className="font-mono">pnpm {SANDBOX_JOBS[kind].script}</span>
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={running || (disruptive && active > 0)}
                title={
                  disruptive && active > 0
                    ? `처리 중인 요청 ${active}건이 끝난 뒤`
                    : undefined
                }
                onClick={() => run(kind)}
              >
                {running && job?.kind === kind ? (
                  <LoaderCircle className="animate-spin" />
                ) : null}
                실행
              </Button>
            </div>
          );
        })}
      </div>
      {error && <p className="border-t px-4 py-2 text-xs text-status-failed">{error}</p>}
      {job && <JobOutput job={job} outputRef={output} />}
    </Card>
  );
}

function JobOutput({
  job,
  outputRef,
}: {
  job: SandboxJob;
  outputRef: React.RefObject<HTMLPreElement | null>;
}) {
  const elapsed =
    (job.finishedAt ? Date.parse(job.finishedAt) : Date.now()) -
    Date.parse(job.startedAt);
  return (
    <div className="border-t px-4 py-3">
      <div className="mb-2 flex items-center gap-2 text-xs">
        {job.state === "running" ? (
          <LoaderCircle className="size-3.5 animate-spin text-status-running" />
        ) : job.state === "succeeded" ? (
          <CircleCheck className="size-3.5 text-status-succeeded" />
        ) : (
          <CircleX className="size-3.5 text-status-failed" />
        )}
        <span className="font-medium">{SANDBOX_JOBS[job.kind].label}</span>
        <span className="text-muted-foreground">
          {job.state === "running"
            ? "진행 중"
            : job.state === "succeeded"
              ? "완료"
              : `실패 (code ${job.exitCode ?? "?"})`}
          , {formatDuration(elapsed)}
        </span>
      </div>
      <pre
        ref={outputRef}
        className="max-h-64 overflow-auto rounded-lg border bg-muted/60 px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words"
      >
        {job.output.join("\n")}
      </pre>
    </div>
  );
}

export type { SandboxStatus };
