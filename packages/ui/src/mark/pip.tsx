import type { CSSProperties } from "react";
import { cn } from "../lib/cn.ts";
import { pip } from "./pip.gen.ts";

export type PipPose = keyof typeof pip.poses;

export const pipPoses = Object.keys(pip.poses) as ReadonlyArray<PipPose>;

const star =
  "50,16 61.17,38.63 86.14,42.26 68.07,59.87 72.34,84.74 50,73 27.66,84.74 31.93,59.87 13.86,42.26 38.83,38.63";

// Blobatar lays the eyes out for a round body, so they move onto the star's face, and grow back to full size where a
// small mark would lose them.
const face = (size: number) =>
  size <= 48 ? "translate(50 53) scale(1) translate(-50 -51)" : "translate(50 52) scale(0.82) translate(-50 -51)";

const vars = (values: Record<string, string | number>) => values as CSSProperties;

export function Pip({ pose = "idle", size = 40, className }: { pose?: PipPose; size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      fill="none"
      aria-hidden
      focusable={false}
      data-pose={pose}
      className={cn("shrink-0 overflow-visible", className)}
    >
      <g
        className={cn("mo-root mo-always", pose !== "idle" && "mo-expr", pose === "sad" && "mo-slow")}
        style={vars({
          ...pip.motion,
          ...pip.poses[pose],
          "--mo-head": "var(--color-highlight)",
          "--mo-eye": "var(--color-ink)",
        })}
      >
        <g className="mo-breathe">
          <g className="mo-bob">
            <g>
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
            <g transform={face(size)}>
              <g className="mo-eyes">
                {pip.eyes.map((eye) => (
                  <g
                    key={eye.wrap}
                    className="mo-eye"
                    style={vars({
                      "--mo-wrap": eye.wrap,
                      "--mo-lean": eye.lean,
                      transformOrigin: `${eye.cx}px ${eye.cy}px`,
                    })}
                  >
                    <path d={eye.d} />
                  </g>
                ))}
              </g>
            </g>
          </g>
        </g>
      </g>
    </svg>
  );
}
