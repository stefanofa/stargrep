import type { PipPose } from "@stargrep/ui";
import { Link, useLoaderData } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useDiscoverSegment } from "../lib/discover.ts";
import { ExternalTextLink, textLinkClass } from "./external-text-link.tsx";
import { type Place, SiteHeader, TabBar } from "./site-nav.tsx";
import { SourceLink } from "./source-link.tsx";

// On phones the tab bar covers the bottom of the screen, and a docked search field sits above it, 66px with its fade, so
// the page ends with room for both below the footer. styles.css sets --tab-bar.
const room = {
  none: "",
  bar: "max-sm:pb-[calc(var(--tab-bar)+32px)]",
  dock: "max-sm:pb-[calc(var(--tab-bar)+96px)]",
} as const;

// The frame every page shares: the header, the page, and the footer, with the phone's tab bar when the page has one.
export function Frame({
  header,
  bar,
  dock = false,
  repoStars = null,
  children,
}: {
  header: ReactNode;
  bar?: ReactNode;
  dock?: boolean | undefined;
  repoStars?: number | null;
  children: ReactNode;
}) {
  return (
    <div
      className={`mx-auto flex min-h-dvh w-full max-w-page flex-col gap-[30px] px-4 pt-6 pb-16 sm:pt-[30px] min-[1232px]:px-0 ${room[bar === undefined ? "none" : dock ? "dock" : "bar"]}`}
    >
      <header className="flex min-h-12 items-center justify-between gap-5">{header}</header>
      <main className="flex flex-col gap-gap">{children}</main>
      <footer className="mt-auto flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-1 font-sans text-meta text-muted-foreground">
        <p>
          made by <ExternalTextLink href="https://x.com/stefanofa">@stefanofa</ExternalTextLink>
        </p>
        <nav aria-label="about stargrep">
          <ul className="flex flex-wrap gap-x-[22px] gap-y-2 max-sm:gap-x-[18px]">
            <li>
              <SourceLink stars={repoStars} />
            </li>
            <li>
              <Link to="/developers" className={textLinkClass}>
                api and mcp
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
      {bar}
    </div>
  );
}

// A page in one of the places, or in none. The session the root loaded says who is looking.
export function Page({
  here,
  pose,
  dock,
  children,
}: {
  here?: Place | undefined;
  pose?: PipPose | undefined;
  dock?: boolean | undefined;
  children: ReactNode;
}) {
  const { viewer, repoStars, discover } = useLoaderData({ from: "__root__" });
  const at = { here, segment: useDiscoverSegment(discover) };
  return (
    <Frame
      header={<SiteHeader viewer={viewer} at={at} pose={pose} />}
      bar={<TabBar viewer={viewer} at={at} />}
      dock={dock}
      repoStars={repoStars}
    >
      {children}
    </Frame>
  );
}
