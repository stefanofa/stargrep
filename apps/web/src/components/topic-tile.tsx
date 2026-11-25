import { RepoIcon, Tile } from "@stargrep/ui";
import { Link } from "@tanstack/react-router";
import { avatarOf } from "../lib/avatar.ts";
import type { Topic } from "../lib/rpc.ts";
import { loginPage } from "../lib/stars-route.ts";
import { topicPath } from "../lib/topic-path.ts";
import { topicVisual } from "../lib/topic-visual.ts";
import { formatCount } from "../lib/whose.ts";
import { ExternalTextLink, textLinkClass } from "./external-text-link.tsx";
import { ShareButton, type Shared } from "./share-button.tsx";

const topicShared = (topic: string): Shared => ({
  path: topicPath(topic),
  title: `${topic} repos on stargrep`,
  event: "topic_shared",
});

// The people into the topic, each a face and a handle that opens their stars. Phones scroll the row sideways under its
// rule and fade it out at the edge.
function People({ topic }: { topic: Topic }) {
  return (
    <section aria-label={`people into ${topic.topic}`} className="border-t-[1.5px] border-muted pt-4 sm:pt-[18px]">
      <div className="flex items-center gap-2.5 max-sm:-mx-5 max-sm:overflow-x-auto max-sm:px-5 max-sm:[mask-image:linear-gradient(to_left,transparent,#000_20px)] max-sm:[scrollbar-width:none] sm:flex-wrap">
        <h2 className="shrink-0 pr-1.5 font-sans text-meta font-normal whitespace-nowrap text-muted-foreground">
          {`people into ${topic.topic}`}
        </h2>
        <ul className="contents">
          {topic.people.map((person) => (
            <li key={person.login} className="shrink-0">
              <Link
                {...loginPage(person.login)}
                className="flex items-center gap-2 rounded-full bg-background py-1 pr-3.5 pl-1 font-sans text-meta font-semibold whitespace-nowrap transition-colors duration-120 hover:bg-accent-soft"
              >
                <img
                  src={avatarOf(person.login, 28)}
                  alt=""
                  width={28}
                  height={28}
                  loading="lazy"
                  className="size-7 shrink-0 rounded-full bg-accent-soft outline-1 -outline-offset-1 outline-image-edge"
                />
                {`@${person.login}`}
              </Link>
            </li>
          ))}
        </ul>
        <Link
          to="/people"
          className={`${textLinkClass} shrink-0 pl-1 font-sans text-meta font-medium whitespace-nowrap`}
        >
          all in discover →
        </Link>
      </div>
    </section>
  );
}

// The topic a page is about: its logo when it has one, its name as the page's heading, its own repo on GitHub, how many
// repos it holds and how many of them people here star, and share. The people into it close the tile.
export function TopicTile({ topic, query }: { topic: Topic; query: string | undefined }) {
  const { home } = topic;
  return (
    <Tile className="flex flex-col gap-4 p-5 sm:gap-5 sm:px-[30px] sm:pt-7 sm:pb-[26px]">
      <div className="flex items-center gap-3.5 sm:gap-5">
        {topic.icon !== null && <RepoIcon visual={topicVisual(topic)} size="heading" />}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 sm:gap-1">
          <div className="flex flex-wrap items-baseline gap-x-3.5 gap-y-0.5">
            <h1 className="min-w-0 font-display text-name font-semibold tracking-[-0.01em] break-all sm:text-4xl sm:tracking-tight">
              {topic.topic}
            </h1>
            {home !== null && (
              <span className="font-sans text-sm font-medium sm:text-[15px] sm:leading-5">
                <ExternalTextLink href={home.url}>{`${home.owner}/${home.name} ↗`}</ExternalTextLink>
              </span>
            )}
          </div>
          {/* Phones give each count its own line beside the logo and share. */}
          <p className="font-sans text-sm text-muted-foreground tabular-nums sm:text-[15px] sm:leading-5">
            <span className="max-sm:block">{`${formatCount(topic.repos)} repos`}</span>
            <span className="max-sm:hidden"> · </span>
            {`${formatCount(topic.ranked)} starred by people`}
            <span className="max-sm:hidden"> on stargrep</span>
          </p>
        </div>
        <ShareButton page={topicShared(topic.topic)} query={query} className="max-sm:size-[42px]" />
      </div>
      {topic.people.length > 0 && <People topic={topic} />}
    </Tile>
  );
}
