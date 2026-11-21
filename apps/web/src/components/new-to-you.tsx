import { Button, type OpenResult, ResultList, type View } from "@stargrep/ui";
import { useState } from "react";
import { capture } from "../lib/analytics.ts";
import { searchText } from "../lib/keyword.ts";
import { firstShown, listed, type Shared } from "../lib/new-to-you.ts";
import { toResult } from "../lib/present.ts";
import type { Params } from "../lib/search-params.ts";
import { starCount } from "../lib/whose.ts";

const sharedLine = (shared: number, login: string) =>
  shared === 0 ? `you share no stars with @${login}` : `you share ${starCount(shared)} with @${login}`;

// The owner's stars the viewer hasn't starred, closest to the viewer's own first. They are the owner's stars, so a tile
// opens the repo panel over the library like any other. An answer as long as the most the API lists likely has more
// behind it, so its button says show more rather than see all.
export function NewToYouSection({
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
  const [all, setAll] = useState(false);
  const shown = all ? found.repos : found.repos.slice(0, firstShown);
  const results = shown.map((repo) => toResult({ ...repo, text: searchText(repo) }, at, { search, flagUnread: false }));
  const open: OpenResult = (result, opener) => {
    capture("new_to_you_opened", { position: results.indexOf(result) + 1 });
    onOpen(result, opener);
  };
  return (
    <section aria-label="new to you" className="flex flex-col gap-gap pt-3">
      <h2 className="flex flex-wrap items-baseline gap-x-2.5 pl-1.5">
        <span className="font-display text-2xl font-semibold tracking-snug">new to you</span>
        <span className="font-sans text-base text-muted-foreground tabular-nums">
          {sharedLine(found.shared, login)}
        </span>
      </h2>
      {results.length > 0 && <ResultList view={view} results={results} enter="tile-in" onOpen={open} />}
      {!all && found.repos.length > firstShown && (
        <Button variant="ghost" size="lg" className="self-center" onClick={() => setAll(true)}>
          {found.repos.length < listed ? "see all" : "show more"}
        </Button>
      )}
    </section>
  );
}
