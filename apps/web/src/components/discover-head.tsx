import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";
import { setCookie } from "../lib/cookies.ts";
import { type Segment, segmentCookie } from "../lib/discover.ts";

const segments: ReadonlyArray<Segment> = ["people", "topics"];
const year = 365 * 24 * 60 * 60;

// The open segment is current whatever its address filters, as the router would mark it.
const current = { exact: true, includeSearch: false } as const;

// A segment's page, with phones' tighter rhythm.
export const discoverBody = "flex flex-col gap-3 sm:gap-gap";

// The pill a segment's field sits in, beside the segments on desktop and under them on phones.
export const fieldBox =
  "flex h-[46px] items-center rounded-full bg-card px-[18px] font-sans text-base leading-5 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring sm:h-12 sm:w-95 sm:shrink-0 sm:pr-1.5 sm:pl-5 sm:text-[16px]";

// Discover's heading: its name, a link to each segment with the open one current, and the segment's own field. Opening a
// segment remembers it, so discover opens there next time.
export function DiscoverHead({ segment, children }: { segment: Segment; children: ReactNode }) {
  useEffect(() => setCookie(segmentCookie, segment, year), [segment]);
  return (
    <section className="flex flex-col gap-3 pt-1 sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:px-1 sm:pt-3">
      <div className="flex items-center justify-between gap-5">
        <h1 className="font-display text-2xl font-semibold tracking-[-0.02em] sm:text-4xl">
          discover<span className="sr-only">{` ${segment}`}</span>
        </h1>
        <nav aria-label="Discover">
          <ul className="flex items-center gap-0.5 rounded-full bg-card p-[3px] sm:p-1">
            {segments.map((each) => (
              <li key={each}>
                <Link
                  to={`/${each}`}
                  activeOptions={current}
                  aria-current={each === segment ? "page" : undefined}
                  className="flex rounded-full px-3.5 py-[7px] font-sans text-meta font-medium text-secondary-foreground transition-[color,background-color] duration-120 hover:text-foreground aria-[current=page]:bg-primary aria-[current=page]:font-semibold aria-[current=page]:text-primary-foreground sm:px-[18px] sm:py-2 sm:text-[15px]"
                >
                  {each}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
      {children}
    </section>
  );
}
