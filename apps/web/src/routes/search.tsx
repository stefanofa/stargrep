import { createFileRoute, redirect } from "@tanstack/react-router";
import { validateParams } from "../lib/search-params.ts";

// Search lived here before the home page became the search page. Old links and bookmarks land on the same page.
export const Route = createFileRoute("/search")({
  validateSearch: validateParams,
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/{-$login}", params: { login: undefined }, search, replace: true, statusCode: 301 });
  },
});
