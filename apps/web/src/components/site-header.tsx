import { type PipPose, Skeleton } from "@stargrep/ui";
import { Link, type LinkProps } from "@tanstack/react-router";
import { Suspense } from "react";
import { Account } from "../lib/engine.ts";
import type { Viewer } from "../lib/rpc.ts";
import { GitHubStarLink } from "./github-star-link.tsx";
import { SignInButton } from "./sign-in-button.tsx";
import { Wordmark } from "./wordmark.tsx";

interface NavLink {
  readonly label: string;
  readonly link: LinkProps;
  // Who sees the link. A signed-out visitor's / is the demo, so "your stars" only exists once signed in.
  readonly for: "everyone" | "signed-in";
  // Phones keep only the links the wordmark doesn't already cover.
  readonly phones: boolean;
}

// The header's places. People joins here for everyone, phones included, once /people exists.
const places: ReadonlyArray<NavLink> = [
  {
    label: "your stars",
    link: { to: "/{-$login}", params: { login: undefined } },
    for: "signed-in",
    phones: false,
  },
];

function Places({ signedIn }: { signedIn: boolean }) {
  const shown = places.filter((place) => place.for === "everyone" || signedIn);
  if (shown.length === 0) return null;
  return (
    <nav
      aria-label="Main"
      className={
        shown.some((place) => place.phones)
          ? "flex items-center rounded-full bg-card p-1"
          : "flex items-center rounded-full bg-card p-1 max-sm:hidden"
      }
    >
      <ul className="flex items-center">
        {shown.map((place) => (
          <li key={place.label} className={place.phones ? undefined : "max-sm:hidden"}>
            <Link
              {...place.link}
              activeOptions={{ exact: true, includeSearch: false }}
              className="flex h-9 items-center rounded-full px-[18px] font-sans text-meta font-medium text-muted-foreground transition-[color,background-color] duration-120 hover:text-foreground aria-[current=page]:bg-accent aria-[current=page]:font-semibold aria-[current=page]:text-ink"
            >
              {place.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

// Every page's header: the wordmark and the places on the left, the star link and the account on the right. A visitor
// gets a sign-in here on every page, so it never scrolls away with the hero. The account menu needs Base UI, so it
// rides in the engine chunk.
export function SiteHeader({
  viewer,
  repoStars,
  pose,
}: {
  viewer: Viewer | null;
  repoStars: number | null;
  pose?: PipPose | undefined;
}) {
  return (
    <>
      <div className="flex min-w-0 items-center gap-4">
        <Wordmark pose={pose ?? "idle"} />
        <Places signedIn={viewer !== null} />
      </div>
      <div className="flex items-center gap-3">
        {/* A visitor's phone header has room for the wordmark and sign-in, so the star link waits for wider screens. */}
        <GitHubStarLink stars={repoStars} className={viewer === null ? "max-sm:hidden" : undefined} />
        {viewer === null ? (
          <SignInButton variant="primary" mark={false} label="sign in" />
        ) : (
          <Suspense fallback={<Skeleton className="size-11 shrink-0" />}>
            <Account login={viewer.login} avatarUrl={viewer.avatarUrl} />
          </Suspense>
        )}
      </div>
    </>
  );
}
