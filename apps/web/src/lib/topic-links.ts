import { useEffect, useState } from "react";
import { api } from "./rpc.ts";

// The topic page each tag leads to, or null for a tag without one, as the API answered. Every list on the page shares it,
// so a tag is asked about once.
const known = new Map<string, string | null>();
const perAsk = 50;

const ask = async (tags: ReadonlyArray<string>) => {
  const unknown = [...new Set(tags)].filter((tag) => !known.has(tag));
  for (let start = 0; start < unknown.length; start += perAsk) {
    const asked = unknown.slice(start, start + perAsk);
    const { pages } = await api().topicPages({ topics: asked });
    const found = new Map(pages.map(({ topic, page }) => [topic, page]));
    for (const tag of asked) known.set(tag, found.get(tag) ?? null);
  }
};

// The topic page a tag leads to, once the API has said which of the tags have one. Until then, or when it can't say, a
// tag leads nowhere and shows as text.
export const useTopicPages = (tags: ReadonlyArray<string>) => {
  const key = tags.join(" ");
  const [, answered] = useState(0);
  useEffect(() => {
    const asked = key === "" ? [] : key.split(" ");
    if (asked.every((tag) => known.has(tag))) return;
    let current = true;
    ask(asked).then(
      () => current && answered((count) => count + 1),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [key]);
  return (tag: string) => known.get(tag) ?? null;
};
