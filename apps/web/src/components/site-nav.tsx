import { CompassIcon, cn, HomeIcon, PeopleIcon, type PipPose } from "@stargrep/ui";
import { Link, type LinkProps } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { Segment } from "../lib/discover.ts";
import type { Viewer } from "../lib/rpc.ts";
import { SignInButton } from "./sign-in-button.tsx";
import { StarLink } from "./source-link.tsx";
import { Wordmark } from "./wordmark.tsx";

// The three places every page sits in. A page names its own, or none when it belongs to someone else, such as another
// person's stars or a text page.
export type Place = "you" | "following" | "discover";

// Where each place opens. Discover opens on the segment this browser opened last.
const addresses: Record<Place, (segment: Segment) => LinkProps> = {
  you: () => ({ to: "/{-$login}", params: { login: undefined } }),
  following: () => ({ to: "/following" }),
  discover: (segment) => ({ to: `/${segment}` }),
};

const elsewhere = [
  { place: "following", Icon: PeopleIcon },
  { place: "discover", Icon: CompassIcon },
] as const;

// The router marks a link current only on its exact address, which always agrees with the page's place. The page's
// place marks the rest, such as discover on a topic's page.
const exact = { exact: true, includeSearch: false } as const;

// Where the page is, and the segment discover opens on, as every place link needs them.
export interface Whereabouts {
  readonly here: Place | undefined;
  readonly segment: Segment;
}

function PlaceLink({
  place,
  at: { here, segment },
  className,
  children,
}: {
  place: Place;
  at: Whereabouts;
  className: string;
  children: ReactNode;
}) {
  return (
    <Link
      {...addresses[place](segment)}
      activeOptions={exact}
      aria-current={place === here ? "page" : undefined}
      className={className}
    >
      {children}
    </Link>
  );
}

function Face({ viewer, className }: { viewer: Viewer; className: string }) {
  return viewer.avatarUrl === null ? (
    <span
      aria-hidden
      className={cn(
        "flex items-center justify-center rounded-full bg-avatar-2 font-sans text-label font-semibold text-ink",
        className,
      )}
    >
      {viewer.login.slice(0, 2).toUpperCase()}
    </span>
  ) : (
    <img
      src={viewer.avatarUrl}
      alt=""
      className={cn("rounded-full object-cover outline-1 -outline-offset-1 outline-image-edge", className)}
    />
  );
}

// The ring that marks your own page sits a gap away from your face, so it reads as a state, not a border.
const ring =
  "flex shrink-0 items-center justify-center rounded-full border-transparent group-aria-[current=page]:border-accent-strong";

// Every page's header. On desktop it holds the places, with you on the right: the link to star Stargrep's repo, then your
// face, ringed on your own page, or a sign-in for a visitor. Phones move the places to the tab bar and keep the sign-in,
// except at home, whose butter tile already asks, and leave the repo link to the footer.
export function SiteHeader({
  viewer,
  at,
  stars,
  pose,
}: {
  viewer: Viewer | null;
  at: Whereabouts;
  stars: number | null;
  pose?: PipPose | undefined;
}) {
  return (
    <>
      <Wordmark pose={pose ?? "idle"} />
      <nav aria-label="Main" className="flex flex-1 items-center justify-between gap-4 max-sm:hidden">
        <ul className="flex items-center gap-0.5 rounded-full bg-card p-1">
          {elsewhere.map(({ place }) => (
            <li key={place}>
              <PlaceLink
                place={place}
                at={at}
                className="flex items-center rounded-full px-3.5 py-2 font-sans text-meta font-medium text-secondary-foreground transition-[color,background-color] duration-120 hover:text-foreground aria-[current=page]:bg-accent-soft aria-[current=page]:font-semibold aria-[current=page]:text-foreground"
              >
                {place}
              </PlaceLink>
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-3">
          <StarLink stars={stars} />
          {viewer !== null && (
            <PlaceLink place="you" at={at} className="group rounded-full">
              <span className={cn(ring, "size-12 border-[2.5px] p-[3px]")}>
                <Face viewer={viewer} className="size-[38px]" />
              </span>
              <span className="sr-only">you</span>
            </PlaceLink>
          )}
        </div>
      </nav>
      {viewer === null && (
        <SignInButton
          variant="primary"
          size="lg"
          label="sign in"
          markClassName="size-[18px] max-sm:hidden"
          className={cn("max-sm:h-9 max-sm:px-3.5 max-sm:text-meta", at.here === "you" && "max-sm:hidden")}
        />
      )}
    </>
  );
}

const tab =
  "group flex h-full flex-col items-center justify-center gap-[3px] rounded-item font-sans text-tab font-medium text-muted-foreground transition-colors duration-120 hover:text-foreground focus-visible:-outline-offset-2 aria-[current=page]:font-semibold aria-[current=page]:text-foreground";
const slot = "flex size-[30px] items-center justify-center";
const icon =
  "size-6 [stroke-width:1.9] group-aria-[current=page]:fill-accent-soft group-aria-[current=page]:[stroke-width:2.1]";

// The places on a phone, along the bottom of the screen under the thumb. You come first: your face, or home for a
// visitor.
export function TabBar({ viewer, at }: { viewer: Viewer | null; at: Whereabouts }) {
  return (
    <nav
      aria-label="Main"
      data-slot="tab-bar"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card pb-[env(safe-area-inset-bottom)] sm:hidden"
    >
      <ul className="flex h-13 *:flex-1">
        <li>
          <PlaceLink place="you" at={at} className={tab}>
            {viewer === null ? (
              <span className={slot}>
                <HomeIcon className={icon} />
              </span>
            ) : (
              <span className={cn(ring, slot, "border-2 p-[2px]")}>
                <Face viewer={viewer} className="size-[22px]" />
              </span>
            )}
            {viewer === null ? "home" : "you"}
          </PlaceLink>
        </li>
        {elsewhere.map(({ place, Icon }) => (
          <li key={place}>
            <PlaceLink place={place} at={at} className={tab}>
              <span className={slot}>
                <Icon className={icon} />
              </span>
              {place}
            </PlaceLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
