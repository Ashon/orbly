import { cn } from "@/lib/utils";

export function VerdaMark({ className }: { className?: string }) {
  return (
    <img
      src="/verda.svg"
      alt=""
      className={cn("size-6 select-none", className)}
      draggable={false}
    />
  );
}
