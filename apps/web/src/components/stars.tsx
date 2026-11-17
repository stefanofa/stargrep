import {
  Button,
  EmptyTile,
  type OpenResult,
  type PipPose,
  RephraseChips,
  RepoPanel,
  Results,
  SearchTile,
  type Sort,
  SortMenu,
  StatusLine,
  type View,
  ViewToggle,
} from "@stargrep/ui";
import { useLiveQuery } from "@tanstack/react-db";
import { Link, useHydrated, useNavigate, useRouter, useSearch } from "@tanstack/react-router";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { policyOf, starredOf, whoseOf } from "../lib/audience.ts";
import { keywordTerms, normalize, searchText } from "../lib/keyword.ts";
import { getLibrary, type Library } from "../lib/library-collection.ts";
import { askedPage, type PageData, type PageRequest, type Session } from "../lib/page-data.ts";
import { hitsOf, liveView } from "../lib/page-view.ts";
import { closesBack } from "../lib/panel-history.ts";
import { now, startsIn, toDetail, withLinks } from "../lib/present.ts";
import { withReply } from "../lib/results.ts";
import { useReveal } from "../lib/reveal.ts";
import { playSurprise } from "../lib/reveal-timing.ts";
import type { Viewer } from "../lib/rpc.ts";
import { librarySorts, type Params, searchSorts, validateParams } from "../lib/search-params.ts";
import { type Arriving, type Body, pageView, type Retry, type Stage, stageOf } from "../lib/search-state.ts";
import { storedView, useStoredView } from "../lib/stored-view.ts";
import { libraryRevision, nothingSynced } from "../lib/sync-status.ts";
import { libraryTrouble, type Trouble } from "../lib/trouble.ts";
import { useSemanticSearch } from "../lib/use-semantic.ts";
import { useSync } from "../lib/use-sync.ts";
import { theirs } from "../lib/whose.ts";
import { AccountMenu } from "./account-menu.tsx";
import { HeaderEnd } from "./github-star-link.tsx";
import { Hero, TryChips } from "./landing-hero.tsx";
import { LibraryPlaceholder, LibraryView } from "./library-view.tsx";
import { OwnerPill } from "./owner-pill.tsx";

// A navigation in the browser starts from the session the server loaded. The page reads the rest once it mounts.
export const pageFor = (request: PageRequest, { viewer, config, repoStars }: Session): PageData => {
  const { audience, query, defaultQuery } = askedPage(viewer, config, request);
  return {
    audience,
    repoStars,
    config,
    query,
    defaultQuery,
    first: null,
    sync: null,
    refusal: null,
    opened: null,
    view: storedView(document.cookie) ?? null,
  };
};

// Until other scopes ship, the scope switch is one link to the viewer's own stars rather than a tab list of one.
export function HeaderControls({ viewer, star }: { viewer: Viewer; star: ReactNode }) {
  return (
    <>
      <nav aria-label="Scope" className="flex items-center rounded-full bg-card p-1 max-sm:hidden">
        <Link
          to="/{-$login}"
          params={{ login: undefined }}
          activeOptions={{ exact: true, includeSearch: false }}
          className="flex h-9 items-center rounded-full px-[18px] font-sans text-meta font-medium text-muted-foreground transition-[color,background-color] duration-120 hover:text-foreground aria-[current=page]:bg-accent aria-[current=page]:font-semibold aria-[current=page]:text-ink"
        >
          Your stars
        </Link>
      </nav>
      <HeaderEnd star={star} account={<AccountMenu login={viewer.login} avatarUrl={viewer.avatarUrl} />} />
    </>
  );
}

const dock =
  "max-sm:fixed max-sm:inset-x-3 max-sm:bottom-[max(16px,env(safe-area-inset-bottom))] max-sm:z-30 max-sm:[&_[data-slot=tile]]:shadow-dock";

