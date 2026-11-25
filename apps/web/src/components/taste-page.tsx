import { isGitHubLogin } from "@stargrep/github/login";
import { Button, buttonVariants, EmptyTile, type PipPose, Skeleton, Tile } from "@stargrep/ui";
import { getRouteApi, Link, notFound, useLoaderData, useRouter } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import type { Session } from "../lib/page-data.ts";
import { mostlyOf } from "../lib/person-stars.ts";
import { accountImage, canonicalLinks, previewMeta, siteTitle } from "../lib/preview.ts";
import { api, type SimilarPerson, type Taste, wireCode } from "../lib/rpc.ts";
import { lastStarredOn } from "../lib/starred-on.ts";
import { loginPage } from "../lib/stars-route.ts";
import { dayOf, tasteWords } from "../lib/taste.ts";
import { wallNow } from "../lib/wall-clock.ts";
import { formatCount, sameLogin } from "../lib/whose.ts";
import { Page } from "./page.tsx";
import { type PersonStars, PersonTile } from "./person-tile.tsx";
import { personShared, ShareButton } from "./share-button.tsx";
import { MonthsTile } from "./taste-months.tsx";
import { AlikeTile, LanguagesTile, TopicsTile, YearCountTile } from "./taste-tiles.tsx";
import { YearTile } from "./taste-year.tsx";

const route = getRouteApi("/@{$login}_/taste");

// What stargrep knows of a login's taste: the charts, nothing yet because it never read the login's stars, or a read
// that failed. The people like them come with the charts, and none when that read fails.
type TasteState =
  | { readonly kind: "taste"; readonly taste: Taste; readonly alike: ReadonlyArray<SimilarPerson> }
  | { readonly kind: "unread" }
  | { readonly kind: "failed" };

const readTaste = async (login: string): Promise<TasteState> => {
  try {
    const [taste, alike] = await Promise.all([
      api().taste({ login }),
      api()
        .similarPeople({ login, limit: 3 })
        .then(
          (similar) => similar.people,
          () => [],
        ),
    ]);
    return { kind: "taste", taste, alike };
  } catch (error) {
    return wireCode(error) === "ACCOUNT_NOT_SYNCED" ? { kind: "unread" } : { kind: "failed" };
  }
};

export const loadTaste = async (login: string, session: Session | undefined) => {
  if (session === undefined) throw new Error("no session");
  if (!isGitHubLogin(login)) throw notFound();
  const state = await readTaste(login);
  const named = state.kind === "taste" ? state.taste.login : login;
  const path = `/@${named}/taste`;
  const languages = state.kind === "taste" ? state.taste.languages.slice(0, 3).map(({ language }) => language) : [];
  return {
    login: named,
    own: session.viewer !== null && sameLogin(session.viewer.login, login),
    state,
    head: {
      meta: previewMeta(session.site, {
        title: `@${named}'s taste · ${siteTitle}`,
        description:
          state.kind === "taste" && state.taste.stars > 0
            ? `What @${named} stars on GitHub and when: ${formatCount(state.taste.stars)} repos${languages.length > 0 ? `, mostly ${languages.join(", ")}` : ""}.`
            : `What @${named} stars on GitHub and when.`,
        path,
        image: accountImage(named, null, undefined),
      }),
      links: canonicalLinks(session.site, path),
    },
  };
};

// What the person tile says from a login's taste: the year of the first star, when the last one was, what the stars
// mostly carry.
const tasteStars = (taste: Taste): PersonStars => {
  const last = lastStar(taste);
  return {
    kind: "starred",
    since: taste.months[0]?.month.slice(0, 4),
    last: last === undefined ? undefined : lastStarredOn(last, wallNow()),
    mostly: mostlyOf(taste.topics.map(({ topic, count }) => [topic, count] as const)),
  };
};

// The person, and under them their charts or why there are none.
export function TastePage() {
  const { login, own, state } = route.useLoaderData();
  const { months } = route.useSearch();
  const taste = state.kind === "taste" && state.taste.stars > 0 ? state.taste : undefined;
  const words = tasteWords(login, own);
  const known = state.kind !== "unread";
  return (
    <Page here={own ? "you" : undefined} pose={state.kind === "failed" ? "scared" : undefined}>
      <PersonTile
        login={login}
        own={own}
        known={known}
        stars={taste === undefined ? { kind: "unsaid" } : tasteStars(taste)}
        tab="taste"
        counts={{ stars: taste === undefined ? undefined : formatCount(taste.stars) }}
        share={
          known ? (
            <ShareButton
              page={personShared(login)}
              query={undefined}
              className={own ? "max-sm:size-10" : "max-sm:size-[42px]"}
            />
          ) : undefined
        }
      />
      {taste === undefined ? (
        <Empty login={login} own={own} state={state} />
      ) : (
        <>
          <div className="flex flex-col gap-gap lg:flex-row">
            <MonthsTile login={login} months={taste.months} all={months === "all"} />
            <YearCountTile login={login} taste={taste} words={words} />
          </div>
          <YearTile login={login} weeks={taste.weeks} lastYear={taste.lastYear} words={words} />
          <div className="grid gap-gap sm:grid-cols-2 lg:grid-cols-3">
            {taste.languages.length > 0 && <LanguagesTile login={login} taste={taste} words={words} />}
            {taste.topics.length > 0 && <TopicsTile login={login} taste={taste} words={words} />}
            {state.kind === "taste" && state.alike.length > 0 && <AlikeTile people={state.alike} words={words} />}
          </div>
        </>
      )}
    </Page>
  );
}

