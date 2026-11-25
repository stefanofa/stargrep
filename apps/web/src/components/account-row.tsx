import { Tile } from "@stargrep/ui";
import { Link } from "@tanstack/react-router";
import { signOut } from "../lib/auth-client.ts";

const item =
  "flex items-center justify-between gap-3 font-sans text-base font-medium max-sm:border-t-[1.5px] max-sm:border-muted max-sm:py-3 max-sm:text-foreground";
const link = `${item} sm:rounded-sm sm:text-accent-strong sm:underline-offset-4 sm:hover:underline`;
const arrow = (
  <span aria-hidden className="text-muted-foreground sm:hidden">
    →
  </span>
);

// The end of your own page, where the account lives: whom you follow, the GitHub import, and signing out. A desktop
// gets one quiet row, a phone a short list.
export function AccountRow() {
  return (
    <Tile
      variant="quiet"
      className="flex items-center gap-7 px-tile py-[18px] max-sm:flex-col max-sm:items-stretch max-sm:gap-0 max-sm:px-gap max-sm:py-1.5"
    >
      <h2 className="font-sans text-label font-semibold text-muted-foreground uppercase max-sm:pt-3 max-sm:pb-1.5">
        only you see this
      </h2>
      <Link to="/following/people" className={link}>
        <span>
          people you follow<span className="max-sm:hidden"> →</span>
        </span>
        {arrow}
      </Link>
      <Link to="/following/people" search={{ pick: true }} className={link}>
        import follows from GitHub
        {arrow}
      </Link>
      <button
        type="button"
        onClick={() => {
          signOut().catch(() => {});
        }}
        className={`${item} sm:ml-auto sm:h-9 sm:rounded-full sm:bg-card sm:px-4 sm:text-meta sm:font-semibold sm:transition-colors sm:duration-120 sm:hover:bg-muted`}
      >
        sign out
      </button>
    </Tile>
  );
}
