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
import { OrblyMark } from "./logo";
import { Markdown } from "./markdown";

/** Shows the request -> steps -> reply -> outputs in order. */
export function Timeline({ run }: { run: RunRecord }) {
  const answer = run.answer?.trim();
  // The last message is the same as the final reply, so it is left out of the steps.
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
            {(run.origin.userName ?? "?").slice(0, 1).toUpperCase()}
          </span>
        }
        title={`@${run.origin.userName ?? run.origin.userId}`}
        meta={`${run.origin.conversationLabel} / ${formatDateTime(run.startedAt)}`}
      >
        <p className="text-sm leading-relaxed whitespace-pre-wrap">
          {run.request || (
            <span className="text-muted-foreground">
              (empty request: answered from the conversation context)
            </span>
          )}
        </p>
        {run.context.messages > 0 && (
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            {run.context.messages} thread{" "}
            {run.context.messages === 1 ? "message" : "messages"}
            {run.attachments.length > 0
              ? `, ${run.attachments.length} ${run.attachments.length === 1 ? "attachment" : "attachments"}`
              : ""}
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
          Working
        </div>
      )}

      {answer && (
        <Bubble
          avatar={<OrblyMark className="size-7" />}
          title="Orbly"
          meta={run.finishedAt ? formatDateTime(run.finishedAt) : undefined}
          accent
        >
          <Markdown>{answer}</Markdown>
        </Bubble>
      )}

      {run.outputs.length > 0 && (
        <div className="ml-10 grid grid-cols-2 gap-3">
          {run.outputs.map((output) => (
            <figure key={output.file} className="surface-card overflow-hidden">
              <a href={artifactUrl(run.id, output.file)} target="_blank" rel="noreferrer">
                <img
                  src={artifactUrl(run.id, output.file)}
                  alt={output.title}
                  className="max-h-80 w-full bg-white object-contain"
                />
              </a>
              <figcaption className="border-t border-canvas px-3 py-1.5 text-xs text-muted-foreground">
                {output.title}
                {output.kind === "diagram" ? " (diagram block)" : " (generated image)"}
              </figcaption>
              {output.source && (
                <Disclosure label="Source" className="border-t border-canvas">
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
              {run.status === "interrupted" ? "Interrupted" : "Failed"}
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
      <div className="shrink-0 pt-1">{avatar}</div>
      <div
        className={cn(
          "min-w-0 flex-1 px-5 py-4",
          // Bot replies use the mint surface and requests the card surface. (same look as the Overview cards)
          accent ? "surface-card-accent [--code-bg:var(--card)]" : "surface-card"
        )}
      >
        <div className="mb-2 flex items-baseline gap-2">
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
          label="Thinking"
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
        // The server (ops, codex_apps, etc.) is a small tag; only the tool name is shown large.
        <span className="flex items-center gap-1.5">
          <span className="flex items-center gap-1 rounded-md bg-well px-1.5 py-px text-[10px] font-medium text-muted-foreground [&_svg]:size-3">
            {isTool ? <Wrench /> : <SquareTerminal />}
            {isTool ? event.server : "shell"}
          </span>
          {isTool && <span className="font-mono">{event.tool}</span>}
        </span>
      }
      preview={preview}
      trailing={formatDuration(stepDuration(event.at, event.finishedAt))}
    >
      <div className="space-y-2 p-2">
        {isTool && event.arguments !== undefined && (
          <CodeBlock
            label="Arguments"
            code={JSON.stringify(event.arguments, null, 2)}
            maxHeight="max-h-52"
          />
        )}
        {!isTool && (
          <CodeBlock label="Command" code={event.command} maxHeight="max-h-40" />
        )}
        {output ? (
          <CodeBlock
            label={
              failed
                ? "Error"
                : isTool
                  ? "Result"
                  : `Output${event.kind === "command" && event.exitCode != null ? ` (exit code ${event.exitCode})` : ""}`
            }
            code={output}
          />
        ) : (
          event.status === "running" && (
            <p className="px-1 text-xs text-muted-foreground">Running...</p>
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
        {/* A long preview never shrinks the icon. Only the preview text shrinks. */}
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
