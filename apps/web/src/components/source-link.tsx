import { formatStars } from "@stargrep/ui";
import { capture } from "../lib/analytics.ts";
import { stargrepRepoUrl } from "../lib/github-star.ts";
import { textLinkClass } from "./external-text-link.tsx";

// A count of a few stars reads as a project nobody uses, so the link shows a count only from this many up.
export const fewestStarsShown = 10;

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
      {stars !== null && stars >= fewestStarsShown && (
        <>
          {` ${formatStars(stars)}`}
          <span className="sr-only"> stars</span>
        </>
      )}
    </a>
  );
}
