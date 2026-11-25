import { isGitHubLogin } from "@stargrep/github/login";
import { Button, buttonVariants, EmptyTile, type PipPose } from "@stargrep/ui";
import { Link, notFound, useLoaderData, useRouter } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import type { Session } from "../lib/page-data.ts";
import { mostlyOf } from "../lib/person-stars.ts";
import { accountImage, canonicalLinks, previewMeta, siteTitle } from "../lib/preview.ts";
import { api, type Taste, wireCode } from "../lib/rpc.ts";
import { lastStarredOn } from "../lib/starred-on.ts";
import { loginPage } from "../lib/stars-route.ts";
import { dayOf } from "../lib/taste.ts";
import { wallNow } from "../lib/wall-clock.ts";
import { formatCount, sameLogin } from "../lib/whose.ts";
import { Page } from "./page.tsx";
import { type PersonStars, type PersonTab, PersonTile } from "./person-tile.tsx";
import { ShareButton } from "./share-button.tsx";

// The tabs of a person's page beside stars, each a route chunk of its own that reads the login's taste for the person
// tile, and what the tab shows besides.
type TabName = Exclude<PersonTab, "stars">;

const routeIds = { taste: "/@{$login}_/taste", people: "/@{$login}_/people" } as const satisfies Record<
  TabName,
  string
>;

// What stargrep knows of a login for a tab: its taste and the tab's own answer, nothing yet because it never read the
// login's stars, or a read that failed.
export type TabState<A> =
  | { readonly kind: "read"; readonly taste: Taste; readonly answer: A }
  | { readonly kind: "unread" }
  | { readonly kind: "failed" };

const readTab = async <A,>(login: string, answer: Promise<A>): Promise<TabState<A>> => {
  try {
    const [taste, answered] = await Promise.all([api().taste({ login }), answer]);
    return { kind: "read", taste, answer: answered };
  } catch (error) {
    return wireCode(error) === "ACCOUNT_NOT_SYNCED" ? { kind: "unread" } : { kind: "failed" };
  }
};

// The tab's loader: the login's taste and the tab's answer, under the login's own spelling, with the head the tab's
// address shares.
export const loadTab = async <A,>(
  tab: TabName,
  login: string,
  session: Session | undefined,
  answer: () => Promise<A>,
  head: (named: string, taste: Taste | undefined) => { readonly title: string; readonly description: string },
) => {
  if (session === undefined) throw new Error("no session");
  if (!isGitHubLogin(login)) throw notFound();
  const state = await readTab(login, answer());
  const named = state.kind === "read" ? state.taste.login : login;
  const path = `/@${named}/${tab}`;
  const { title, description } = head(named, state.kind === "read" && state.taste.stars > 0 ? state.taste : undefined);
  return {
    login: named,
    own: session.viewer !== null && sameLogin(session.viewer.login, login),
    state,
    head: {
      meta: previewMeta(session.site, {
        title: `${title} · ${siteTitle}`,
        description,
        path,
        image: accountImage(named, null, undefined),
      }),
      links: canonicalLinks(session.site, path),
    },
  };
};

// The day of the latest star in the last 52 weeks, as the person tile says it.
const lastStar = (taste: Taste) => {
  for (const week of [...taste.weeks].reverse()) {
    const offset = week.days.findLastIndex((stars) => stars > 0);
    if (offset !== -1) return `${dayOf(week.start, offset)}T00:00:00Z`;
  }
  return undefined;
};

// The topics a login's stars mostly carry, most first.
export const mostlyIn = (taste: Taste) => mostlyOf(taste.topics.map(({ topic, count }) => [topic, count] as const));

// What the person tile says from a login's taste: the year of the first star, when the last one was, what the stars
// mostly carry.
const tasteStars = (taste: Taste): PersonStars => {
  const last = lastStar(taste);
  return {
    kind: "starred",
    since: taste.months[0]?.month.slice(0, 4),
    last: last === undefined ? undefined : lastStarredOn(last, wallNow()),
    mostly: mostlyIn(taste),
  };
};

// What a tab shows, in the words its empty states use: "your taste" and "their taste shows here", for instance.
export interface TabWords {
  readonly what: string;
  readonly shows: string;
}

// The person and their tab, or why the tab has nothing to show: the login was never read, its stars are arriving, it
// stars nothing, or the read failed.
export function TabPage<A>({
  tab,
  login,
  own,
  state,
  words,
  children,
}: {
  tab: TabName;
  login: string;
  own: boolean;
  state: TabState<A>;
  words: TabWords;
  children: (taste: Taste, answer: A) => ReactNode;
}) {
  const taste = state.kind === "read" && state.taste.stars > 0 ? state.taste : undefined;
  const known = state.kind !== "unread";
  return (
    <Page here={own ? "you" : undefined} pose={state.kind === "failed" ? "scared" : undefined}>
      <PersonTile
        login={login}
        own={own}
        known={known}
        stars={taste === undefined ? { kind: "unsaid" } : tasteStars(taste)}
        tab={tab}
        counts={{ stars: taste === undefined ? undefined : formatCount(taste.stars) }}
        share={
          known ? (
            <ShareButton login={login} query={undefined} className={own ? "max-sm:size-10" : "max-sm:size-[42px]"} />
          ) : undefined
        }
      />
      {taste === undefined || state.kind !== "read" ? (
        <Empty tab={tab} login={login} own={own} state={state} words={words} />
      ) : (
        children(taste, state.answer)
      )}
    </Page>
  );
}

const actionClass = buttonVariants({ variant: "primary", size: "lg" });

function Empty<A>({
  tab,
  login,
  own,
  state,
  words,
}: {
  tab: TabName;
  login: string;
  own: boolean;
  state: TabState<A>;
  words: TabWords;
}) {
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
        `couldn't load ${words.what}`,
        "stargrep couldn't read it just now.",
        <Button
          variant="primary"
          size="lg"
          className="mt-2"
          disabled={retrying}
          onClick={() => {
            setRetrying(true);
            router.invalidate({ filter: (match) => match.routeId === routeIds[tab] }).finally(() => setRetrying(false));
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
            `open their stars and stargrep reads them, then ${words.shows}.`,
            open(`open @${login}'s stars`),
          );
    case "read":
      return state.taste.starredOnGitHub === 0
        ? say(
            "unsure",
            own ? "you haven't starred anything yet" : `@${login} hasn't starred anything yet`,
            own ? `star repos on GitHub and ${words.shows}.` : `once they star repos on GitHub, ${words.shows}.`,
            null,
          )
        : say(
            "happy",
            own ? "your stars are arriving" : `@${login}'s stars are arriving`,
            `${words.shows} once stargrep has read them.`,
            open(own ? "watch them arrive" : `open @${login}'s stars`),
          );
  }
}

// The page as it will stand while the tab loads, with the tab's placeholders under the person.
export function TabLoading({ tab, login, children }: { tab: TabName; login: string; children: ReactNode }) {
  const { viewer } = useLoaderData({ from: "__root__" });
  return (
    <Page>
      <PersonTile
        login={login}
        own={viewer !== null && sameLogin(viewer.login, login)}
        known
        stars={{ kind: "loading" }}
        tab={tab}
        counts={{}}
      />
      {children}
    </Page>
  );
}
