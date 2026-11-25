import {
  Button,
  buttonVariants,
  cn,
  EmptyTile,
  type OpenResult,
  type OpenSimilar,
  type PipPose,
  RephraseChips,
  RepoPanel,
  type ResultGroup,
  Results,
  SearchTile,
  SimilarRepos,
  Skeleton,
  type Sort,
  SortMenu,
  type Stargazer,
  StarredBy,
  StatusLine,
  type View,
  ViewToggle,
} from "@stargrep/ui";
import { useLiveQuery } from "@tanstack/react-db";
import { Link, useHydrated, useNavigate, useRouter, useSearch } from "@tanstack/react-router";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import { capture } from "../lib/analytics.ts";
import { policyOf, starredOf, whoseOf } from "../lib/audience.ts";
import { keywordTerms, normalize, searchText } from "../lib/keyword.ts";
import { getLibrary, type Library } from "../lib/library-collection.ts";
import { facetOf, facetsOf, keeps, resultFacet } from "../lib/library-filter.ts";
import { askedPage, defaultQueryOf, type PageData, type PageRequest, type Session } from "../lib/page-data.ts";
import { hitsOf, liveView } from "../lib/page-view.ts";
import { useRepoParam } from "../lib/panel-history.ts";
import { personStars } from "../lib/person-stars.ts";
import {
  now,
  type SimilarRowKey,
  similarRows,
  stargazers,
  startsIn,
  strayDetail,
  toDetail,
  withLinks,
} from "../lib/present.ts";
import { withReply } from "../lib/results.ts";
import { useReveal } from "../lib/reveal.ts";
import { playSurprise } from "../lib/reveal-timing.ts";
import type { SimilarRepo } from "../lib/rpc.ts";
import { librarySorts, type Params, searchSorts, validateParams } from "../lib/search-params.ts";
import { type Body, pageView, type Retry, type Stage, stageOf } from "../lib/search-state.ts";
import { loginPage } from "../lib/stars-route.ts";
import { storedView, useStoredView } from "../lib/stored-view.ts";
import { libraryRevision, nothingSynced } from "../lib/sync-status.ts";
import { libraryTrouble, type Trouble } from "../lib/trouble.ts";
import { useSemanticSearch } from "../lib/use-semantic.ts";
import { useSimilar } from "../lib/use-similar.ts";
import { useSync } from "../lib/use-sync.ts";
import { formatCount, theirs } from "../lib/whose.ts";
import { AccountRow } from "./account-row.tsx";
import { FilterChips } from "./filter-chips.tsx";
import { FollowButton, FollowedStarredBy } from "./follows.tsx";
import { Hero, TryChips } from "./landing-hero.tsx";
import { LibraryPlaceholder, LibraryView } from "./library-view.tsx";
import { type PersonStars, PersonTile } from "./person-tile.tsx";
import { SameQuestion } from "./same-question.tsx";
import { personShared, ShareButton } from "./share-button.tsx";
import { TopicChips } from "./topic-chips.tsx";