function useArrangement(searching: boolean, saved: View | null) {
  const params: Params = useSearch({ strict: false });
  const navigate = useNavigate();
  const [storedView, storeView] = useStoredView(saved ?? "tiles");
  const view = params.view ?? storedView;
  const sort = params.sort ?? (searching ? "best" : "starred");
  const setView = (next: View) => {
    storeView(next);
    navigate({ to: ".", search: (previous) => ({ ...previous, view: next }), replace: true });
  };
  const setSort = (next: Sort) =>
    navigate({ to: ".", search: (previous) => ({ ...previous, sort: next }), replace: true });
  return { view, sort, setView, setSort };
}

function Waiting({
  view,
  searching,
  arriving,
  landing,
}: {
  view: View;
  searching: boolean;
  arriving: Arriving | undefined;
  landing: boolean;
}) {
  return searching ? (
    <Results view={view} groups={[{ key: "all", results: [], pending: 4 }]} hero={landing ? "card" : "butter"} />
  ) : (
    <LibraryPlaceholder view={view} arriving={arriving} butter={!landing} />
  );
}

const measured = (stage: Stage) => {
  if (stage.name === "importing") return { done: stage.done, total: stage.total };
  if (stage.name === "reading") return { done: stage.settled, total: stage.total };
  return undefined;
};

// How long the import or the reading has left, at its pace since the stage started. The clock is when the sync status
// was read, so the estimate moves with each poll and holds still between them.
function useTimeLeft(stage: Stage, readAt: number | undefined) {
  const progress = measured(stage);
  const mark = progress && readAt !== undefined ? { stage: stage.name, at: readAt, done: progress.done } : undefined;
  const [start, setStart] = useState(mark);
  if (mark?.stage !== start?.stage) setStart(mark);
  if (mark === undefined || start === undefined || progress?.total == null) return undefined;
  const perSecond = (mark.done - start.done) / Math.max(1, (mark.at - start.at) / 1000);
  if (perSecond <= 0) return undefined;
  const seconds = Math.ceil((progress.total - mark.done) / perSecond);
  if (seconds <= 5) return "almost done";
  return seconds < 90 ? `about ${seconds} seconds left` : `about ${Math.round(seconds / 60)} minutes left`;
}

const quiet = 600;

