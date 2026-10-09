import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { slackToMarkdown } from "@/lib/slack";
import { cn } from "@/lib/utils";

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
}

/** Shows single line breaks inside paragraphs as line breaks. (matches Slack, same as remark-breaks) */
function remarkLineBreaks() {
  const walk = (node: MdNode) => {
    if (!node.children) return;
    node.children = node.children.flatMap((child) => {
      if (child.type !== "text" || !child.value?.includes("\n")) {
        walk(child);
        return [child];
      }
      return child.value
        .split("\n")
        .flatMap((part, i) => [
          ...(i > 0 ? [{ type: "break" }] : []),
          ...(part ? [{ type: "text", value: part }] : []),
        ]);
    });
  };
  return (tree: MdNode) => walk(tree);
}

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
        // Code background is --code-bg (default well). Inside mint replies it switches to the card surface so gray and green do not mix.
        "prose-code:rounded prose-code:bg-[var(--code-bg,var(--well))] prose-code:px-1 prose-code:py-0.5 prose-code:font-normal prose-code:before:content-none prose-code:after:content-none",
        "prose-pre:bg-[var(--code-bg,var(--well))] prose-pre:text-foreground [&_pre_code]:bg-transparent [&_pre_code]:p-0",
        "prose-th:text-foreground prose-strong:text-foreground",
        className
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkLineBreaks]}
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