// A navigation in the browser starts from the session the server loaded. The page reads the rest once it mounts.
export const pageFor = (request: PageRequest, { viewer, config, repoStars, site }: Session): PageData => {
  const { audience, query, defaultQuery } = askedPage(viewer, config, request);
  return {
    audience,
    repoStars,
    site,
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

function Waiting({ view, searching, hero }: { view: View; searching: boolean; hero: "card" | undefined }) {
  return searching ? (
    <Results view={view} groups={[{ key: "all", results: [], pending: 4 }]} hero={hero} />
  ) : (
    <LibraryPlaceholder view={view} />
  );
}

// The bodies that answer a search, found or not, under which "same question in" offers other people's stars.
const answered = new Set<Body["kind"]>(["results", "empty", "empty-reading"]);

// A search's results that pass the chips that are on. The placeholders still waiting for results stay.
const filtered = (groups: ReadonlyArray<ResultGroup>, pass: ReturnType<typeof keeps>) =>
  groups.map((group) => ({ ...group, results: group.results.filter((result) => pass(resultFacet(result))) }));

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
  // A navigation in the browser loads the page from the login alone, so the address it opened on decides the default
  // search here, as it did on the server.
  const [defaultQuery] = useState(() => defaultQueryOf(audience, data.config, params));
  const [query, setQuery] = useState(params.q ?? defaultQuery);
  // Typing replaces ?q= as it goes, so only Back and Forward bring another query into the search box.
  useEffect(
    () =>
      router.history.subscribe(({ location, action }) => {
        if (action.type === "PUSH" || action.type === "REPLACE") return;
        setQuery(validateParams(router.parseLocation(location).search).q ?? defaultQuery);
      }),
    [router, defaultQuery],
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
    q: query === defaultQuery ? undefined : query,
    view: view === "tiles" && params.view === undefined ? undefined : view,
  };
  const trouble: Trouble | undefined =
    watch.kind !== "watching" ? watch.kind : isLoadingError ? libraryTrouble(library?.failure()) : undefined;
  const surprised = useSurprise(query, semantic.kind === "answered" && hits.length > 0);
  // A login with nothing synced has nothing to load, so its page shows its import before the library loads.
  const libraryReady = (collection !== undefined && queried) || (empty && entries.length === 0);
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
    library: { ready: libraryReady, whole },
    trouble,
    surprised,
  });
  useEffect(() => onPose(page.pose), [onPose, page.pose]);
  const personFacts: PersonStars =
    trouble !== undefined
      ? { kind: "unsaid" }
      : stage.name === "importing"
        ? { kind: "arriving" }
        : libraryReady
          ? personStars(entries, at)
          : { kind: "loading" };
  // The count is said once, on the stars tab. While the stars import, the rail says how many have arrived instead.
  const starsCount =
    trouble !== undefined || stage.name === "importing" ? undefined : libraryReady ? (
      formatCount(entries.length)
    ) : (
      <Skeleton className="inline-block h-[0.8em] w-8 align-baseline" />
    );
  // The chips count whichever answer is on screen: the library while browsing, the results while searching.
  const libraryFacets = useMemo(
    () => (page.body.kind === "library" ? facetsOf(entries.map(facetOf)) : undefined),
    [page.body.kind, entries],
  );
  const pass = keeps(params.lang, params.archived === true);
  const resultsHero = page.hero === undefined ? undefined : "card";

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
      search: (previous) => ({ ...previous, q: next === defaultQuery ? undefined : next }),
      replace: true,
    });
  };
  const panel = useRepoParam();
  const open: OpenResult = (result, link) => {
    setOpener(link);
    panel.open(result);
  };
  // The panel keeps the last repo it showed while it slides closed. Until the library loads, the repo a shared link
  // opens comes from the server.
  const [panelRepo, setPanelRepo] = useState(params.repo);
  const [strays, setStrays] = useState<ReadonlyMap<string, SimilarRepo>>(() => new Map());
  if (params.repo !== undefined && params.repo !== panelRepo) setPanelRepo(params.repo);
  const named = (repo: { readonly owner: string; readonly name: string }) => `${repo.owner}/${repo.name}` === panelRepo;
  const entry =
    panelRepo === undefined
      ? undefined
      : (entries.find(named) ??
        (data.opened !== null && named(data.opened) ? { ...data.opened, text: searchText(data.opened) } : undefined));
  const hit = hits.find((result) => result.id === entry?.id);
  const opened = entry && (hit ? withReply(entry, hit) : entry);
  // A repo opened from the panel's rows that the library doesn't hold, such as one the login hasn't starred.
  const stray = entry === undefined && panelRepo !== undefined ? strays.get(panelRepo) : undefined;
  const detail = opened ? toDetail(opened, at, whose) : stray && strayDetail(stray, at);
  const similar = useSimilar(owner, opened?.id ?? stray?.id);
  // A repo opened from inside the panel replaces the one it showed, in the same history entry, so closing the panel
  // still goes back to the page under it.
  const openSimilar: OpenSimilar<SimilarRowKey> = (row, item) => {
    const name = `${item.owner}/${item.name}`;
    capture("similar_repo_opened", { row });
    const found =
      similar === undefined || similar === "loading"
        ? undefined
        : [...similar.inStars, ...similar.notStarred].find((repo) => `${repo.owner}/${repo.name}` === name);
    if (found !== undefined) setStrays((previous) => new Map(previous).set(name, found));
    navigate({ to: ".", search: (previous) => ({ ...previous, repo: name }), replace: true, state: true });
  };

  const openStargazer = (person: Stargazer, index: number) => {
    capture("starred_by_person_opened", { position: index + 1 });
    navigate(loginPage(person.login));
  };

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
                try again
              </Button>
            )}
            {current.offer === "people" && (
              <Link to="/people" className={cn(buttonVariants({ variant: "primary", size: "lg" }), "mt-2")}>
                see people
              </Link>
            )}
          </EmptyTile>
        );
      case "loading":
        return <Waiting view={view} searching={current.searching} hero={resultsHero} />;
      case "library":
        return (
          <LibraryView
            entries={entries}
            at={at}
            view={view}
            sort={sort}
            search={links}
            arriving={current.arriving}
            onOpen={open}
          />
        );
      case "results":
        return (
          <Results
            view={view}
            groups={withLinks(filtered(current.groups, pass), links)}
            hero={resultsHero}
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

  const again = page.status?.retry;
  const facets =
    page.body.kind === "results"
      ? facetsOf(page.body.groups.flatMap((group) => group.results).map(resultFacet))
      : libraryFacets;

  return (
    <>
      {page.hero && <Hero {...page.hero} faces={data.config.curated} pose={butterPose} />}
      {page.person && (
        <PersonTile
          login={page.person.login}
          own={audience.by === "owner"}
          known={page.person.known}
          stars={personFacts}
          tab="stars"
          counts={{ stars: starsCount }}
          share={
            page.person.known ? (
              <ShareButton
                page={personShared(page.person.login)}
                query={links.q}
                className={audience.by === "owner" ? "max-sm:size-10" : "max-sm:size-[42px]"}
              />
            ) : undefined
          }
          follow={
            page.person.known && audience.by !== "owner" && sync?.accountType !== "org" ? (
              <FollowButton login={page.person.login} signedIn={audience.by === "signed-in"} />
            ) : undefined
          }
        />
      )}
      <div data-reveal-tile className="contents">
        <SearchTile
          query={reveal.typed ?? query}
          onQueryChange={search}
          label={`Search ${theirs(whose)}`}
          placeholder={page.placeholder}
          progress={page.progress}
          status={
            <StatusLine
              label={page.status?.label}
              phoneLabel={page.status?.phoneLabel}
              action={
                again && (
                  <Button variant="bare" size="default" className="shrink-0" onClick={tryAgain[again]}>
                    try again
                  </Button>
                )
              }
            />
          }
          filters={
            (page.body.kind === "loading" || page.body.kind === "library" || page.body.kind === "results") && (
              <FilterChips facets={facets} lang={params.lang} archived={params.archived === true} />
            )
          }
          controls={
            <>
              <SortMenu value={sort} onValueChange={setSort} options={searching ? searchSorts : librarySorts} />
              <ViewToggle value={view} onValueChange={setView} />
            </>
          }
        />
      </div>
      {page.hero && (
        <TryChips
          examples={data.config.examples.filter((example) => normalize(example) !== normalize(query))}
          onPick={search}
        />
      )}
      <div data-reveal-results aria-busy={page.body.kind === "loading" || undefined} className="flex flex-col gap-gap">
        {body(page.body)}
      </div>
      {page.person?.known && searching && answered.has(page.body.kind) && (
        <SameQuestion
          login={page.person.login}
          query={query}
          own={audience.by === "owner"}
          signedIn={audience.by !== "anyone"}
        />
      )}
      <RepoPanel
        repo={detail}
        open={params.repo !== undefined && detail !== undefined}
        onOpenChange={(next) => {
          if (!next) panel.close();
        }}
        returnFocus={opener}
        starredBy={
          audience.by === "anyone" || (opened ?? stray) === undefined ? (
            <StarredBy {...stargazers(similar)} onOpen={openStargazer} />
          ) : (
            <FollowedStarredBy
              repoId={(opened ?? stray)?.id ?? 0}
              login={owner}
              {...stargazers(similar)}
              onOpen={openStargazer}
            />
          )
        }
        similar={<SimilarRepos rows={similarRows(similar, links, whose)} onOpen={openSimilar} />}
        topics={<TopicChips topics={(opened ?? stray)?.topics ?? []} />}
      />
      {audience.by === "owner" && <AccountRow />}
    </>
  );
}

// The text pages, the people page, and the sign-in problem ride in the engine chunk,
// so the landing entry never reaches Base UI. A second lazy chunk would make the bundler move React, the router, and the
// UI kit out of the landing entry into a shared chunk, which costs the landing page about 2 KB gzipped.
export { firstPeople } from "../lib/people.ts";
export { PeoplePage } from "./people-page.tsx";
export { SignInProblem } from "./sign-in-problem.tsx";