function useSurprise(query: string, landed: boolean) {
  const typedAt = useRef(0);
  const [surprised, setSurprised] = useState(false);
  useEffect(() => {
    typedAt.current = now();
  }, [query]);
  useEffect(() => {
    if (!landed) return;
    const wait = Math.max(0, quiet - (now() - typedAt.current));
    const fiber = Effect.runFork(playSurprise(wait, setSurprised));
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [query, landed]);
  return surprised;
}

function useWhole(library: Library | undefined) {
  const [whole, setWhole] = useState(false);
  useEffect(() => {
    let current = true;
    library?.whole.then(() => {
      if (current) setWhole(true);
    });
    return () => {
      current = false;
    };
  }, [library]);
  return whole;
}

// The server and the hydrating browser render without the library, so both paint the same first answer. The library
// loads once the page is hydrated. A login with nothing synced has an empty library, so the server already paints its
// state: ready to import, in line, or the first stars on their way.
export function Stars({ data, onPose }: { data: PageData; onPose: (pose: PipPose) => void }) {
  const { audience, first } = data;
  const owner = audience.owner.login;
  const policy = policyOf(audience);
  const whose = whoseOf(audience);
  const hydrated = useHydrated();
  const empty = nothingSynced(first?.sync ?? data.sync);
  const library = hydrated ? getLibrary(owner, policy.library, empty) : undefined;
  const collection = library?.collection;
  const [retrying, setRetrying] = useState(false);
  const [at] = useState(() => first?.at ?? now());
  const params: Params = useSearch({ strict: false });
  const navigate = useNavigate();
  const router = useRouter();
  const [query, setQuery] = useState(params.q ?? data.query);
  // Typing replaces ?q= as it goes, so only Back and Forward bring another query into the search box.
  useEffect(
    () =>
      router.history.subscribe(({ location, action }) => {
        if (action.type === "PUSH" || action.type === "REPLACE") return;
        setQuery(validateParams(router.parseLocation(location).search).q ?? data.defaultQuery);
      }),
    [router, data.defaultQuery],
  );
  const [opener, setOpener] = useState<HTMLElement | null>(null);

  const {
    data: entries = [],
    isReady: queried,
    isLoadingError,
  } = useLiveQuery((q) => (collection === undefined ? undefined : q.from({ repo: collection })));
  const whole = useWhole(library);
  const { watch, retry } = useSync(
    owner,
    policy.syncOnOpen,
    () => library?.reload(),
    first?.sync ?? data.sync ?? undefined,
    data.refusal ?? undefined,
  );
  const sync = watch.kind === "watching" ? watch.status : undefined;
  const readAt = watch.kind === "watching" ? watch.at : undefined;
  const starred = starredOf(audience, sync);
  const stage = stageOf({ sync, entries, starred });
  const estimate = useTimeLeft(stage, readAt);
  const timeLeft =
    stage.name === "importing" && stage.phase.kind === "in-line"
      ? startsIn(stage.phase.startsAt, readAt ?? at)
      : estimate;
  const { semantic, retry: retrySearch } = useSemanticSearch(owner, query, {
    revision: sync === undefined ? undefined : libraryRevision(sync),
    settled: stage.name === "ready",
    known:
      first?.hits == null ? undefined : { query: first.query, ...first.hits, revision: libraryRevision(first.sync) },
  });

  const hits = hitsOf(semantic);
  const searching = keywordTerms(query).length > 0 || semantic.kind === "pending" || hits.length > 0;
  const { view, sort, setView, setSort } = useArrangement(searching, data.view);
  // A result's link carries what the page shows, including a view this browser saved, so it opens the same way
  // anywhere. The default view and sort stay out, so a link doesn't override the opener's own choice.
  const links: Params = {
    ...params,
    q: query === data.defaultQuery ? undefined : query,
    view: view === "tiles" && params.view === undefined ? undefined : view,
  };
  const trouble: Trouble | undefined =
    watch.kind !== "watching" ? watch.kind : isLoadingError ? libraryTrouble(library?.failure()) : undefined;
  const surprised = useSurprise(query, semantic.kind === "answered" && hits.length > 0);
  const page = pageView({
    audience,
    query,
    stage,
    live: liveView({
      query,
      stage,
      entries,
      find: (id) => collection?.get(id),
      sync,
      semantic,
      sort,
      at,
      timeLeft,
      whose,
    }),
    first: first ?? undefined,
    // A login with nothing synced has nothing to load, so its page shows its import before the library loads.
    library: { ready: (collection !== undefined && queried) || (empty && entries.length === 0), whole },
    trouble,
    surprised,
  });
  useEffect(() => onPose(page.pose), [onPose, page.pose]);

  const reveal = useReveal(query, page.painted);
  const butterPose = reveal.phase === "typing" ? "thinking" : reveal.phase === "settled" ? "happy" : "idle";

  const retryLibrary = () => {
    setRetrying(true);
    library?.reload().finally(() => setRetrying(false));
  };
  const tryAgain: Record<Retry, () => void> = { sync: retry, library: retryLibrary, search: retrySearch };
  const search = (next: string) => {
    setQuery(next);
    navigate({
      to: ".",
      search: (previous) => ({ ...previous, q: next === data.defaultQuery ? undefined : next }),
      replace: true,
    });
  };
  // Opening a repo adds a history entry that names the page it opened over, so Back closes the panel. The entry keeps
  // that through Forward and reloads, which a component's own state would not.
  const open: OpenResult = (result, link) => {
    setOpener(link);
    navigate({
      to: ".",
      search: (previous) => ({ ...previous, repo: `${result.owner}/${result.name}` }),
      state: { panelOver: router.state.location.state.__TSR_index },
    });
  };
  const close = () => {
    if (closesBack(router.state.location.state)) router.history.back();
    else navigate({ to: ".", search: (previous) => ({ ...previous, repo: undefined }), replace: true });
  };
  // The panel keeps the last repo it showed while it slides closed. Until the library loads, the repo a shared link
  // opens comes from the server.
  const [panelRepo, setPanelRepo] = useState(params.repo);
  if (params.repo !== undefined && params.repo !== panelRepo) setPanelRepo(params.repo);
  const named = (repo: { readonly owner: string; readonly name: string }) => `${repo.owner}/${repo.name}` === panelRepo;
  const entry =
    panelRepo === undefined
      ? undefined
      : (entries.find(named) ??
        (data.opened !== null && named(data.opened) ? { ...data.opened, text: searchText(data.opened) } : undefined));
  const hit = hits.find((result) => result.id === entry?.id);
  const opened = entry && (hit ? withReply(entry, hit) : entry);

  const body = (current: Body) => {
    switch (current.kind) {
      case "trouble":
        return (
          <EmptyTile pose={page.pose} heading={current.heading} body={current.detail}>
            {current.retry && (
              <Button
                variant="primary"
                size="lg"
                className="mt-2"
                disabled={retrying}
                onClick={tryAgain[current.retry]}
              >
                Try again
              </Button>
            )}
          </EmptyTile>
        );
      case "loading":
        return (
          <Waiting view={view} searching={current.searching} arriving={current.arriving} landing={policy.landing} />
        );
      case "library":
        return (
          <LibraryView
            entries={entries}
            at={at}
            view={view}
            sort={sort}
            search={links}
            arriving={current.arriving}
            pose={page.pose}
            butter={!policy.landing}
            onOpen={open}
          />
        );
      case "results":
        return (
          <Results
            view={view}
            groups={withLinks(current.groups, links)}
            hero={policy.landing ? "card" : "butter"}
            onOpen={open}
          />
        );
      case "empty-reading":
        return <EmptyTile pose={page.pose} ring={current.ring} {...current.copy} />;
      case "empty":
        return (
          <EmptyTile pose={page.pose} {...current.copy}>
            <RephraseChips phrases={current.phrases} onPick={search} />
          </EmptyTile>
        );
      case "failed":
        return <EmptyTile pose={page.pose} {...current.copy} />;
    }
  };

  const { retry: again, ...status } = page.status;

  return (
    <>
      {page.hero && <Hero {...page.hero} pose={butterPose} />}
      <div data-reveal-tile className="contents">
        <SearchTile
          query={reveal.typed ?? query}
          onQueryChange={search}
          label={`Search ${theirs(whose)}`}
          placeholder={page.placeholder}
          className={dock}
          owner={policy.ownerPill ? <OwnerPill audience={audience} config={data.config} /> : undefined}
          progress={page.progress}
          status={
            <StatusLine
              {...status}
              action={
                again && (
                  <Button
                    variant="bare"
                    size="default"
                    className="max-sm:h-[18px] max-sm:px-0 max-sm:text-sm max-sm:after:-inset-x-2 max-sm:after:-inset-y-2.5 max-sm:hover:bg-transparent"
                    onClick={tryAgain[again]}
                  >
                    try again
                  </Button>
                )
              }
            />
          }
          controls={
            <>
              {/* With an owner pill in the phone strip there is no room for the sort trigger, so phones sort by the
                  default there. */}
              <div className={policy.ownerPill ? "contents max-sm:hidden" : "contents"}>
                <SortMenu value={sort} onValueChange={setSort} options={searching ? searchSorts : librarySorts} />
              </div>
              <ViewToggle value={view} onValueChange={setView} />
            </>
          }
        />
      </div>
      {policy.landing && (
        <TryChips
          examples={data.config.examples.filter((example) => normalize(example) !== normalize(query))}
          onPick={search}
        />
      )}
      <div data-reveal-results className="flex flex-col gap-gap max-sm:pb-44">
        {body(page.body)}
      </div>
      <RepoPanel
        repo={opened && toDetail(opened, at, whose)}
        open={params.repo !== undefined && opened !== undefined}
        onOpenChange={(next) => {
          if (!next) close();
        }}
        returnFocus={opener}
      />
    </>
  );
}
