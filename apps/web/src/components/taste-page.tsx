import { Skeleton, Tile } from "@stargrep/ui";
import { getRouteApi } from "@tanstack/react-router";
import type { Session } from "../lib/page-data.ts";
import { api, type SimilarPerson } from "../lib/rpc.ts";
import { tasteWords } from "../lib/taste.ts";
import { formatCount } from "../lib/whose.ts";
import { loadTab, TabLoading, TabPage } from "./person-tab.tsx";
import { MonthsTile } from "./taste-months.tsx";
import { AlikeTile, LanguagesTile, TopicsTile, YearCountTile } from "./taste-tiles.tsx";
import { YearTile } from "./taste-year.tsx";

const route = getRouteApi("/@{$login}_/taste");

// A login's taste comes with the people like them, and none when that read fails.
export const load = (login: string, session: Session | undefined) =>
  loadTab(
    "taste",
    login,
    session,
    (): Promise<ReadonlyArray<SimilarPerson>> =>
      api()
        .similarPeople({ login, limit: 3 })
        .then(
          (similar) => similar.people,
          () => [],
        ),
    (named, taste) => {
      const languages = taste?.languages.slice(0, 3).map(({ language }) => language) ?? [];
      return {
        title: `@${named}'s taste`,
        description:
          taste === undefined
            ? `What @${named} stars on GitHub and when.`
            : `What @${named} stars on GitHub and when: ${formatCount(taste.stars)} repos${languages.length > 0 ? `, mostly ${languages.join(", ")}` : ""}.`,
      };
    },
  );

// The person, and under them their charts or why there are none.
export function Page() {
  const { login, own, state } = route.useLoaderData();
  const { months } = route.useSearch();
  const words = tasteWords(login, own);
  return (
    <TabPage
      tab="taste"
      login={login}
      own={own}
      state={state}
      words={
        own
          ? { what: "your taste", shows: "your taste shows here" }
          : { what: `@${login}'s taste`, shows: "their taste shows here" }
      }
    >
      {(taste, alike) => (
        <>
          <div className="flex flex-col gap-gap lg:flex-row">
            <MonthsTile login={login} months={taste.months} all={months === "all"} />
            <YearCountTile login={login} taste={taste} words={words} />
          </div>
          <YearTile login={login} weeks={taste.weeks} lastYear={taste.lastYear} words={words} />
          <div className="grid gap-gap sm:grid-cols-2 lg:grid-cols-3">
            {taste.languages.length > 0 && <LanguagesTile login={login} taste={taste} words={words} />}
            {taste.topics.length > 0 && <TopicsTile login={login} taste={taste} words={words} />}
            {alike.length > 0 && <AlikeTile login={login} people={alike} words={words} />}
          </div>
        </>
      )}
    </TabPage>
  );
}

// The page as it will stand, with placeholders where the charts go, so nothing moves when they arrive.
export function Loading() {
  const { login } = route.useParams();
  return (
    <TabLoading tab="taste" login={login}>
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
    </TabLoading>
  );
}
