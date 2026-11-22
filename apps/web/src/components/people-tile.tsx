import { buttonVariants, cn, Tile } from "@stargrep/ui";
import { Link } from "@tanstack/react-router";
import { avatarOf } from "../lib/avatar.ts";
import type { SimilarPerson } from "../lib/rpc.ts";
import { loginPage } from "../lib/stars-route.ts";
import { starCount } from "../lib/whose.ts";

// People whose stars are most like a login's, each a link to their stars, and the way to everyone else. On someone
// else's stars it is the discover row's last tile. On your own it leads the row, two tiles wide.
export function PeopleTile({
  heading,
  people,
  more,
  wide = false,
}: {
  heading: string;
  people: ReadonlyArray<SimilarPerson>;
  more: string;
  wide?: boolean;
}) {
  return (
    <Tile className={cn("flex min-w-0 flex-col gap-5 pt-tile-top pr-6 pb-6 pl-6 lg:flex-1", wide && "lg:flex-[2]")}>
      <h2 className="font-display text-2xl font-semibold tracking-snug">{heading}</h2>
      <ul aria-label={heading} className={cn("flex flex-col gap-4", wide && "sm:grid sm:grid-cols-2 lg:grid-cols-3")}>
        {people.map((person) => (
          <li key={person.login} className="min-w-0">
            <Link {...loginPage(person.login)} className="flex min-w-0 items-center gap-3 rounded-sm">
              <img
                src={avatarOf(person.login, 40)}
                alt=""
                width={40}
                height={40}
                loading="lazy"
                className="size-10 shrink-0 rounded-full bg-accent-soft outline-1 -outline-offset-1 outline-image-edge"
              />
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-display text-lg leading-6 font-semibold tracking-snug">{`@${person.login}`}</span>
                <span className="truncate font-sans text-meta font-medium text-muted-foreground">
                  {`${starCount(person.shared)} in common`}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <Link to="/people" className={cn(buttonVariants({ variant: "secondary" }), "mt-auto self-start")}>
        {more}
      </Link>
    </Tile>
  );
}
