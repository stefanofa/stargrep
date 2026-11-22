import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { stargrepRepoUrl } from "../lib/github-star.ts";
import { ExternalTextLink, textLinkClass } from "./external-text-link.tsx";

// A docked page keeps a search tile fixed to the bottom of a phone's screen, so on phones it ends with room for the tile
// below the footer, or the tile would cover the footer at the end of the page.
const docked = "max-sm:pb-[calc(160px+max(16px,env(safe-area-inset-bottom)))]";

export function Page({ header, dock = false, children }: { header: ReactNode; dock?: boolean; children: ReactNode }) {
  return (
    <div
      className={`mx-auto flex min-h-dvh w-full max-w-page flex-col gap-[30px] px-4 pt-6 pb-16 sm:pt-[30px] min-[1232px]:px-0 ${dock ? docked : ""}`}
    >
      <header className="flex min-h-11 items-center justify-between gap-4">{header}</header>
      <main className="flex flex-col gap-gap">{children}</main>
      <footer className="mt-auto flex flex-wrap items-center justify-between gap-x-6 gap-y-3 font-sans text-meta text-muted-foreground">
        <p>
          made by <ExternalTextLink href="https://x.com/stefanofa">@stefanofa</ExternalTextLink>
        </p>
        <nav aria-label="about stargrep">
          <ul className="flex flex-wrap gap-x-5 gap-y-2">
            <li>
              <Link to="/topics" className={textLinkClass}>
                topics
              </Link>
            </li>
            <li>
              <ExternalTextLink href={stargrepRepoUrl}>source</ExternalTextLink>
            </li>
            <li>
              <Link to="/developers" hash="api" className={textLinkClass}>
                api
              </Link>
            </li>
            <li>
              <Link to="/developers" hash="mcp" className={textLinkClass}>
                mcp
              </Link>
            </li>
            <li>
              <Link to="/privacy" className={textLinkClass}>
                privacy
              </Link>
            </li>
            <li>
              <Link to="/terms" className={textLinkClass}>
                terms
              </Link>
            </li>
          </ul>
        </nav>
      </footer>
    </div>
  );
}
