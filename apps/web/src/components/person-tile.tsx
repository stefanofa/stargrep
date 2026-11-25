import { Chip, Skeleton, Tile } from "@stargrep/ui";
import { Link, type LinkProps } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { avatarOf } from "../lib/avatar.ts";
import { loginPage } from "../lib/stars-route.ts";
import { useTopicPages } from "../lib/topic-links.ts";
import { ExternalTextLink } from "./external-text-link.tsx";
import { Tabs } from "./tabs.tsx";

// The tabs of a person's page, in order, and where each lives. A tab shows once its route exists, so adding one is one
// entry here. Your own stars live at /.
const personTabs = [
  {
    name: "stars",
    link: (login: string, own: boolean): LinkProps =>
      own ? { to: "/{-$login}", params: { login: undefined } } : loginPage(login),
  },
  { name: "taste", link: (login: string): LinkProps => ({ to: "/@{$login}/taste", params: { login } }) },
  { name: "people", link: (login: string): LinkProps => ({ to: "/@{$login}/people", params: { login } }) },
] as const;

export type PersonTab = (typeof personTabs)[number]["name"];

// What the tile says about the person's stars. It waits for the library, says the stars are arriving while they
// import, and says nothing when the page is in trouble, since the tile below explains.
export type PersonStars =
  | { readonly kind: "loading" }
  | { readonly kind: "arriving" }
  | { readonly kind: "unsaid" }
  | {
      readonly kind: "starred";
      // The year of the first star and when the last one was, or undefined with no stars at all.
      readonly since: string | undefined;
      readonly last: string | undefined;
      // The topics most of their stars carry, most first.
      readonly mostly: ReadonlyArray<string>;
    };

const topicChip = "h-7 px-3";

// The topics most of their stars carry. A topic with a page links to it, and any other is the same pill, still.
function Mostly({ topics }: { topics: ReadonlyArray<string> | undefined }) {
  const pageOf = useTopicPages(topics ?? []);
  if (topics?.length === 0) return null;
  return (
    <div className="flex items-center gap-1.5 pt-0.5 max-sm:hidden">
      <span className="pr-0.5 font-sans text-meta text-muted-foreground">mostly</span>
      {topics === undefined
        ? ["w-12", "w-20", "w-14"].map((width) => <Skeleton key={width} className={`h-7 rounded-full ${width}`} />)
        : topics.map((topic) => {
            const page = pageOf(topic);
            return page === null ? (
              <span
                key={topic}
                className={`flex items-center rounded-full bg-accent-soft font-sans text-meta font-medium ${topicChip}`}
              >
                {topic}
              </span>
            ) : (
              <Chip key={topic} className={topicChip} render={<Link to="/topics/$topic" params={{ topic: page }} />}>
                {topic}
              </Chip>
            );
          })}
    </div>
  );
}

// Phones leave the GitHub link out, so the line fits beside the avatar.
function Facts({ stars, login }: { stars: PersonStars; login: string }) {
  return (
    <p className="font-sans text-sm text-muted-foreground sm:text-[15px] sm:leading-5">
      {stars.kind === "loading" && (
        <>
          <Skeleton className="inline-block h-[0.8em] w-40 align-middle" />
          <span className="max-sm:hidden"> · </span>
        </>
      )}
      {stars.kind === "arriving" && (
        <>
          stars arriving<span className="max-sm:hidden"> · </span>
        </>
      )}
      {stars.kind === "starred" && (
        <>
          {stars.since === undefined ? (
            "no stars yet"
          ) : (
            <>
              <span className="max-sm:hidden">starring </span>
              {`since ${stars.since} · last starred ${stars.last}`}
            </>
          )}
          <span className="max-sm:hidden"> · </span>
        </>
      )}
      <span className="max-sm:hidden">
        <ExternalTextLink href={`https://github.com/${login}`}>on GitHub ↗</ExternalTextLink>
      </span>
    </p>
  );
}

// The person whose stars the page shows, on every page but the landing, yours included: avatar, handle, since when and
// how lately they star, the topics they mostly star, their actions, and the tabs of their page. A login GitHub doesn't
// know gets its handle alone. Phones put a follow on its own row, under the person.
export function PersonTile({
  login,
  own,
  known,
  stars,
  share,
  follow,
  tab,
  counts,
}: {
  login: string;
  own: boolean;
  known: boolean;
  stars: PersonStars;
  share?: ReactNode;
  follow?: ReactNode;
  // The tab on screen, and a number for any tab that has one.
  tab: PersonTab;
  counts: Partial<Record<PersonTab, ReactNode>>;
}) {
  return (
    <Tile className="flex flex-col gap-3.5 px-5 pt-5 pb-0 sm:gap-[22px] sm:px-[30px] sm:pt-[30px]">
      <div className="flex flex-wrap items-center gap-3.5 sm:flex-nowrap sm:gap-[26px]">
        {/* A plain image paints from the server's HTML, where an avatar that waits for its image would paint initials. */}
        {known ? (
          <img
            src={avatarOf(login, 96)}
            alt=""
            width={96}
            height={96}
            className="size-14 shrink-0 rounded-full bg-accent-soft outline-1 -outline-offset-1 outline-image-edge sm:size-24"
          />
        ) : (
          <span
            aria-hidden
            className="flex size-14 shrink-0 items-center justify-center rounded-full bg-avatar-2 font-display text-2xl font-semibold text-ink sm:size-24 sm:text-3xl"
          >
            {login.slice(0, 2).toLowerCase()}
          </span>
        )}
        <div className="flex min-w-0 flex-1 basis-0 flex-col gap-[3px] sm:gap-2">
          <h1 className="truncate font-display text-name font-semibold tracking-[-0.01em] sm:text-3xl sm:leading-10 sm:tracking-[-0.02em]">
            {`@${login}`}
          </h1>
          {known && <Facts stars={stars} login={login} />}
          {(stars.kind === "starred" || stars.kind === "loading") && (
            <Mostly topics={stars.kind === "starred" ? stars.mostly : undefined} />
          )}
        </div>
        {(share !== undefined || follow !== undefined) && (
          <div className={`flex shrink-0 items-center gap-2 sm:gap-2.5 ${follow === undefined ? "" : "max-sm:w-full"}`}>
            {share}
            {follow !== undefined && <div className="max-sm:-order-1 max-sm:flex-1">{follow}</div>}
          </div>
        )}
      </div>
      <Tabs
        label={own ? "your page" : `@${login}'s page`}
        current={tab}
        tabs={personTabs.map(({ name, link }) => ({ name, link: link(login, own), count: counts[name] }))}
      />
    </Tile>
  );
}
