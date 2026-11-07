import { cn } from "../lib/cn.ts";

// A ring around Pip. On the butter tile it circles the plate, on a white tile it replaces the soft disc.
const rings = {
  butter: { box: 150, radius: 68, stroke: 8, track: "var(--color-plate)" },
  card: { box: 168, radius: 78, stroke: 7, track: "var(--color-accent-soft)" },
} as const;

export function ProgressRing({
  progress,
  on,
  className,
}: {
  progress: number;
  on: keyof typeof rings;
  className?: string;
}) {
  const { box, radius, stroke, track } = rings[on];
  const center = box / 2;
  const circumference = 2 * Math.PI * radius;
  const length = Math.min(1, Math.max(0, progress)) * circumference;
  return (
    <svg aria-hidden viewBox={`0 0 ${box} ${box}`} fill="none" className={cn("absolute inset-0 size-full", className)}>
      <circle cx={center} cy={center} r={radius} stroke={track} strokeWidth={stroke} />
      {length > 0 && (
        <circle
          cx={center}
          cy={center}
          r={radius}
          transform={`rotate(-90 ${center} ${center})`}
          stroke="var(--color-accent)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${length} ${circumference}`}
          className="transition-[stroke-dasharray] duration-500 ease-out motion-reduce:transition-none"
        />
      )}
    </svg>
  );
}
