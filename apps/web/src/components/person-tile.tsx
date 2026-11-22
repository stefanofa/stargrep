import { Skeleton, Tile } from "@stargrep/ui";
import { starredOn } from "../lib/present.ts";
import { formatCount, starCount } from "../lib/whose.ts";
import { ExternalTextLink } from "./external-text-link.tsx";

// What the tile says about the person's stars. It waits for the library, says the stars are arriving while they
// import, and says nothing when the page is in trouble, since the tile below explains.
export type PersonStars =
  | { readonly kind: "loading" }
  | { readonly kind: "arriving" }
  | { readonly kind: "unsaid" }
  | { readonly kind: "count"; readonly count: number; readonly last: string | undefined };

function Facts({ stars, login }: { stars: PersonStars; login: string }) {
  return (
    <p className="font-sans text-meta text-muted-foreground sm:text-base">
      {stars.kind === "loading" && (
        <>
          <Skeleton className="inline-block h-[0.8em] w-40 align-middle" />
          {" · "}
        </>
      )}
      {stars.kind === "arriving" && "stars arriving · "}
      {stars.kind === "count" && (
        <>
          <span className="font-display text-xl font-semibold text-foreground tabular-nums sm:text-2xl">
            {formatCount(stars.count)}
          </span>
          {stars.count === 1 ? " star · " : " stars · "}
          {stars.last !== undefined && `last starred ${starredOn(stars.last)} · `}
        </>
      )}
      <ExternalTextLink href={`https://github.com/${login}`}>on GitHub ↗</ExternalTextLink>
    </p>
  );
}

// The person whose stars the page shows, as the share card shows them: avatar, handle, how many stars, the last one,
// and their GitHub profile. A login GitHub doesn't know gets its handle alone.
export function PersonTile({
  login,
  known,
  stars,
  shared,
}: {
  login: string;
  known: boolean;
  stars: PersonStars;
  // How many stars a signed-in viewer shares with them.
  shared?: number | undefined;
}) {
  return (
    <Tile className="flex min-w-0 flex-1 items-center gap-4 py-5 pr-5 pl-5 sm:gap-6 sm:pt-tile-top sm:pr-6 sm:pb-6 sm:pl-tile-lg">
      {/* A plain image paints from the server's HTML, where an avatar that waits for its image would paint initials. */}
      {known ? (
        <img
          src={`https://github.com/${login}.png?size=192`}
          alt=""
          width={96}
          height={96}
          className="size-16 shrink-0 rounded-full bg-accent-soft outline-1 -outline-offset-1 outline-image-edge sm:size-24"
        />
      ) : (
        <span
          aria-hidden
          className="flex size-16 shrink-0 items-center justify-center rounded-full bg-avatar-2 font-display text-2xl font-semibold text-ink sm:size-24 sm:text-3xl"
        >
          {login.slice(0, 2).toLowerCase()}
        </span>
      )}
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="truncate font-display text-[28px] leading-8 font-semibold tracking-snug sm:text-[40px] sm:leading-11 sm:tracking-tight">
          {`@${login}`}
        </h1>
        {known && <Facts stars={stars} login={login} />}
        {shared !== undefined && (
          <p className="mt-1 self-start rounded-full bg-accent-soft px-3.5 py-1.5 font-sans text-meta font-medium">
            {shared === 0 ? "you share no stars" : `you share ${starCount(shared)}`}
          </p>
        )}
      </div>
    </Tile>
  );
}
