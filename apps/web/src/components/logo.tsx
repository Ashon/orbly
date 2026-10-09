import { cn } from "@/lib/utils";

export function OrblyMark({ className }: { className?: string }) {
  return (
    <img
      src="/orbly.svg"
      alt=""
      className={cn("size-6 select-none", className)}
      draggable={false}
    />
  );
}
