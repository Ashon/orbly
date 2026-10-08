import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className={className}
      aria-label="복사"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1_200);
        });
      }}
    >
      {copied ? <Check className="text-primary" /> : <Copy />}
    </Button>
  );
}

export function CodeBlock({
  code,
  label,
  className,
  maxHeight = "max-h-80",
}: {
  code: string;
  label?: string;
  className?: string;
  maxHeight?: string;
}) {
  return (
    <div className={cn("group relative overflow-hidden rounded-lg bg-well", className)}>
      {label && (
        <div className="flex h-7 items-center border-b border-card px-3 text-[11px] font-medium text-muted-foreground">
          {label}
        </div>
      )}
      <CopyButton
        text={code}
        className="absolute top-0.5 right-0.5 opacity-0 transition-opacity group-hover:opacity-100"
      />
      <pre
        className={cn(
          "overflow-auto px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words",
          maxHeight
        )}
      >
        {code}
      </pre>
    </div>
  );
}
