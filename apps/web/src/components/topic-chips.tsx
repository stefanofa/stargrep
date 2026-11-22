import { Chip } from "@stargrep/ui";
import { Link } from "@tanstack/react-router";
import { useTopicPages } from "../lib/topic-links.ts";

// A repo's GitHub topics in its panel. A topic with a page links to it, and any other stays text.
export function TopicChips({ topics }: { topics: ReadonlyArray<string> }) {
  const pageOf = useTopicPages(topics);
  if (topics.length === 0) return null;
  return (
    <section className="flex flex-col gap-2">
      <h3 className="font-display text-[20px] leading-6 font-semibold">topics</h3>
      <ul className="flex flex-wrap gap-1.5">
        {topics.map((topic) => {
          const page = pageOf(topic);
          return (
            <li key={topic}>
              {page === null ? (
                <span className="inline-flex h-8 items-center px-1.5 font-sans text-meta text-muted-foreground">
                  {topic}
                </span>
              ) : (
                <Chip render={<Link to="/topics/$topic" params={{ topic: page }} />}>{topic}</Chip>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
