import type { RunRecord } from "@history/types";
import {
  AtSign,
  Coins,
  Cpu,
  ExternalLink,
  FileText,
  Hash,
  ImageIcon,
  Paperclip,
  Timer,
  Wrench,
} from "lucide-react";
import type * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { artifactUrl, useRun } from "@/lib/api";
import { formatDateTime, formatDuration, formatNumber } from "@/lib/format";
import { CodeBlock } from "./code-block";
import { StatusBadge } from "./status";
import { Timeline } from "./timeline";

export function RunDetail({ id }: { id: string }) {
  const { data: run, isError } = useRun(id);
  if (isError) {
    return (
      <p className="p-10 text-center text-sm text-muted-foreground">
        기록을 찾지 못했습니다.
      </p>
    );
  }
  if (!run) return null;
  return (
    <Tabs defaultValue="timeline" className="flex h-full min-h-0 flex-col">
      <RunHeader run={run} />
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto max-w-3xl px-8 py-6">
          <TabsContent value="timeline">
            <Timeline run={run} />
          </TabsContent>
          <TabsContent value="attachments">
            <Attachments run={run} />
          </TabsContent>
          <TabsContent value="prompt" className="space-y-3">
            {run.prompt ? (
              <>
                <CodeBlock
                  label="지시문 (system)"
                  code={run.prompt.system}
                  maxHeight="max-h-96"
                />
                <CodeBlock
                  label="입력 (스레드 맥락, 요청, 첨부)"
                  code={run.prompt.user}
                  maxHeight="max-h-[60vh]"
                />
              </>
            ) : (
              <Empty>프롬프트를 만들기 전에 끝난 실행입니다.</Empty>
            )}
          </TabsContent>
          <TabsContent value="raw">
            <CodeBlock code={JSON.stringify(run, null, 2)} maxHeight="max-h-[70vh]" />
          </TabsContent>
        </div>
      </ScrollArea>
    </Tabs>
  );
}

function RunHeader({ run }: { run: RunRecord }) {
  const usage = run.events.reduce(
    (sum, e) =>
      e.kind === "usage"
        ? {
            input: sum.input + (e.inputTokens ?? 0),
            output: sum.output + (e.outputTokens ?? 0),
            cost: sum.cost + (e.costUsd ?? 0),
          }
        : sum,
    { input: 0, output: 0, cost: 0 }
  );
  const tools = run.events.filter(
    (e) => e.kind === "tool" || e.kind === "command"
  ).length;
  const duration = run.durationMs ?? Date.now() - Date.parse(run.startedAt);

  return (
    <header className="border-b bg-canvas/80 px-8 pt-5 pb-0 backdrop-blur">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center gap-2">
          <StatusBadge status={run.status} />
          {run.attempts > 1 && <Badge variant="secondary">시도 {run.attempts}회</Badge>}
          <span className="font-mono text-[11px] text-muted-foreground">{run.id}</span>
          {run.slack.permalink && (
            <Button asChild variant="outline" size="xs" className="ml-auto">
              <a href={run.slack.permalink} target="_blank" rel="noreferrer">
                <ExternalLink />
                Slack 에서 보기
              </a>
            </Button>
          )}
        </div>
        <h1 className="mt-3 line-clamp-3 text-lg leading-snug font-semibold tracking-tight">
          {run.request || "(빈 요청)"}
        </h1>
        <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <Meta icon={<Hash />}>{run.slack.channelLabel.replace(/^#/, "")}</Meta>
          <Meta icon={<AtSign />}>{run.slack.userName ?? run.slack.userId}</Meta>
          <Meta icon={<Cpu />}>
            {run.backend.reasoner}@{run.backend.sandbox}
            {run.backend.model ? ` (${run.backend.model})` : ""}
          </Meta>
          <Meta icon={<Timer />}>
            {formatDuration(duration)}
            {run.status === "running" ? " 경과" : ""}
          </Meta>
          {tools > 0 && <Meta icon={<Wrench />}>도구 {tools}회</Meta>}
          {usage.input + usage.output > 0 && (
            <Meta icon={<Coins />}>
              입력 {formatNumber(usage.input)} / 출력 {formatNumber(usage.output)} 토큰
              {usage.cost > 0 ? ` ($${usage.cost.toFixed(3)})` : ""}
            </Meta>
          )}
          <span>{formatDateTime(run.startedAt)}</span>
        </div>
        <TabsList className="mt-4 mb-3">
          <TabsTrigger value="timeline">작업 과정</TabsTrigger>
          <TabsTrigger value="attachments">
            첨부
            {run.attachments.length > 0 && (
              <span className="rounded bg-muted px-1 text-[10px] tabular-nums">
                {run.attachments.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="prompt">프롬프트</TabsTrigger>
          <TabsTrigger value="raw">JSON</TabsTrigger>
        </TabsList>
      </div>
    </header>
  );
}

function Meta({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-1 [&_svg]:size-3.5">
      {icon}
      {children}
    </span>
  );
}

const ATTACHMENT_STATUS = {
  read: { label: "읽음", className: "text-status-succeeded" },
  skipped: { label: "건너뜀", className: "text-status-interrupted" },
  failed: { label: "실패", className: "text-status-failed" },
} as const;

function Attachments({ run }: { run: RunRecord }) {
  if (run.attachments.length === 0) return <Empty>첨부가 없는 요청입니다.</Empty>;
  return (
    <ul className="space-y-2">
      {run.attachments.map((item, i) => {
        const status = ATTACHMENT_STATUS[item.status];
        const Icon =
          item.kind === "image"
            ? ImageIcon
            : item.kind === "other"
              ? Paperclip
              : FileText;
        return (
          <li key={`${item.name}-${i}`} className="flex gap-3 rounded-xl bg-card p-3">
            {item.file ? (
              <img
                src={artifactUrl(run.id, item.file)}
                alt={item.name}
                className="size-20 shrink-0 rounded-lg bg-white object-cover"
              />
            ) : (
              <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-well">
                <Icon className="size-4 text-muted-foreground" />
              </span>
            )}
            <div className="min-w-0 flex-1 text-sm">
              <div className="flex items-center gap-2">
                <span className="truncate font-medium">{item.name}</span>
                <span className={`text-xs ${status.className}`}>{status.label}</span>
              </div>
              {item.source && (
                <p className="text-xs text-muted-foreground">{item.source}</p>
              )}
              {item.reason && (
                <p className="mt-0.5 text-xs text-muted-foreground">{item.reason}</p>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-16 text-center text-sm text-muted-foreground">{children}</p>;
}
