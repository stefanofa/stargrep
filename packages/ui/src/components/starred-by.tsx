import type { MouseEvent } from "react";
import { cn } from "../lib/cn.ts";
import { Avatar } from "./avatar.tsx";
import { plainClick } from "./results.tsx";

export type Stargazer = {
  readonly login: string;
  readonly avatarUrl?: string;
  // The person's stars page.
  readonly href: string;
};

export interface Stargazers {
  readonly people: ReadonlyArray<Stargazer>;
  readonly total: number;
}

const heading = "font-display text-[20px] leading-6 font-semibold";
const label = "font-sans text-sm font-medium";
const more = "flex h-10 items-center px-1.5 font-sans text-sm font-medium text-muted-foreground";

// Well-known people who star the repo the panel shows, each linking to their stars, and how many more there are. The
// people the viewer follows come first as their own group, and a repo none of them star shows no such group. It renders
// nothing until someone is in it, so a repo nobody listed stars has no row.
export function StarredBy({
  people,
  total,
  followed,
  onOpen,
}: Stargazers & {
  followed?: Stargazers | undefined;
  onOpen: (person: Stargazer, position: number) => void;
}) {
  const mine = followed !== undefined && followed.people.length > 0 ? followed : undefined;
  const known = new Set(mine?.people.map((person) => person.login.toLowerCase()));
  const rest = people.filter((person) => !known.has(person.login.toLowerCase()));
  if (mine === undefined && rest.length === 0) return null;
  const faces = (group: Stargazers, shown: ReadonlyArray<Stargazer>, start: number, soft: boolean) => (
    <ul className="-mx-1.5 flex flex-wrap gap-x-1 gap-y-0.5">
      {shown.map((person, index) => (
        <li key={person.login}>
          <a
            href={person.href}
            onClick={(event: MouseEvent<HTMLAnchorElement>) => {
              if (!plainClick(event)) return;
              event.preventDefault();
              onOpen(person, start + index);
            }}
            className={cn(
              "flex h-10 items-center gap-2 rounded-full pr-3 pl-1.5 font-sans text-sm font-semibold transition-colors duration-120",
              soft ? "bg-accent-soft hover:bg-accent/30" : "hover:bg-background",
            )}
          >
            <span aria-hidden className="contents">
              <Avatar person={person} index={start + index} className="size-8 border-0" />
            </span>
            @{person.login}
          </a>
        </li>
      ))}
      {group.total > group.people.length && <li className={more}>+{group.total - group.people.length} more</li>}
    </ul>
  );
  return (
    <section className="flex flex-col gap-2 motion-safe:animate-settle">
      <h3 className={heading}>also starred by</h3>
      {mine !== undefined && (
        <>
          <p className={cn(label, "text-accent-strong")}>{`${mine.total} you follow`}</p>
          {faces(mine, mine.people, 0, true)}
          {rest.length > 0 && <p className={cn(label, "pt-1 text-muted-foreground")}>and people on stargrep</p>}
        </>
      )}
      {rest.length > 0 && faces({ people, total }, rest, mine?.people.length ?? 0, false)}
    </section>
  );
}
