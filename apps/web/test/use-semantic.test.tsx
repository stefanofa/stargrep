import "./client-branch.ts";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { Client, SearchResult } from "../src/lib/rpc.ts";

// The queries the hook searches for, through the API it would call.
const searched: Array<string> = [];
const rpc = await import("../src/lib/rpc.ts");
mock.module("../src/lib/rpc.ts", () => ({
  ...rpc,
  api: () =>
    ({
      search: async ({ q }: { q: string }) => {
        searched.push(q);
        return { planSource: "model", results: [], applied: [] };
      },
    }) satisfies Pick<Client, "search">,
}));
const { useSemanticSearch } = await import("../src/lib/use-semantic.ts");

afterEach(() => {
  cleanup();
  searched.length = 0;
});

describe("the search by meaning on a page", () => {
  test("asks again for a known answer once the library settles on another revision", async () => {
    const known = { query: "terminal", results: [], revision: "synced at 1", stale: false };
    const { rerender, result } = renderHook(
      ({ revision }) => useSemanticSearch("stefanofa", "terminal", { revision, settled: true, known }),
      { initialProps: { revision: "synced at 1" } },
    );
    expect(result.current.semantic).toEqual({ kind: "answered", results: [] });
    expect(searched).toEqual([]);
    rerender({ revision: "synced at 2" });
    await waitFor(() => expect(searched).toEqual(["terminal"]));
    await waitFor(() => expect(result.current.semantic).toEqual({ kind: "answered", results: [] }));
    expect(searched).toEqual(["terminal"]);
  });

  test("asks again for a known answer searched in an older revision than the page's library", async () => {
    const known = { query: "terminal", results: [], revision: "synced at 1", stale: false };
    renderHook(() => useSemanticSearch("stefanofa", "terminal", { revision: "synced at 2", settled: true, known }));
    await waitFor(() => expect(searched).toEqual(["terminal"]));
  });

  test("keeps a stale known answer on screen while it asks for the query again, never showing the search pending", async () => {
    const shown = [{ id: 7 }] as unknown as ReadonlyArray<SearchResult>;
    const known = { query: "terminal", results: shown, revision: "synced at 1", stale: true };
    const kinds: Array<string> = [];
    const { result } = renderHook(() => {
      const search = useSemanticSearch("stefanofa", "terminal", { revision: "synced at 1", settled: true, known });
      kinds.push(search.semantic.kind);
      return search;
    });
    expect(result.current.semantic).toEqual({ kind: "answered", results: shown });
    await waitFor(() => expect(result.current.semantic).toEqual({ kind: "answered", results: [] }));
    expect([searched, [...new Set(kinds)]]).toEqual([["terminal"], ["answered"]]);
  });

  test("asks for the query when the page has no answer by meaning for it", async () => {
    renderHook(() => useSemanticSearch("stefanofa", "terminal", { revision: "synced at 1", settled: true }));
    await waitFor(() => expect(searched).toEqual(["terminal"]));
  });
});
