// GitHub keeps topics in lowercase letters, digits, and hyphens, and an address may carry another spelling that leads to
// one, such as next.js.
export const topicPattern = /^[a-z0-9][a-z0-9.+#-]{0,49}$/;

// An address's ?topic=, kept when it could name a topic.
export const topicSearch = (search: Record<string, unknown>): { topic?: string | undefined } =>
  typeof search.topic === "string" && topicPattern.test(search.topic) ? { topic: search.topic } : {};

export const topicPath = (topic: string) => `/topics/${encodeURIComponent(topic)}`;
