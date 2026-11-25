import { cn, Pip, Tile } from "@stargrep/ui";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { avatarOf } from "../lib/avatar.ts";
import type { SimilarPerson, Taste } from "../lib/rpc.ts";
import { loginPage } from "../lib/stars-route.ts";
import { starsOf, type TasteWords } from "../lib/taste.ts";
import { formatCount, starCount } from "../lib/whose.ts";
import { textLinkClass } from "./external-text-link.tsx";

const heading = "font-display text-[22px] leading-6.5 font-semibold sm:text-xl sm:leading-7";

// The page's one butter tile: the stars of the last year as its big number, then what GitHub counts, what went
// archived, and what went away this year.
export function YearCountTile({ login, taste, words }: { login: string; taste: Taste; words: TasteWords }) {
  return (
    <Tile
      variant="highlight"
      className="flex flex-col gap-3 px-5.5 pt-5.5 pb-4.5 sm:justify-between sm:px-7.5 sm:pt-6.5 sm:pb-5.5 max-lg:order-first lg:min-w-0 lg:flex-1"
    >
      <span
        aria-hidden
        className="absolute top-6 right-6.5 flex size-11.5 items-center justify-center rounded-full bg-plate max-sm:hidden"
      >
        <Pip size={30} />
      </span>
      <p className="flex items-baseline gap-2.5 sm:flex-col sm:items-start sm:gap-0.5">
        <span className="font-display text-[60px] leading-15 font-semibold tracking-[-0.03em] sm:text-[88px] sm:leading-22">
          {formatCount(taste.lastYear)}
        </span>
        <span className="font-sans text-meta font-medium text-secondary-foreground sm:text-base sm:leading-5">
          {taste.lastYear === 1 ? "star in the last year" : "stars in the last year"}
        </span>
      </p>
      <dl className="flex flex-col">
        {taste.starredOnGitHub !== null && (
          <Fact label="on GitHub, all time">{formatCount(taste.starredOnGitHub)}</Fact>
        )}
        <Fact label={words.archived}>
          {taste.archived === 0 ? (
            "0"
          ) : (
            <Link
              {...starsOf(login, { archived: true })}
              aria-label={`${formatCount(taste.archived)} archived, open them in stars`}
              className="rounded-xs text-accent-strong hover:underline"
            >
              {`${formatCount(taste.archived)} →`}
            </Link>
          )}
        </Fact>
        <Fact label="unstarred this year">{formatCount(taste.unstarredThisYear)}</Fact>
      </dl>
    </Tile>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-t-[1.5px] border-ink/14 py-2 last:pb-0 sm:py-2.5 sm:last:pb-0">
      <dt className="font-sans text-meta text-secondary-foreground">{label}</dt>
      <dd className="font-display text-base leading-4.5 font-semibold sm:text-lg sm:leading-5">{children}</dd>
    </div>
  );
}

// The first three languages wear the colors the language bar gives them everywhere, ink, accent and butter.
const fills = ["bg-foreground", "bg-accent", "bg-highlight"] as const;
const dots = ["bg-foreground", "bg-accent", "bg-highlight-edge"] as const;
const percent = (share: number) => `${Math.round(share * 100)}%`;

