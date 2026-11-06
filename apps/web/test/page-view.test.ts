import { describe, expect, test } from "bun:test";
import { keywordTerms, searchText } from "../src/lib/keyword.ts";
import { matchesEvery } from "../src/lib/page-view.ts";
import { libraryRepos } from "./library-fixture.ts";

const entries = libraryRepos.map((repo) => ({ ...repo, text: searchText(repo) }));

// The hand-off from the server's first answer to the live view is tested end to end in server-page.test.tsx.
describe("the first answer the server paints", () => {
  test("matches every term the way the live query does, case and wildcards aside", () => {
    const names = (query: string) => matchesEvery(entries, keywordTerms(query)).map((entry) => entry.name);
    expect(names("Terminal Dashboard")).toEqual(["bottom", "console"]);
    expect(names("terminal% dash_board")).toEqual(names("terminal dashboard"));
    expect(names("")).toEqual([]);
  });
});
