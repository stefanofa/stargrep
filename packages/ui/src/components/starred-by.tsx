import type { MouseEvent } from "react";
import { Avatar } from "./avatar.tsx";
import { plainClick } from "./results.tsx";

export type Stargazer = {
  readonly login: string;
  readonly avatarUrl?: string;
  // The person's stars page.
  readonly href: string;
};

const heading = "font-display text-[20px] leading-6 font-semibold";

// Well-known people who star the repo the panel shows, each linking to their stars, and how many more there are. It
// renders nothing until someone is in it, so a repo no listed person stars has no row.
export function StarredBy({
  people,
  total,
  onOpen,
}: {
  people: ReadonlyArray<Stargazer>;
  total: number;
  onOpen: (person: Stargazer, position: number) => void;
}) {
  if (people.length === 0) return null;
  const more = total - people.length;
  return (
    <section className="flex flex-col gap-2 motion-safe:animate-settle">
      <h3 className={heading}>also starred by</h3>
      <ul className="-mx-1.5 flex flex-wrap gap-x-1 gap-y-0.5">
        {people.map((person, index) => (
          <li key={person.login}>
            <a
              href={person.href}
              onClick={(event: MouseEvent<HTMLAnchorElement>) => {
                if (!plainClick(event)) return;
                event.preventDefault();
                onOpen(person, index);
              }}
              className="flex h-10 items-center gap-2 rounded-full pr-3 pl-1.5 font-sans text-sm font-semibold transition-colors duration-120 hover:bg-background"
            >
              <span aria-hidden className="contents">
                <Avatar person={person} index={index} className="size-8 border-0" />
              </span>
              @{person.login}
            </a>
          </li>
        ))}
        {more > 0 && (
          <li className="flex h-10 items-center px-1.5 font-sans text-sm font-medium text-muted-foreground">
            +{more} more
          </li>
        )}
      </ul>
    </section>
  );
}
