export const mcpUrl = "https://stargrep.com/mcp";

// Every tool the MCP server lists. A test holds this to the public procedures in the API contract.
export const mcpTools = [
  { name: "search", does: "searches one login's stars in plain language" },
  { name: "triggerSync", does: "imports a login's stars, so search can find them" },
  { name: "syncStatus", does: "says whether a login is synced and how many of its stars stargrep has read" },
  { name: "stars", does: "lists a login's synced stars, newest first" },
  { name: "getRepo", does: "reads one repo, with its summary" },
  { name: "similarRepos", does: "finds the repos nearest one repo, in a login's stars and ones it hasn't starred" },
  { name: "lookupFacets", does: "finds languages, kinds, and subjects to narrow a search with" },
  { name: "config", does: "names the demo account and its example queries" },
] as const;
