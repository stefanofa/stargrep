import { buttonVariants, cn, RepoIcon, Tile } from "@stargrep/ui";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { capture } from "../lib/analytics.ts";
import { when, withinWeek } from "../lib/follow-time.ts";
import { repoVisual } from "../lib/repo-visual.ts";
import { api, type FeedRepo, type FollowingFeed } from "../lib/rpc.ts";
import { wallNow } from "../lib/wall-clock.ts";

const shown = 3;

// Who starred a feed repo, in a few words: "5 you follow" or "@t3dotgg, @steipete", then when the latest did.
export const starrersLine = (repo: FeedRepo, at: number) => {
  const [latest] = repo.starredBy;
  const who =
    repo.starredBy.length > 2
      ? `${repo.starredBy.length} you follow`
      : repo.starredBy.map((starrer) => `@${starrer.login}`).join(", ");
  return latest === undefined ? who : `${who} · ${when(latest.starredAt, at)}`;
};

// The discover row's tile on your own stars: the newest repos the people you follow starred that you haven't, and the
// way to the whole feed. It leaves the row when you follow nobody or they starred nothing new.
export function FollowingTile() {
  const [feed, setFeed] = useState<{ readonly feed: FollowingFeed; readonly at: number }>();
  useEffect(() => {
    let current = true;
    api()
      .followingFeed()
      .then(
        (answer) => {
          if (current) setFeed({ feed: answer, at: wallNow() });
        },
        () => {},
      );
    return () => {
      current = false;
    };
  }, []);
  if (feed === undefined || feed.feed.repos.length === 0) return null;
  const { repos } = feed.feed;
  const fresh = repos.some(
    (repo) => repo.starredBy[0] !== undefined && withinWeek(repo.starredBy[0].starredAt, feed.at),
  );
  return (
    <Tile className="flex min-w-0 flex-col gap-5 pt-tile-top pr-6 pb-6 pl-6 motion-safe:animate-settle lg:flex-1">
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-2xl font-semibold tracking-snug">from people you follow</h2>
        <p className="font-sans text-base text-muted-foreground">
          {fresh ? "new to you this week" : "new to you this month"}
        </p>
      </div>
      <ol aria-label="from people you follow" className="flex flex-col gap-4">
        {repos.slice(0, shown).map((repo, index) => (
          <li key={repo.id} className="min-w-0">
            <Link
              to="/following"
              onClick={() => capture("following_repo_opened", { from: "discover", position: index + 1 })}
              className="flex min-w-0 items-center gap-3 rounded-sm"
            >
              <RepoIcon visual={repoVisual(repo, "row")} />
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-display text-lg leading-6 font-semibold tracking-snug">{repo.name}</span>
                <span className="truncate font-sans text-meta font-medium text-muted-foreground">
                  {starrersLine(repo, feed.at)}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ol>
      <Link to="/following" className={cn(buttonVariants({ variant: "secondary" }), "mt-auto self-start")}>
        see all
      </Link>
    </Tile>
  );
}
