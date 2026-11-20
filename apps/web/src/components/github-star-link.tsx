import { buttonVariants, formatStars } from "@stargrep/ui";
import type { ReactNode } from "react";
import { capture } from "../lib/analytics.ts";
import { stargrepRepoUrl } from "../lib/github-star.ts";
import { GitHubMark } from "./github-mark.tsx";

// A count of a few stars reads as a project nobody uses, so the link shows a count only from this many up.
export const fewestStarsShown = 10;

// The count comes with the session the server rendered and never changes on the page, so it never shifts the header.
// Phones keep the mark and the count, and the word joins from the small breakpoint up.
export function GitHubStarLink({ stars }: { stars: number | null }) {
  return (
    <a
      href={stargrepRepoUrl}
      target="_blank"
      rel="noopener"
      aria-label="star stargrep on GitHub"
      onClick={() => capture("github_star_clicked")}
      className={buttonVariants({ variant: "ghost", className: "max-sm:px-3" })}
    >
      <GitHubMark className="size-4" />
      <span className="max-sm:hidden">star</span>
      {stars !== null && stars >= fewestStarsShown && (
        <span className="font-display tabular-nums">{formatStars(stars)}</span>
      )}
    </a>
  );
}

// The header's right end: the star link, then the account menu for a signed-in viewer.
export function HeaderEnd({ star, account }: { star: ReactNode; account: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      {star}
      {account}
    </div>
  );
}
