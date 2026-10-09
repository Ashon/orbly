import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * A width that the viewer sets by dragging and that this browser remembers. Storage can be
 * unavailable (private windows, blocked site data), so reads and writes fall back quietly.
 */
export function useStoredWidth(
  key: string,
  fallback: number
): [number, (width: number) => void] {
  const [width, setWidth] = useState(() => {
    try {
      const stored = Number(window.localStorage.getItem(key));
      return Number.isFinite(stored) && stored > 0 ? stored : fallback;
    } catch {
      return fallback;
    }
  });
  const save = (next: number) => {
    setWidth(next);
    try {
      window.localStorage.setItem(key, String(Math.round(next)));
    } catch {
      // Not remembered this time.
    }
  };
  return [width, save];
}

/** The window's inner width, kept current across resizes. */
export function useWindowWidth(): number {
  const [width, setWidth] = useState(window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}

const STEP = 16;

/**
 * Vertical splitter on the right edge of a column: drag to resize, arrow keys to nudge, double-click
 * to restore the default width. It overlays the column's border, so it takes no layout space.
 */
export function ResizeHandle({
  value,
  min,
  max,
  onChange,
  onReset,
  label,
  className,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (width: number) => void;
  onReset: () => void;
  label: string;
  className?: string;
}) {
  const drag = useRef<{ startX: number; startWidth: number } | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  const clamp = (width: number) => Math.min(max, Math.max(min, width));

  useEffect(() => {
    if (!dragging) return;
    // While dragging, the whole window shows the resize cursor and text is not selected.
    const { cursor, userSelect } = document.body.style;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = cursor;
      document.body.style.userSelect = userSelect;
    };
  }, [dragging]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { startX: e.clientX, startWidth: value };
        setDragging(true);
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        onChange(clamp(drag.current.startWidth + e.clientX - drag.current.startX));
      }}
      onPointerUp={(e) => {
        e.currentTarget.releasePointerCapture(e.pointerId);
        drag.current = undefined;
        setDragging(false);
      }}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") onChange(clamp(value - STEP));
        else if (e.key === "ArrowRight") onChange(clamp(value + STEP));
        else return;
        e.preventDefault();
      }}
      className={cn(
        "group absolute inset-y-0 -right-[3px] z-10 w-1.5 cursor-col-resize outline-none",
        className
      )}
    >
      {/* The line lights up on hover, while dragging, and on keyboard focus. */}
      <span
        className={cn(
          "absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-ring/70 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100",
          dragging && "opacity-100"
        )}
      />
    </div>
  );
}
