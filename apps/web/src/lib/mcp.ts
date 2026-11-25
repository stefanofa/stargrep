export const mcpUrl = "https://stargrep.com/mcp";

// Every tool the MCP server lists. A test holds this to the public procedures in the API contract.
export const mcpTools = [
  { name: "search", does: "searches one login's stars, or one topic's repos, in plain language" },
  { name: "triggerSync", does: "imports a login's stars, so search can find them" },
  { name: "syncStatus", does: "says whether a login is synced and how many of its stars stargrep has read" },
  { name: "stars", does: "lists a login's synced stars, newest first" },
  { name: "starLanguages", does: "counts a login's synced stars by language" },
  { name: "taste", does: "counts a login's synced stars by month, by day for a year, by language and by topic" },
  { name: "getRepo", does: "reads one repo, with its summary" },
  {
    name: "similarRepos",
    does: "finds the repos nearest one repo, in a login's stars and ones it hasn't starred, and who on the people list starred it",
  },
  { name: "lookupFacets", does: "finds languages, kinds, and subjects to narrow a search with" },
  { name: "people", does: "lists well-known developers whose stars stargrep has synced" },
  { name: "similarPeople", does: "finds the people on that list with stars most like a login's" },
  { name: "listTopics", does: "lists the GitHub topics stargrep has a page for" },
  { name: "topic", does: "reads a topic's page: its repos developers star most, related topics, and who stars them" },
  { name: "topicPages", does: "says which of some GitHub topics have a page" },
  { name: "config", does: "names the demo account and its example queries" },
] as const;
