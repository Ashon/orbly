import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { slackToMarkdown } from "@/lib/slack";
import { cn } from "@/lib/utils";

export function Markdown({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "prose prose-sm max-w-none text-foreground dark:prose-invert",
        "prose-headings:font-semibold prose-headings:text-foreground prose-p:leading-relaxed",
        "prose-a:text-primary prose-a:no-underline hover:prose-a:underline",
        "prose-code:rounded prose-code:bg-well prose-code:px-1 prose-code:py-0.5 prose-code:font-normal prose-code:before:content-none prose-code:after:content-none",
        "prose-pre:bg-well prose-pre:text-foreground [&_pre_code]:bg-transparent [&_pre_code]:p-0",
        "prose-th:text-foreground prose-strong:text-foreground",
        className
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children: label }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {label}
            </a>
          ),
        }}
      >
        {slackToMarkdown(children)}
      </ReactMarkdown>
    </div>
  );
}
