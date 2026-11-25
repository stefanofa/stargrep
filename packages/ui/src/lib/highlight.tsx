import type { ReactNode } from "react";

// Where a search term matched in a text, as the start and end of the matched characters.
export type Match = readonly [start: number, end: number];

export function highlight(text: string, matches: ReadonlyArray<Match>): ReactNode[] {
  const ranges = matches
    .map(([start, end]) => [Math.max(0, start), Math.min(text.length, end)] as const)
    .filter(([start, end]) => start < end)
    .toSorted((a, b) => a[0] - b[0]);
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (end <= cursor) continue;
    const from = Math.max(start, cursor);
    if (from > cursor) parts.push(text.slice(cursor, from));
    parts.push(<mark key={from}>{text.slice(from, end)}</mark>);
    cursor = end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}
