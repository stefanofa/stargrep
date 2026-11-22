// Searches to start with on a topic's page, for the topics we post first. Each was checked by reading its top results,
// so no other topic gets any.
export const topicExamples: Readonly<Record<string, ReadonlyArray<string>>> = {
  nextjs: ["auth libraries", "self-hosting", "apps to learn from"],
  astro: ["blog themes", "documentation sites", "image optimization"],
  typescript: ["runtime validation", "orm for postgres", "monorepo tooling"],
};

// GitHub keeps topics in lowercase letters, digits, and hyphens, and an address may carry another spelling that leads to
// one, such as next.js.
export const topicPattern = /^[a-z0-9][a-z0-9.+#-]{0,49}$/;

export const topicPath = (topic: string) => `/topics/${encodeURIComponent(topic)}`;
