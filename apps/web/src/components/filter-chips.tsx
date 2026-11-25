import { Chip, Skeleton } from "@stargrep/ui";
import { Link } from "@tanstack/react-router";
import type { Facets } from "../lib/library-filter.ts";
import { formatCount } from "../lib/whose.ts";

const languagesShown = 3;
const chip = "h-[30px] shrink-0 px-3 sm:px-[13px]";
const waiting = ["w-[72px]", "w-[60px]", "w-[84px]"];

// The answer's filters in the strip: all, the languages it holds most, and its archived repos, each with how many of
// the answer it keeps. A chip that is on stays, so a shared link to its filter can take it back off. Undefined facets
// mean the answer is still loading.
export function FilterChips({
  facets,
  lang,
  archived,
}: {
  facets: Facets | undefined;
  lang: string | undefined;
  archived: boolean;
}) {
  const languages = facets?.languages.slice(0, languagesShown) ?? [];
  if (lang !== undefined && !languages.some(([name]) => name === lang))
    languages.push([lang, facets?.languages.find(([name]) => name === lang)?.[1] ?? 0]);
  if (facets !== undefined && languages.length === 0 && facets.archived === 0 && !archived) return null;
  return (
    <nav aria-label="Filter stars" className="flex items-center gap-2">
      <Chip
        className={chip}
        active={lang === undefined && !archived}
        render={
          <Link
            to="."
            search={(previous) => ({ ...previous, lang: undefined, archived: undefined })}
            activeOptions={{ explicitUndefined: true }}
          />
        }
      >
        all
      </Chip>
      {facets === undefined &&
        waiting.map((width) => <Skeleton key={width} className={`h-[30px] rounded-full ${width}`} />)}
      {languages.map(([name, count]) => (
        <Chip
          key={name}
          className={chip}
          active={lang === name}
          render={<Link to="." search={(previous) => ({ ...previous, lang: name })} />}
        >
          {name} {formatCount(count)}
        </Chip>
      ))}
      {facets !== undefined && (facets.archived > 0 || archived) && (
        <Chip
          className={chip}
          active={archived}
          render={<Link to="." search={(previous) => ({ ...previous, archived: true })} />}
        >
          archived {formatCount(facets.archived)}
        </Chip>
      )}
    </nav>
  );
}
