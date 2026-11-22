import { buttonVariants, Chip, cn, type OpenResult, ResultList, Skeleton, Tile, type View } from "@stargrep/ui";
import { Link } from "@tanstack/react-router";
import { capture } from "../lib/analytics.ts";
import { searchText } from "../lib/keyword.ts";
import { firstShown, listed, type NewToYouState, type Shared } from "../lib/new-to-you.ts";
import { toResult } from "../lib/present.ts";
import type { Params } from "../lib/search-params.ts";
import { formatCount } from "../lib/whose.ts";
import { RepoLine } from "./repo-line.tsx";
import { SignInButton } from "./sign-in-button.tsx";

// The new-to-you tile asks a visitor to sign in, since that is what signing in gets them here.
export type NewToYouTileState = NewToYouState | { readonly kind: "signed-out" };

const resultsOf = (found: Shared, at: number, search: Params) =>
  found.repos.map((repo) => toResult({ ...repo, text: searchText(repo) }, at, { search, flagUnread: false }));

// A repo opened from the tile or the full list counts its place in the answer, from 1.
const counted =
  (onOpen: OpenResult, position: number): OpenResult =>
  (result, opener) => {
    capture("new_to_you_opened", { position });
    onOpen(result, opener);
  };

function Placeholder() {
  return (
    <ul aria-hidden className="flex flex-col gap-4">
      {Array.from({ length: firstShown }, (_, index) => (
        <li key={index} className="flex items-center gap-3">
          <Skeleton className="size-11 shrink-0 squircle rounded-sm" />
          <span className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-3.5 w-4/5" />
          </span>
        </li>
      ))}
    </ul>
  );
}

function Found({
  found,
  login,
  at,
  search,
  onOpen,
}: {
  found: Shared;
  login: string;
  at: number;
  search: Params;
  onOpen: OpenResult;
}) {
  if (found.repos.length === 0)
    return <p className="font-sans text-base text-secondary-foreground">nothing new to you in @{login}'s stars yet.</p>;
  const results = resultsOf(found, at, search).slice(0, firstShown);
  return (
    <>
      <p className="font-sans text-base text-secondary-foreground">
        @{login}'s stars you haven't starred, closest to yours first
      </p>
      <ol aria-label="closest to yours" className="flex min-w-0 flex-col gap-4">
        {results.map((result, index) => (
          <li key={`${result.owner}/${result.name}`} className="min-w-0">
            <RepoLine result={result} line={result.reason} onOpen={counted(onOpen, index + 1)} />
          </li>
        ))}
      </ol>
      <Link
        to="."
        search={(previous) => ({ ...previous, show: "new" })}
        className={cn(buttonVariants({ variant: "primary" }), "mt-auto self-start")}
      >
        {found.repos.length < listed ? `see all ${formatCount(found.repos.length)}` : "see all"}
      </Link>
    </>
  );
}

// The page's butter tile on someone else's stars. Signed out, it is the sign-in ask, naming what signing in gets.
// Signed in, it lists the three of their stars closest to the viewer's own that the viewer hasn't starred.
export function NewToYouTile({
  state,
  login,
  at,
  search,
  onOpen,
}: {
  state: NewToYouTileState;
  login: string;
  at: number;
  search: Params;
  onOpen: OpenResult;
}) {
  return (
    <Tile
      variant="highlight"
      aria-busy={state.kind === "asking" || undefined}
      className="flex min-w-0 flex-col gap-4 pt-tile-top pr-6 pb-6 pl-6 lg:flex-1"
    >
      <h2 className="font-display text-2xl font-semibold tracking-snug">new to you</h2>
      {state.kind === "signed-out" && (
        <>
          <p className="font-sans text-base text-secondary-foreground">
            sign in and see which of @{login}'s stars you haven't starred, closest to your taste first.
          </p>
          <SignInButton variant="primary" size="lg" className="mt-auto self-start" />
        </>
      )}
      {state.kind === "asking" && <Placeholder />}
      {state.kind === "unsynced" && (
        <p className="font-sans text-base text-secondary-foreground">new to you shows once your own stars sync.</p>
      )}
      {state.kind === "found" && <Found found={state.found} login={login} at={at} search={search} onOpen={onOpen} />}
    </Tile>
  );
}

// Everything new to the viewer in someone else's stars, in place of the months, with a way back to them.
export function NewToYouList({
  found,
  login,
  at,
  view,
  search,
  onOpen,
}: {
  found: Shared;
  login: string;
  at: number;
  view: View;
  search: Params;
  onOpen: OpenResult;
}) {
  const results = resultsOf(found, at, search);
  const open: OpenResult = (result, opener) => counted(onOpen, results.indexOf(result) + 1)(result, opener);
  return (
    <section aria-label="new to you" className="flex flex-col gap-gap pt-3">
      <h2 className="flex flex-wrap items-center gap-x-2.5 gap-y-2 pl-1.5">
        <span className="font-display text-2xl font-semibold tracking-snug">new to you</span>
        <span className="font-sans text-base text-muted-foreground">
          {formatCount(results.length)} of @{login}'s stars, closest to yours first
        </span>
      </h2>
      <Chip className="self-start" render={<Link to="." search={(previous) => ({ ...previous, show: undefined })} />}>
        back to all of @{login}'s stars
      </Chip>
      <ResultList view={view} results={results} enter="tile-in" onOpen={open} />
    </section>
  );
}