// What share of the stars each language holds. Wide screens rank the first five as bars against the first, phones
// stack the first three in one bar with the rest as other. A language opens the stars in it.
export function LanguagesTile({ login, taste, words }: { login: string; taste: Taste; words: TasteWords }) {
  const shares = taste.languages.map(({ language, count }) => ({ language, share: count / Math.max(1, taste.stars) }));
  const ranked = shares.slice(0, 5);
  const top = shares.slice(0, fills.length);
  const rest = Math.max(0, 1 - top.reduce((sum, { share }) => sum + share, 0));
  const most = ranked[0]?.share ?? 1;
  const open = (language: string) => starsOf(login, { lang: language });
  return (
    <Tile className="flex flex-col gap-3 p-5 sm:gap-3.5 sm:p-6">
      <h2 className={heading}>{words.languages}</h2>
      <ul className="flex flex-col gap-2.5 max-sm:hidden">
        {ranked.map(({ language, share }, index) => (
          <li key={language}>
            <Link
              {...open(language)}
              aria-label={`${language}, ${percent(share)} of the stars`}
              className="group flex items-center gap-3 rounded-xs"
            >
              <span className="w-21 shrink-0 truncate font-sans text-meta group-hover:text-accent-strong">
                {language}
              </span>
              <span aria-hidden className="h-2 min-w-0 flex-1 rounded-full bg-muted">
                <span
                  className={cn("block h-2 rounded-full", fills[index] ?? "bg-accent")}
                  style={{ width: `${(share / most) * 100}%` }}
                />
              </span>
              <span className="w-8.5 shrink-0 text-right font-sans text-sm text-muted-foreground tabular-nums">
                {percent(share)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <div className="flex flex-col gap-3 sm:hidden">
        <div aria-hidden className="flex h-2.5 gap-0.5 overflow-hidden rounded-full">
          {top.map(({ language, share }, index) => (
            <span key={language} className={fills[index]} style={{ flexGrow: share }} />
          ))}
          {rest > 0 && <span className="bg-muted" style={{ flexGrow: rest }} />}
        </div>
        <ul className="flex flex-wrap gap-x-3.5 gap-y-1.5 font-sans text-meta text-secondary-foreground">
          {top.map(({ language, share }, index) => (
            <li key={language}>
              <Link {...open(language)} className="flex items-center gap-1.5 rounded-xs">
                <span aria-hidden className={cn("size-2.5 rounded-full", dots[index])} />
                {`${language} ${percent(share)}`}
              </Link>
            </li>
          ))}
          {rest > 0 && (
            <li className="flex items-center gap-1.5">
              <span aria-hidden className="size-2.5 rounded-full bg-avatar-2" />
              {`other ${percent(rest)}`}
            </li>
          )}
        </ul>
      </div>
    </Tile>
  );
}

// The GitHub topics most of the stars carry. A chip opens the stars on that topic.
export function TopicsTile({ login, taste, words }: { login: string; taste: Taste; words: TasteWords }) {
  return (
    <Tile className="flex flex-col gap-3 p-5 sm:gap-3.5 sm:p-6">
      <h2 className={heading}>{words.topics}</h2>
      <ul className="flex flex-wrap gap-2">
        {taste.topics.slice(0, 8).map(({ topic, count }, index) => (
          <li key={topic} className={cn(index >= 6 && "max-sm:hidden")}>
            <Link
              {...starsOf(login, { topic })}
              aria-label={`${topic}, ${starCount(count)}`}
              className="flex rounded-full bg-accent-soft px-3 py-1.5 font-sans text-meta font-medium transition-colors duration-120 hover:bg-accent/30"
            >
              {topic}
              <span className="ml-1 sm:font-normal sm:text-muted-foreground">{formatCount(count)}</span>
            </Link>
          </li>
        ))}
      </ul>
      <p className="font-sans text-sm leading-4.5 text-muted-foreground max-sm:hidden">{words.chips}</p>
    </Tile>
  );
}

// The people on the people list whose stars overlap the most, each a link to their stars.
export function AlikeTile({ people, words }: { people: ReadonlyArray<SimilarPerson>; words: TasteWords }) {
  return (
    <Tile className="flex flex-col gap-3 p-5 sm:gap-3.5 sm:p-6">
      <h2 className={heading}>{words.alike}</h2>
      <ul className="flex flex-col gap-3">
        {people.map((person) => (
          <li key={person.login}>
            <Link {...loginPage(person.login)} className="group flex min-w-0 items-center gap-3 rounded-xs">
              <img
                src={avatarOf(person.login, 36)}
                alt=""
                width={36}
                height={36}
                loading="lazy"
                className="size-9 shrink-0 rounded-full bg-accent-soft outline-1 -outline-offset-1 outline-image-edge"
              />
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-display text-lg leading-5 font-semibold group-hover:text-accent-strong">
                  {`@${person.login}`}
                </span>
                <span className="truncate font-sans text-sm text-muted-foreground">{`${starCount(person.shared)} in common`}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <Link to="/people" className={cn(textLinkClass, "mt-auto self-start font-sans text-meta font-medium")}>
        more people →
      </Link>
    </Tile>
  );
}
