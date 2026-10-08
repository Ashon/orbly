import type { RunEvent, RunRecord } from "@history/types";
import {
  Brain,
  ChevronRight,
  CircleCheck,
  CircleX,
  Info,
  SquareTerminal,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import { useState } from "react";
import type * as React from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { artifactUrl } from "@/lib/api";
import {
  formatClock,
  formatDateTime,
  formatDuration,
  previewArgs,
  stepDuration,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import { CodeBlock } from "./code-block";
import { VerdaMark } from "./logo";
import { Markdown } from "./markdown";

/** 요청 -> 진행 단계 -> 답변 -> 산출물 순으로 보여 준다. */
export function Timeline({ run }: { run: RunRecord }) {
  const answer = run.answer?.trim();
  // 마지막 메시지는 최종 답변과 같으므로 단계에서는 뺀다.
  const lastMessageIndex = run.events.findLastIndex((e) => e.kind === "message");
  const steps = run.events.filter(
    (event, i) =>
      event.kind !== "usage" &&
      !(
        answer &&
        event.kind === "message" &&
        i === lastMessageIndex &&
        event.text.trim() === answer
      )
  );

  return (
    <div className="space-y-5">
      <Bubble
        avatar={
          <span className="grid size-7 place-items-center rounded-full bg-secondary text-xs font-semibold text-secondary-foreground">
            {(run.slack.userName ?? "?").slice(0, 1).toUpperCase()}
          </span>
        }
        title={`@${run.slack.userName ?? run.slack.userId}`}
        meta={`${run.slack.channelLabel} / ${formatDateTime(run.startedAt)}`}
      >
        <p className="text-sm leading-relaxed whitespace-pre-wrap">
          {run.request || (
            <span className="text-muted-foreground">(빈 요청: 대화 맥락으로 답함)</span>
          )}
        </p>
        {run.context.messages > 0 && (
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            스레드 맥락 {run.context.messages}건
            {run.attachments.length > 0 ? `, 첨부 ${run.attachments.length}개` : ""}
          </p>
        )}
      </Bubble>

      {steps.length > 0 && (
        <div className="ml-3.5 space-y-1 border-l border-dashed pl-6">
          {steps.map((event, i) => (
            <Step key={"id" in event ? event.id : `${event.kind}-${i}`} event={event} />
          ))}
        </div>
      )}

      {run.status === "running" && (
        <div className="ml-3.5 flex items-center gap-2 border-l border-dashed pb-1 pl-6 text-xs text-status-running">
          <span className="flex gap-1">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="size-1.5 animate-pulse-dot rounded-full bg-status-running"
                style={{ animationDelay: `${i * 0.18}s` }}
              />
            ))}
          </span>
          작업 중
        </div>
      )}

      {answer && (
        <Bubble
          avatar={<VerdaMark className="size-7" />}
          title="Verda"
          meta={run.finishedAt ? formatDateTime(run.finishedAt) : undefined}
          accent
        >
          <Markdown>{answer}</Markdown>
        </Bubble>
      )}

      {run.outputs.length > 0 && (
        <div className="ml-10 grid grid-cols-2 gap-3">
          {run.outputs.map((output) => (
            <figure key={output.file} className="overflow-hidden rounded-xl bg-card">
              <a href={artifactUrl(run.id, output.file)} target="_blank" rel="noreferrer">
                <img
                  src={artifactUrl(run.id, output.file)}
                  alt={output.title}
                  className="max-h-80 w-full bg-white object-contain"
                />
              </a>
              <figcaption className="border-t border-canvas px-3 py-1.5 text-xs text-muted-foreground">
                {output.title}
                {output.kind === "diagram" ? " (그림 블록)" : " (생성 이미지)"}
              </figcaption>
              {output.source && (
                <Disclosure label="원문" className="border-t border-canvas">
                  <CodeBlock
                    code={output.source}
                    className="m-2 mt-0"
                    maxHeight="max-h-60"
                  />
                </Disclosure>
              )}
            </figure>
          ))}
        </div>
      )}

      {run.error && run.status !== "succeeded" && (
        <div className="flex gap-2 rounded-xl bg-status-failed/10 px-4 py-3 text-sm">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-status-failed" />
          <div className="min-w-0">
            <p className="font-medium text-status-failed">
              {run.status === "interrupted" ? "중단됨" : "실패"}
            </p>
            <p className="mt-0.5 font-mono text-xs break-words whitespace-pre-wrap text-muted-foreground">
              {run.error}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function Bubble({
  avatar,
  title,
  meta,
  accent,
  children,
}: {
  avatar: React.ReactNode;
  title: string;
  meta?: string;
  accent?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <div className="shrink-0 pt-0.5">{avatar}</div>
      <div
        className={cn(
          "min-w-0 flex-1 rounded-xl px-4 py-3",
          // 봇 답변은 민트 면, 요청은 카드 면으로 구분한다.
          accent ? "bg-card-accent" : "bg-card"
        )}
      >
        <div className="mb-1.5 flex items-baseline gap-2">
          <span className="text-sm font-semibold">{title}</span>
          {meta && <span className="text-[11px] text-muted-foreground">{meta}</span>}
        </div>
        {children}
      </div>
    </div>
  );
}

function Disclosure({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className={className}>
      <CollapsibleTrigger className="flex w-full items-center gap-1 px-3 py-1.5 text-left text-[11px] text-muted-foreground hover:text-foreground">
        <ChevronRight
          className={cn("size-3 transition-transform", open && "rotate-90")}
        />
        {label}
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

function Step({ event }: { event: RunEvent }) {
  switch (event.kind) {
    case "tool":
    case "command":
      return <ToolStep event={event} />;
    case "message":
      return (
        <div className="py-1 text-[13px] leading-relaxed text-muted-foreground">
          <Markdown className="prose-p:my-0 text-muted-foreground">{event.text}</Markdown>
        </div>
      );
    case "reasoning":
      return (
        <ExpandableRow
          icon={<Brain className="size-3.5 text-muted-foreground" />}
          label="생각"
          preview={event.text}
        >
          <p className="px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
            {event.text}
          </p>
        </ExpandableRow>
      );
    case "note":
      return (
        <div className="flex items-center gap-1.5 py-1 text-[11px] text-status-interrupted">
          <Info className="size-3.5 shrink-0" />
          {event.text}
          <span className="text-muted-foreground">{formatClock(event.at)}</span>
        </div>
      );
    case "error":
      return (
        <div className="flex items-start gap-1.5 py-1 text-xs text-status-failed">
          <TriangleAlert className="mt-px size-3.5 shrink-0" />
          <span className="break-words">{event.message}</span>
        </div>
      );
    default:
      return null;
  }
}

function ToolStep({ event }: { event: Extract<RunEvent, { kind: "tool" | "command" }> }) {
  const isTool = event.kind === "tool";
  const name = isTool ? `${event.server}.${event.tool}` : "shell";
  const preview = isTool ? previewArgs(event.arguments) : event.command;
  const output = isTool ? (event.error ?? event.result) : event.output;
  const failed =
    event.status === "failed" ||
    (!isTool &&
      event.exitCode !== undefined &&
      event.exitCode !== null &&
      event.exitCode !== 0);
  const icon =
    event.status === "running" ? (
      <span className="grid size-3.5 place-items-center">
        <span className="size-2 animate-pulse-dot rounded-full bg-status-running" />
      </span>
    ) : failed ? (
      <CircleX className="size-3.5 text-status-failed" />
    ) : (
      <CircleCheck className="size-3.5 text-status-succeeded" />
    );

  return (
    <ExpandableRow
      icon={icon}
      label={
        <span className="flex items-center gap-1">
          {isTool ? (
            <Wrench className="size-3 text-muted-foreground" />
          ) : (
            <SquareTerminal className="size-3 text-muted-foreground" />
          )}
          <span className="font-mono">{name}</span>
        </span>
      }
      preview={preview}
      trailing={formatDuration(stepDuration(event.at, event.finishedAt))}
    >
      <div className="space-y-2 p-2">
        {isTool && event.arguments !== undefined && (
          <CodeBlock
            label="인자"
            code={JSON.stringify(event.arguments, null, 2)}
            maxHeight="max-h-52"
          />
        )}
        {!isTool && <CodeBlock label="명령" code={event.command} maxHeight="max-h-40" />}
        {output ? (
          <CodeBlock
            label={
              failed
                ? "오류"
                : isTool
                  ? "결과"
                  : `출력${event.kind === "command" && event.exitCode != null ? ` (종료 코드 ${event.exitCode})` : ""}`
            }
            code={output}
          />
        ) : (
          event.status === "running" && (
            <p className="px-1 text-xs text-muted-foreground">실행 중...</p>
          )
        )}
      </div>
    </ExpandableRow>
  );
}

function ExpandableRow({
  icon,
  label,
  preview,
  trailing,
  children,
}: {
  icon: React.ReactNode;
  label: React.ReactNode;
  preview?: string;
  trailing?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn("rounded-lg", open && "bg-card")}
    >
      <CollapsibleTrigger className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent/60">
        {/* 미리보기가 길어도 아이콘은 줄어들지 않는다. 줄어드는 것은 미리보기 글자뿐이다. */}
        <span className="flex shrink-0">{icon}</span>
        <span className="shrink-0 font-medium">{label}</span>
        {preview && (
          <span className="min-w-0 truncate text-muted-foreground">{preview}</span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground tabular-nums">
          {trailing && trailing !== "-" && trailing}
          <ChevronRight
            className={cn("size-3.5 transition-transform", open && "rotate-90")}
          />
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
