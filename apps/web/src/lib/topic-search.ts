// The search a topic page asks for its ?q=. The topic's card reads the answer cache with the same input, because the
// limit is part of the cache key, so a card that asked for another limit would miss the page's answer.
export const topicSearchLimit = 24;

export const topicSearch = (topic: string, q: string) =>
  ({ scope: { kind: "topic", topic }, q, limit: topicSearchLimit }) as const;
