import { Dialog } from "@base-ui/react/dialog";
import { Menu } from "@base-ui/react/menu";
import {
  buttonVariants,
  cn,
  Pip,
  popupSurface,
  Skeleton,
  type Stargazer,
  type Stargazers,
  StarredBy,
  Tooltip,
} from "@stargrep/ui";
import { Link } from "@tanstack/react-router";
import { type MouseEvent, useEffect, useState, useSyncExternalStore } from "react";
import { avatarOf } from "../lib/avatar.ts";
import { on } from "../lib/follow-time.ts";
import {
  type Follows,
  follow,
  followOnReturn,
  type Refusal,
  signInToFollow,
  unfollow,
  useFollows,
} from "../lib/follows.ts";
import { api } from "../lib/rpc.ts";
import { loginHref } from "../lib/stars-route.ts";
import { after } from "../lib/wall-clock.ts";

export const refusals: Record<Refusal, string> = {
  failed: "couldn't save that. try again",
  limited: "that's a lot of changes at once. try again in a minute",
  full: "you follow 1,000 people, the most stargrep keeps",
};

function Check() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3.5">
      <path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function Caret() {
  return (
    <svg viewBox="0 0 8 8" aria-hidden className="size-2 text-muted-foreground">
      <path d="M1 2.5h6L4 6z" fill="currentColor" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-4 motion-safe:animate-spin">
      <circle cx="8" cy="8" r="6" fill="none" stroke="var(--color-accent-soft)" strokeWidth="2.5" />
      <path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="var(--color-accent)" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

const phoneQuery = "(max-width: 639px)";
const subscribePhone = (listener: () => void) => {
  const query = matchMedia(phoneQuery);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
};
const usePhone = () =>
  useSyncExternalStore(
    subscribePhone,
    () => matchMedia(phoneQuery).matches,
    () => false,
  );

// What a sign-in that came back with a follow says, with the way to the feed. Phones show it at the top, clear of the
// docked search tile.
function Toast({ logins, onDone }: { logins: ReadonlyArray<string>; onDone: () => void }) {
  useEffect(() => {
    return after(8_000, onDone);
  }, [onDone]);
  const who = logins.length === 1 ? `@${logins[0]}` : `${logins.length} people`;
  return (
    <div
      role="status"
      className="fixed inset-x-4 top-[max(16px,env(safe-area-inset-top))] z-50 mx-auto flex max-w-[560px] items-center gap-3 rounded-full bg-ink py-2 pr-2 pl-4 font-sans text-meta text-[#ffffff] shadow-panel motion-safe:animate-settle sm:top-auto sm:bottom-8"
    >
      <Pip pose="happy" size={24} className="shrink-0" />
      <span className="min-w-0 flex-1">{`you follow ${who} now. their new stars show in following.`}</span>
      <Link
        to="/following"
        className="shrink-0 rounded-full bg-[#ffffff] px-4 py-2 font-semibold whitespace-nowrap text-ink transition-colors duration-120 hover:bg-accent-soft"
      >
        open following
      </Link>
    </div>
  );
}

// Applies a follow a sign-in came back with, wherever the first follow control on the page mounts, and says so.
function useReturned(signedIn: boolean) {
  const [followed, setFollowed] = useState<ReadonlyArray<string>>([]);
  useEffect(() => {
    if (!signedIn) return;
    void followOnReturn().then((logins) => {
      if (logins !== undefined && logins.length > 0) setFollowed(logins);
    });
  }, [signedIn]);
  return followed.length === 0 ? null : <Toast logins={followed} onDone={() => setFollowed([])} />;
}

function RefusalLine({ refusal }: { refusal: Refusal | undefined }) {
  if (refusal === undefined) return null;
  return (
    <p role="status" className="font-sans text-sm text-destructive">
      {refusals[refusal]}
    </p>
  );
}

// On phones a person's follow fills its row under the person, 42px tall.
const phoneWide = "max-sm:h-[42px] max-sm:w-full max-sm:text-meta";

// Unfollowing from someone's page asks first, and says they aren't told. A menu on wide screens, a sheet on phones.
function Unfollow({ login, follows }: { login: string; follows: Follows }) {
  const phone = usePhone();
  const trigger = cn(buttonVariants({ variant: "secondary", size: "lg" }), "data-popup-open:bg-accent/30", phoneWide);
  const label = (
    <>
      <Check />
      following
      <Caret />
    </>
  );
  if (phone) {
    const since = follows.since(login);
    return (
      <Dialog.Root>
        <Dialog.Trigger className={trigger} aria-label={`following @${login}, change`}>
          {label}
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-40 bg-scrim transition-opacity duration-160 data-ending-style:opacity-0 data-starting-style:opacity-0" />
          <Dialog.Popup className="fixed inset-x-2 bottom-[max(8px,env(safe-area-inset-bottom))] z-50 flex flex-col gap-3 squircle rounded-tile bg-card p-gap shadow-panel transition-[translate,opacity] duration-220 ease-out data-ending-style:translate-y-full data-starting-style:translate-y-full motion-reduce:transition-opacity">
            <div className="flex items-center gap-3">
              <img src={avatarOf(login, 40)} alt="" width={40} height={40} className="size-10 rounded-full" />
              <div className="flex min-w-0 flex-col">
                <Dialog.Title className="truncate font-display text-lg leading-6 font-semibold">{`@${login}`}</Dialog.Title>
                <Dialog.Description className="font-sans text-sm text-muted-foreground">
                  {since === undefined ? "they aren't told" : `following since ${on(since)} · they aren't told`}
                </Dialog.Description>
              </div>
            </div>
            <Dialog.Close
              className={buttonVariants({ variant: "primary", size: "lg" })}
              onClick={() => void unfollow(login)}
            >
              unfollow
            </Dialog.Close>
            <Dialog.Close className={buttonVariants({ variant: "secondary", size: "lg" })}>keep following</Dialog.Close>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    );
  }
  return (
    <Menu.Root>
      <Menu.Trigger className={trigger} aria-label={`following @${login}, change`}>
        {label}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={8} align="center" className="z-50 outline-none">
          <Menu.Popup className={cn(popupSurface, "flex w-64 flex-col")}>
            <Menu.Item
              onClick={() => void unfollow(login)}
              className="flex h-10 items-center rounded-item px-3 outline-none data-highlighted:bg-muted"
            >
              {`unfollow @${login}`}
            </Menu.Item>
            <p className="px-3 pt-1 pb-2 text-sm font-normal text-muted-foreground">they aren't told</p>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

// A person's primary action on their stars page. Signed out, the same button signs in and comes back following.
export function FollowButton({ login, signedIn }: { login: string; signedIn: boolean }) {
  const follows = useFollows(signedIn);
  const toast = useReturned(signedIn);
  const control = () => {
    if (!signedIn)
      return (
        <Tooltip
          content={`sign in with GitHub to follow @${login}`}
          className={cn(buttonVariants({ variant: "primary", size: "lg" }), phoneWide)}
          onClick={() => void signInToFollow([login])}
        >
          + follow
        </Tooltip>
      );
    if (!follows.ready) return <Skeleton className={cn("h-11 w-[120px] rounded-full", phoneWide)} />;
    if (follows.isPending(login) && follows.isFollowing(login))
      return (
        <span
          role="status"
          className={cn(buttonVariants({ variant: "secondary", size: "lg" }), "text-muted-foreground", phoneWide)}
        >
          <Spinner />
          following
        </span>
      );
    if (follows.isFollowing(login)) return <Unfollow login={login} follows={follows} />;
    return (
      <button
        type="button"
        className={cn(buttonVariants({ variant: "primary", size: "lg" }), phoneWide)}
        onClick={() => void follow([login])}
      >
        + follow
      </button>
    );
  };
  return (
    <div className="flex shrink-0 flex-col items-end gap-1.5 max-sm:items-stretch">
      {control()}
      <RefusalLine refusal={follows.refusal(login)} />
      {toast}
    </div>
  );
}

// The small pill on cards and in lists, its own tab stop. Unfollowing here is direct, and the pill is its own undo.
export function FollowPill({ login, signedIn }: { login: string; signedIn: boolean }) {
  const follows = useFollows(signedIn);
  const toast = useReturned(signedIn);
  const following = follows.isFollowing(login);
  if (signedIn && !follows.ready) return <Skeleton className="relative z-10 h-9 w-[92px] rounded-full" />;
  return (
    <span className="relative z-10 flex flex-col items-start gap-1">
      <button
        type="button"
        aria-pressed={following}
        aria-label={following ? `following @${login}, unfollow` : `follow @${login}`}
        disabled={follows.isPending(login)}
        className={buttonVariants({ variant: following ? "muted" : "secondary" })}
        onClick={(event: MouseEvent) => {
          event.preventDefault();
          if (!signedIn) void signInToFollow([login]);
          else if (following) void unfollow(login);
          else void follow([login]);
        }}
      >
        {following ? (
          <>
            <Check />
            following
          </>
        ) : (
          "+ follow"
        )}
      </button>
      <RefusalLine refusal={follows.refusal(login)} />
      {toast}
    </span>
  );
}

// A starter pack: one click follows a topic's people. Following all of them, it turns into a quiet confirmation.
export function FollowAll({ logins, signedIn }: { logins: ReadonlyArray<string>; signedIn: boolean }) {
  const follows = useFollows(signedIn);
  const toast = useReturned(signedIn);
  const others = logins.filter((login) => !follows.isFollowing(login));
  const refusal = logins.map(follows.refusal).find((found) => found !== undefined);
  if (signedIn && !follows.ready) return <Skeleton className="h-9 w-[124px] rounded-full" />;
  const label =
    others.length === logins.length ? `+ follow all ${logins.length}` : `+ follow the other ${others.length}`;
  return (
    <div className="flex flex-col items-end gap-1">
      {others.length === 0 ? (
        <p className={cn(buttonVariants({ variant: "muted", static: true }), "pointer-events-none")}>
          <Check />
          {`following all ${logins.length}`}
        </p>
      ) : (
        <button
          type="button"
          className={buttonVariants({ variant: "primary" })}
          disabled={others.some(follows.isPending)}
          onClick={() => (signedIn ? void follow(others) : void signInToFollow(others))}
        >
          {label}
        </button>
      )}
      <RefusalLine refusal={refusal} />
      {toast}
    </div>
  );
}

// The repo panel's "also starred by" with the people the viewer follows first, as their own group.
export function FollowedStarredBy({
  repoId,
  login,
  people,
  total,
  onOpen,
}: Stargazers & {
  repoId: number;
  login: string;
  onOpen: (person: Stargazer, position: number) => void;
}) {
  const [followed, setFollowed] = useState<{ readonly repo: number; readonly found: Stargazers }>();
  useEffect(() => {
    let current = true;
    api()
      .followedStarrers({ id: repoId, login })
      .then(
        ({ people: found, total: all }) => {
          if (!current) return;
          setFollowed({
            repo: repoId,
            found: {
              total: all,
              people: found.map((person) => ({
                login: person.login,
                ...(person.avatarUrl === null ? {} : { avatarUrl: person.avatarUrl }),
                href: loginHref(person.login),
              })),
            },
          });
        },
        () => {},
      );
    return () => {
      current = false;
    };
  }, [repoId, login]);
  return (
    <StarredBy
      people={people}
      total={total}
      followed={followed?.repo === repoId ? followed.found : undefined}
      onOpen={onOpen}
    />
  );
}
