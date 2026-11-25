import { type KeyboardEvent, type ReactNode, useRef, useState } from "react";
import { cn } from "../lib/cn.ts";

// The marks of one chart, such as its bars or its day squares, as one tab stop. Arrow keys move between them, Home and
// End jump to the ends, and the mark under the pointer or the focus is the active one, which the chart's tooltip
// describes. Marks flow down columns of `rows` marks, so a bar chart has one row and a week grid seven: up and down stay
// in a column, left and right move a column. A mark that isn't drawn, such as a day still to come, is skipped over.
export function useMarks(count: number, { rows = 1, start = count - 1 }: { rows?: number; start?: number } = {}) {
  const [hovered, setHovered] = useState<number>();
  const [focused, setFocused] = useState<number>();
  const [stop, setStop] = useState(start);
  const marks = useRef<Array<HTMLElement | null>>([]);

  const target = (from: number, key: string) => {
    const column = Math.floor(from / rows);
    switch (key) {
      case "ArrowUp":
        return rows > 1 && Math.floor((from - 1) / rows) === column ? from - 1 : undefined;
      case "ArrowDown":
        return rows > 1 && Math.floor((from + 1) / rows) === column ? from + 1 : undefined;
      case "ArrowLeft":
        return from - rows;
      case "ArrowRight":
        return from + rows;
      case "Home":
        return marks.current.findIndex((mark) => mark != null);
      case "End":
        return marks.current.findLastIndex((mark) => mark != null);
      default:
        return undefined;
    }
  };

  const mark = (index: number) => ({
    ref: (element: HTMLElement | null) => {
      marks.current[index] = element;
    },
    tabIndex: index === stop ? 0 : -1,
    onFocus: () => {
      setFocused(index);
      setStop(index);
    },
    onBlur: () => setFocused((current) => (current === index ? undefined : current)),
    onPointerEnter: () => setHovered(index),
    onPointerLeave: () => setHovered((current) => (current === index ? undefined : current)),
    onKeyDown: (event: KeyboardEvent) => {
      const to = target(index, event.key);
      if (to === undefined) return;
      event.preventDefault();
      marks.current[to]?.focus();
    },
  });

  return { active: hovered ?? focused, mark };
}

// The readout of the active mark, beside it along the top of the plot. `from` and `to` are the mark's left and right
// edges as fractions of the plot's width. It sits right of a mark in the left part of the plot and left of the others,
// so it never leaves the plot. The mark's accessible name says the same, so the tooltip is hidden from screen readers.
export function ChartTip({
  from,
  to,
  className,
  children,
}: {
  from: number;
  to: number;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute z-10 flex items-center gap-2 rounded-[12px] bg-foreground px-3 py-1.75 font-sans text-sm whitespace-nowrap text-background",
        className,
      )}
      style={to <= 0.6 ? { left: `calc(${to * 100}% + 8px)` } : { right: `calc(${(1 - from) * 100}% + 8px)` }}
    >
      {children}
    </div>
  );
}

// Labels along a chart's axis, each at a fraction of its width. A label centers on its place, or starts there when
// `anchor` is start, and one near either end lines up with that end, so none leaves the chart.
export function AxisTicks({
  ticks,
  anchor = "center",
  className,
}: {
  ticks: ReadonlyArray<{ readonly at: number; readonly label: string }>;
  anchor?: "start" | "center";
  className?: string;
}) {
  const place = (at: number) => {
    if (at >= 0.94) return { right: 0 };
    if (anchor === "start") return { left: `${at * 100}%` };
    if (at <= 0.06) return { left: 0 };
    return { left: `${at * 100}%`, translate: "-50%" };
  };
  return (
    <div aria-hidden className={cn("relative h-4 font-sans text-sm text-muted-foreground", className)}>
      {ticks.map((tick) => (
        <span key={`${tick.at} ${tick.label}`} className="absolute top-0 whitespace-nowrap" style={place(tick.at)}>
          {tick.label}
        </span>
      ))}
    </div>
  );
}

// The part of a tooltip that says where the mark leads, in accent-strong of the opposite theme, since the tooltip
// inverts the page's colors.
export function TipAction({ children }: { children: ReactNode }) {
  return <span className="text-[light-dark(#c8b6ff,#5b3fcc)]">{children}</span>;
}
