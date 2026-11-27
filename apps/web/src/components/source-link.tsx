import { buttonVariants, cn, formatStars } from "@stargrep/ui";
import { capture } from "../lib/analytics.ts";
import { stargrepRepoUrl } from "../lib/github-star.ts";
import { textLinkClass } from "./external-text-link.tsx";
import { GitHubMark } from "./github-mark.tsx";

// A count of a few stars reads as a project nobody uses, so the link shows a count only from this many up.
export const fewestStarsShown = 10;

const counted = (stars: number | null): stars is number => stars !== null && stars >= fewestStarsShown;

// The header's link to Stargrep's repo, on screens wide enough to hold it beside the places. It matches the places'
// pill in height and type, and the count reads in the display face, as star counts do across the app.
export function StarLink({ stars }: { stars: number | null }) {
  return (
    <a
      href={stargrepRepoUrl}
      target="_blank"
      rel="noopener"
      aria-label={counted(stars) ? `star stargrep on GitHub, ${formatStars(stars)} stars` : "star stargrep on GitHub"}
      onClick={() => capture("github_star_clicked")}
      className={cn(
        buttonVariants({ variant: "ghost", size: "lg" }),
        "px-4 text-meta font-medium text-secondary-foreground hover:text-foreground max-sm:hidden",
      )}
    >
      <GitHubMark className="size-4" />
      star
      {counted(stars) && <span className="font-display text-foreground tabular-nums">{formatStars(stars)}</span>}
    </a>
  );
}

// The footer's link to Stargrep's repo. The count comes with the session the server rendered and never changes on the
// page, so it never shifts the footer.
export function SourceLink({ stars }: { stars: number | null }) {
  return (
    <a
      href={stargrepRepoUrl}
      target="_blank"
      rel="noopener"
      onClick={() => capture("github_star_clicked")}
      className={textLinkClass}
    >
      source <span aria-hidden>★</span>
      {counted(stars) && (
        <>
          {` ${formatStars(stars)}`}
          <span className="sr-only"> stars</span>
        </>
      )}
    </a>
  );
}
