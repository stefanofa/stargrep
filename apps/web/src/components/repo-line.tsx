import { type OpenResult, RepoIcon, type Result } from "@stargrep/ui";
import type { MouseEvent } from "react";

const plainClick = (event: MouseEvent) =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

// One repo in a tile's short list: its icon, its name, and one line under it. A plain click opens the repo panel, and
// any other click is the browser's.
export function RepoLine({ result, line, onOpen }: { result: Result; line: string; onOpen: OpenResult }) {
  return (
    <a
      href={result.href}
      onClick={(event) => {
        if (!plainClick(event)) return;
        event.preventDefault();
        onOpen(result, event.currentTarget);
      }}
      className="flex min-w-0 items-center gap-3 rounded-sm"
    >
      <RepoIcon visual={result.visual} />
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-display text-lg leading-6 font-semibold tracking-snug">{result.name}</span>
        <span className="truncate font-sans text-meta font-medium text-muted-foreground">{line}</span>
      </span>
    </a>
  );
}
