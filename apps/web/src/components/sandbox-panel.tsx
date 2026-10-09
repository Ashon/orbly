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
  bot: "Restart bot",
  proxy: "Restart proxy",
  broker: "Recreate broker",
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
    <section className="surface-card overflow-hidden">
      <header className="flex items-start gap-3 border-b border-canvas px-4 py-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">{title}</h3>
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

/** Status, items that need apply, check results */
export function SandboxStatusCard({ sandbox }: { sandbox: Sandbox }) {
  const { status, loading, refresh } = sandbox;
  return (
    <Card
      title="Sandbox status"
      help={status ? `Checked ${formatRelative(status.checkedAt)}` : "Checking"}
      action={
        <Button size="sm" variant="outline" onClick={refresh} disabled={loading}>
          <RefreshCw className={cn(loading && "animate-spin")} />
          Refresh
        </Button>
      }
    >
      {status && (
        <div className="divide-y divide-canvas">
          {status.pending.length > 0 && (
            <PendingList pending={status.pending} sandbox={sandbox} />
          )}
          <Line label="docker">
            <Dot ok={status.docker.ok} />
            {status.docker.ok
              ? `Engine ${status.docker.version}`
              : (status.docker.error ?? "Unavailable")}
          </Line>
          <Line label="Images">
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {status.images.map((image) => (
                <span
                  key={image.name}
                  className="flex items-center gap-1.5"
                  title={image.purpose}
                >
                  <Dot ok={image.present} />
                  {image.name.replace(/^pacenote-|:latest$/g, "")}
                  {image.createdAt && (
                    <span className="text-muted-foreground">
                      (built {formatRelative(image.createdAt)})
                    </span>
                  )}
                </span>
              ))}
            </div>
          </Line>
          <Line label="Containers">
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {status.containers.map((c) => (
                <span key={c.service} className="flex items-center gap-1.5">
                  <Dot ok={c.state === "running"} warn={c.state === "missing"} />
                  {c.service}
                  <span className="text-muted-foreground">
                    {c.state === "running"
                      ? `running${c.startedAt ? `, up ${formatDuration(Date.now() - Date.parse(c.startedAt))}` : ""}`
                      : c.state === "missing"
                        ? "missing"
                        : c.state}
                  </span>
                </span>
              ))}
            </div>
          </Line>
          {status.broker && (
            <Line label="broker tools">
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                <span className="flex items-center gap-1.5">
                  <Dot ok={status.broker.sshHosts > 0} warn />
                  {status.broker.sshHosts > 0
                    ? `${status.broker.sshHosts} SSH ${status.broker.sshHosts === 1 ? "host" : "hosts"}`
                    : "SSH off"}
                </span>
                <span className="flex items-center gap-1.5">
                  <Dot ok={status.broker.k8s.length > 0} warn />
                  k8s {status.broker.k8s.length ? status.broker.k8s.join(", ") : "off"}
                </span>
                <span className="flex items-center gap-1.5">
                  <Dot ok={Boolean(status.broker.fs)} warn />
                  Files {status.broker.fs ? "on" : "off"}
                </span>
                <span className="flex items-center gap-1.5">
                  <Dot ok={status.broker.github.length > 0} warn />
                  GitHub{" "}
                  {status.broker.github.length ? status.broker.github.join(", ") : "off"}
                </span>
                <span className="flex items-center gap-1.5">
                  <Dot ok={status.broker.git} warn />
                  PR {status.broker.git ? "on" : "off"}
                </span>
                <span className="flex items-center gap-1.5">
                  <Dot ok={status.broker.jira.length > 0} warn />
                  Jira {status.broker.jira.length ? status.broker.jira.join(", ") : "off"}
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
                <span className="select-text">{check.detail}</span>
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

/** Settings changed since a component started, with the button that applies them */
export function PendingList({
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
              {APPLY_LABEL[component]} needed
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
            <span className="text-muted-foreground">
              Restart the terminal bot manually
            </span>
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
                  ? `Available after ${active} active ${active === 1 ? "request finishes" : "requests finish"}`
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

/** Edits the domains allowed for outbound access */
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
    void window.pacenoteDesktop?.sandbox.saveAllowlist(domains).then((found) => {
      setIssues(found);
      if (found.length === 0) {
        setDraft(undefined);
        setNotice("Saved. Restart the proxy to apply.");
        sandbox.refresh();
      }
    });
  };

  return (
    <Card
      title="Allowed outbound domains"
      help={
        <>
          Domains the reasoner container can reach directly through the proxy. Only HTTPS
          (443) and only exact name matches are allowed.
          <span className="ml-1 whitespace-nowrap text-status-interrupted">
            Apply: Restart proxy
          </span>
        </>
      }
    >
      <div className="space-y-3 px-4 py-3">
        <p className="flex items-start gap-1.5 rounded-lg bg-status-interrupted/10 px-3 py-2 text-xs text-status-interrupted">
          <TriangleAlert className="mt-px size-3.5 shrink-0" />
          Opening a domain lets the reasoner container send data there directly. For
          internal systems that need tokens (GitHub etc.), connect them as ops-broker
          tools instead of opening the domain. (The tokens stay out of the sandbox)
        </p>
        <ul className="divide-y divide-card overflow-hidden rounded-lg bg-well">
          {domains.map((domain) => {
            const isRequired = required.includes(domain);
            const issue = issues.find((item) => item.domain === domain);
            return (
              <li key={domain} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                <span className="font-mono select-text">{domain}</span>
                {isRequired && (
                  <span className="flex items-center gap-1 rounded bg-muted px-1.5 text-[10px] text-muted-foreground">
                    <Lock className="size-2.5" />
                    Needed by reasoner CLI
                  </span>
                )}
                {!saved.includes(domain) && (
                  <span className="text-[10px] text-primary">Added</span>
                )}
                {issue && <span className="text-status-failed">{issue.message}</span>}
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="ml-auto size-6"
                  disabled={isRequired}
                  aria-label={`Remove ${domain}`}
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
            Add
          </Button>
          <div className="ml-auto flex items-center gap-1.5">
            {dirty && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => (setDraft(undefined), setIssues([]))}
              >
                <RotateCcw />
                Revert
              </Button>
            )}
            <Button size="sm" onClick={save} disabled={!dirty}>
              <Save />
              Save
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

/** Runs apply jobs and shows their output */
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
      title="Apply jobs"
      help="Runs the repository's pnpm scripts from the app. One job runs at a time, and secrets in the output are masked."
    >
      <div className="divide-y divide-canvas">
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
                    ? `Available after ${active} active ${active === 1 ? "request finishes" : "requests finish"}`
                    : undefined
                }
                onClick={() => run(kind)}
              >
                {running && job?.kind === kind ? (
                  <LoaderCircle className="animate-spin" />
                ) : null}
                Run
              </Button>
            </div>
          );
        })}
      </div>
      {error && (
        <p className="border-t border-canvas px-4 py-2 text-xs text-status-failed">
          {error}
        </p>
      )}
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
    <div className="border-t border-canvas px-4 py-3">
      <div className="mb-2 flex items-center gap-2 text-xs">
        {job.state === "running" ? (
          <LoaderCircle className="size-3.5 shrink-0 animate-spin text-status-running" />
        ) : job.state === "succeeded" ? (
          <CircleCheck className="size-3.5 shrink-0 text-status-succeeded" />
        ) : (
          <CircleX className="size-3.5 shrink-0 text-status-failed" />
        )}
        <span className="font-medium">{SANDBOX_JOBS[job.kind].label}</span>
        <span className="text-muted-foreground">
          {job.state === "running"
            ? "running"
            : job.state === "succeeded"
              ? "succeeded"
              : `failed (code ${job.exitCode ?? "?"})`}
          , {formatDuration(elapsed)}
        </span>
      </div>
      <pre
        ref={outputRef}
        className="select-text max-h-64 overflow-auto rounded-lg bg-well px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words"
      >
        {job.output.join("\n")}
      </pre>
    </div>
  );
}

export type { SandboxStatus };
