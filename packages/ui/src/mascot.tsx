import type { ReactNode } from "react";
import { cn } from "./lib/cn.ts";

export const moods = ["happy", "delighted", "searching", "flat", "surprised"] as const;

export type Mood = (typeof moods)[number];

const star =
  "50,16 61.17,38.63 86.14,42.26 68.07,59.87 72.34,84.74 50,73 27.66,84.74 31.93,59.87 13.86,42.26 38.83,38.63";

const ink = "var(--color-ink)";

const dotEyes = (cx: number, cy: number, r = 3.2) => (
  <>
    <circle cx={cx} cy={cy} r={r} fill={ink} />
    <circle cx={cx + 14} cy={cy} r={r} fill={ink} />
  </>
);

const smile = (x: number) => (
  <path d={`M${x} 56 Q${x + 4.5} 61 ${x + 9} 56`} stroke={ink} strokeWidth="2" strokeLinecap="round" />
);

const faces: Record<Mood, { eyes: ReactNode; mouth: ReactNode; prop?: ReactNode }> = {
  happy: { eyes: dotEyes(43, 49), mouth: smile(45.5) },
  delighted: {
    eyes: (
      <>
        <path d="M39.8 50 Q43 46.2 46.2 50" stroke={ink} strokeWidth="2.4" strokeLinecap="round" />
        <path d="M53.8 50 Q57 46.2 60.2 50" stroke={ink} strokeWidth="2.4" strokeLinecap="round" />
      </>
    ),
    mouth: smile(45.5),
  },
  searching: {
    eyes: dotEyes(45, 48.5),
    mouth: smile(47.5),
    prop: (
      <>
        <path d="M89.5 39.5 L95 33.5" stroke={ink} strokeWidth="3.6" strokeLinecap="round" />
        <circle cx="102" cy="25.5" r="10" fill="#e9e2ff" stroke={ink} strokeWidth="3" />
        <path d="M97.5 22.5 Q99.5 19.8 102.8 19.6" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
      </>
    ),
  },
  flat: {
    eyes: dotEyes(43, 51),
    mouth: <path d="M46.5 59 H53.5" stroke={ink} strokeWidth="2" strokeLinecap="round" />,
  },
  surprised: {
    eyes: dotEyes(43, 47.5, 3.6),
    mouth: <circle cx="50" cy="58" r="3" stroke={ink} strokeWidth="2" />,
  },
};

export type MascotMotion = "blink" | "bounce";

export function Mascot({
  mood = "happy",
  size = 120,
  motion,
  className,
}: {
  mood?: Mood;
  size?: number;
  motion?: MascotMotion | undefined;
  className?: string;
}) {
  const face = faces[mood];
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      fill="none"
      aria-hidden
      focusable={false}
      data-mood={mood}
      className={cn("shrink-0 overflow-visible", motion === "bounce" && "animate-bounce-once", className)}
    >
      <g data-part="body">
        <polygon
          points={star}
          fill="var(--color-highlight-edge)"
          stroke="var(--color-highlight-edge)"
          strokeWidth="12"
          strokeLinejoin="round"
        />
        <polygon
          points={star}
          fill="var(--color-highlight)"
          stroke="var(--color-highlight)"
          strokeWidth="10"
          strokeLinejoin="round"
        />
      </g>
      <g data-part="face">
        <g className={cn("origin-[50px_49px]", motion === "blink" && "animate-blink")}>{face.eyes}</g>
        {face.mouth}
        {face.prop}
      </g>
    </svg>
  );
}
