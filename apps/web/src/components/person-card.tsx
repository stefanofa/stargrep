import { Skeleton, Tile } from "@stargrep/ui";
import { Link } from "@tanstack/react-router";
import { avatarOf } from "../lib/avatar.ts";
import { lastStarredOn } from "../lib/starred-on.ts";
import { loginPage } from "../lib/stars-route.ts";
import { formatCount } from "../lib/whose.ts";

// A row on phones, as lists of places are there, and a card from 640px.
const box =
  "flex min-w-0 items-center gap-3 py-3.5 pr-5 pl-3.5 sm:flex-col sm:items-stretch sm:gap-3.5 sm:pt-6 sm:pr-tile-sm sm:pb-tile-sm sm:pl-6";

export interface CardPerson {
  readonly login: string;
  readonly lastStarredAt: string;
  // The topics most of their stars carry, most first.
  readonly topics: ReadonlyArray<string>;
  // How many stars they share with whoever the list compares them to, or null with no one to compare.
  readonly shared: number | null;
}

// One person in a grid of people: who, whether you follow them, when they last starred, how many stars they share, and
// what their stars mostly carry, on one line that drops the topics that don't fit. Phones leave the topics out. The
// whole card opens their stars.
export function PersonCard({ person, following, at }: { person: CardPerson; following: boolean; at: number }) {
  return (
    <Tile className={`group ${box}`}>
      <div className="flex min-w-0 flex-1 items-center gap-3 sm:flex-none">
        <img
          src={avatarOf(person.login, 56)}
          alt=""
          width={56}
          height={56}
          loading="lazy"
          className="size-12 shrink-0 rounded-full bg-accent-soft outline-1 -outline-offset-1 outline-image-edge sm:size-14"
        />
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className="truncate font-display text-lg leading-[22px] font-semibold sm:text-title sm:leading-[26px] transition-colors duration-120 group-hover:text-accent-strong">
            <Link
              {...loginPage(person.login)}
              className="outline-none after:absolute after:inset-0 after:squircle after:rounded-tile focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-ring"
            >
              {`@${person.login}`}
            </Link>
          </h3>
          <p className="truncate font-sans text-sm text-muted-foreground">
            {following ? "you follow · starred" : "last starred"} {lastStarredOn(person.lastStarredAt, at)}
          </p>
        </div>
      </div>
      {person.shared !== null && (
        <p className="flex shrink-0 flex-col items-end sm:flex-row sm:items-baseline sm:gap-1.5">
          <span className="font-display text-xl leading-6 font-semibold tabular-nums sm:text-name">
            {formatCount(person.shared)}
          </span>
          <span className="font-sans text-sm text-secondary-foreground sm:text-meta">
            <span className="max-sm:hidden">{person.shared === 1 ? "star " : "stars "}</span>in common
          </span>
        </p>
      )}
      {person.topics.length > 0 && (
        <p className="mt-auto flex h-[35.5px] flex-wrap gap-x-1.5 gap-y-3 overflow-hidden border-t-[1.5px] border-muted pt-3 font-sans text-sm max-sm:hidden">
          <span className="pr-0.5 leading-[22px] text-muted-foreground">mostly</span>
          {person.topics.map((topic) => (
            <span key={topic} className="rounded-full bg-accent-soft px-2.5 py-0.5 leading-[18px] font-medium">
              {topic}
            </span>
          ))}
        </p>
      )}
    </Tile>
  );
}

// A card's size while the people load, so the cards that replace it move nothing.
export function PersonCardPlaceholder() {
  return (
    <Tile aria-hidden className={box}>
      <div className="flex flex-1 items-center gap-3 sm:flex-none">
        <Skeleton className="size-12 shrink-0 rounded-full sm:size-14" />
        <span className="flex flex-1 flex-col gap-2">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-3.5 w-24" />
        </span>
      </div>
      <Skeleton className="h-10 w-16 sm:h-[30px] sm:w-40" />
      <div className="flex gap-1.5 border-t-[1.5px] border-muted pt-3 max-sm:hidden">
        <Skeleton className="h-[22px] w-12" />
        <Skeleton className="h-[22px] w-14 rounded-full" />
        <Skeleton className="h-[22px] w-16 rounded-full" />
      </div>
    </Tile>
  );
}
