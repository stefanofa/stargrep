import type { CSSProperties } from "react";
import { cn } from "../lib/cn.ts";
import { pip } from "./pip.gen.ts";
import { smallMark, starPoints, starStroke } from "./star.ts";

export type PipPose = keyof typeof pip.poses;

export const pipPoses = Object.keys(pip.poses) as ReadonlyArray<PipPose>;

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
                points={starPoints}
                fill="var(--color-highlight-edge)"
                stroke="var(--color-highlight-edge)"
                strokeWidth={starStroke.edge}
                strokeLinejoin="round"
              />
              <polygon
                points={starPoints}
                fill="var(--color-highlight)"
                stroke="var(--color-highlight)"
                strokeWidth={starStroke.fill}
                strokeLinejoin="round"
              />
            </g>
            <g className="mo-eyes">
              {(size <= smallMark ? pip.eyes.small : pip.eyes.large).map((eye) => (
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
    </svg>
  );
}