// The day of the latest star in the last 52 weeks, as the person tile says it.
const lastStar = (taste: Taste) => {
  for (const week of [...taste.weeks].reverse()) {
    const offset = week.days.findLastIndex((stars) => stars > 0);
    if (offset !== -1) return `${dayOf(week.start, offset)}T00:00:00Z`;
  }
  return undefined;
};

const actionClass = buttonVariants({ variant: "primary", size: "lg" });

function Empty({ login, own, state }: { login: string; own: boolean; state: TasteState }) {
  const router = useRouter();
  const [retrying, setRetrying] = useState(false);
  const open = (label: string) => (
    <Link {...loginPage(login)} className={`${actionClass} mt-2`}>
      {label}
    </Link>
  );
  const say = (pose: PipPose, heading: string, body: string, action: ReactNode) => (
    <EmptyTile pose={pose} heading={heading} body={body}>
      {action}
    </EmptyTile>
  );
  switch (state.kind) {
    case "failed":
      return say(
        "scared",
        own ? "couldn't load your taste" : `couldn't load @${login}'s taste`,
        "stargrep couldn't read it just now.",
        <Button
          variant="primary"
          size="lg"
          className="mt-2"
          disabled={retrying}
          onClick={() => {
            setRetrying(true);
            router
              .invalidate({ filter: (match) => match.routeId === "/@{$login}_/taste" })
              .finally(() => setRetrying(false));
          }}
        >
          try again
        </Button>,
      );
    case "unread":
      return own
        ? say(
            "idle",
            "your stars haven't arrived yet",
            "open your stars and stargrep reads them.",
            open("open your stars"),
          )
        : say(
            "idle",
            `stargrep hasn't read @${login}'s stars yet`,
            "open their stars and stargrep reads them, then their taste shows here.",
            open(`open @${login}'s stars`),
          );
    case "taste":
      return state.taste.starredOnGitHub === 0
        ? say(
            "unsure",
            own ? "you haven't starred anything yet" : `@${login} hasn't starred anything yet`,
            own
              ? "star repos on GitHub and your taste shows here."
              : "once they star repos on GitHub, their taste shows here.",
            null,
          )
        : say(
            "happy",
            own ? "your stars are arriving" : `@${login}'s stars are arriving`,
            own
              ? "your taste shows here once stargrep has read them."
              : "their taste shows here once stargrep has read them.",
            open(own ? "watch them arrive" : `open @${login}'s stars`),
          );
  }
}

// The page as it will stand, with placeholders where the charts go, so nothing moves when they arrive.
export function TasteLoading() {
  const { login } = route.useParams();
  const { viewer } = useLoaderData({ from: "__root__" });
  return (
    <Page>
      <PersonTile
        login={login}
        own={viewer !== null && sameLogin(viewer.login, login)}
        known
        stars={{ kind: "loading" }}
        tab="taste"
        counts={{}}
      />
      <div className="flex flex-col gap-gap lg:flex-row">
        <Tile className="flex flex-col gap-4.5 px-5 pt-5 pb-4.5 sm:px-7 sm:pt-6 sm:pb-5.5 lg:w-195 lg:shrink-0">
          <Skeleton className="h-6.5 w-48 sm:h-7.5" />
          <Skeleton className="h-27.5 w-full rounded-md sm:h-42.5" />
          <Skeleton className="h-4 w-full" />
        </Tile>
        <Tile variant="highlight" className="h-[230px] opacity-60 max-lg:order-first sm:h-[298px] lg:flex-1" />
      </div>
      <Tile className="flex flex-col gap-4 px-5 pt-5 pb-4.5 sm:px-7 sm:py-6">
        <Skeleton className="h-6.5 w-40 sm:h-7.5" />
        <Skeleton className="h-[105px] w-full rounded-md sm:h-[121px]" />
      </Tile>
      <div className="grid gap-gap sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((index) => (
          <Tile key={index} className="flex h-[200px] flex-col gap-3.5 p-6 sm:h-[254px]">
            <Skeleton className="h-7 w-44" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </Tile>
        ))}
      </div>
    </Page>
  );
}
