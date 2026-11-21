import type { MouseEvent } from "react";
import { RepoIcon, type RepoVisual } from "./repo-icon.tsx";
import { plainClick } from "./results.tsx";
import { Skeleton } from "./skeleton.tsx";

export type SimilarItem = {
  readonly owner: string;
  readonly name: string;
  // The repo's summary or description, cut to one line.
  readonly line: string;
  readonly href: string;
  readonly visual: RepoVisual;
};

export type SimilarRow<Key extends string = string> = {
  readonly key: Key;
  readonly heading: string;
  readonly repos: ReadonlyArray<SimilarItem> | "loading";
};

export type OpenSimilar<Key extends string = string> = (row: Key, item: SimilarItem, opener: HTMLAnchorElement) => void;

const heading = "font-display text-[20px] leading-6 font-semibold";
const placeholders = 3;

// Rows of repos near the one the panel shows. A row that loads holds placeholder lines, and an empty row is left out.
export function SimilarRepos<Key extends string>({
  rows,
  onOpen,
}: {
  rows: ReadonlyArray<SimilarRow<Key>>;
  onOpen: OpenSimilar<Key>;
}) {
  return rows
    .filter((row) => row.repos === "loading" || row.repos.length > 0)
    .map((row) => (
      <section key={row.key} aria-busy={row.repos === "loading"} className="flex flex-col gap-2">
        <h3 className={heading}>{row.heading}</h3>
        {row.repos === "loading" ? (
          <ul aria-hidden className="-mx-3 flex flex-col">
            {Array.from({ length: placeholders }, (_, index) => (
              <li key={index} className="flex items-center gap-3 px-3 py-2">
                <Skeleton className="size-9 shrink-0 squircle rounded-sm" />
                <span className="flex flex-1 flex-col gap-1.5">
                  <Skeleton className="h-3.5 w-28" />
                  <Skeleton className="h-3 w-4/5" />
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <ul className="-mx-3 flex flex-col">
            {row.repos.map((item) => (
              <li key={`${item.owner}/${item.name}`}>
                <a
                  href={item.href}
                  title={`${item.owner}/${item.name}`}
                  onClick={(event: MouseEvent<HTMLAnchorElement>) => {
                    if (!plainClick(event)) return;
                    event.preventDefault();
                    onOpen(row.key, item, event.currentTarget);
                  }}
                  className="flex items-center gap-3 squircle rounded-md px-3 py-2 transition-colors duration-120 hover:bg-background"
                >
                  <RepoIcon visual={item.visual} size="row" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-display text-[17px] leading-[22px] font-semibold tracking-snug">
                      {item.name}
                    </span>
                    {item.line !== "" && (
                      <span className="truncate font-sans text-sm text-muted-foreground">{item.line}</span>
                    )}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    ));
}
