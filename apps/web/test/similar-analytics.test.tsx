import { afterEach, expect, test } from "bun:test";
import { waitFor } from "@testing-library/react";
import { captured } from "./posthog.fake.ts";

const { capture } = await import("../src/lib/analytics.ts");

const setHost = (url: string) =>
  (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(url);

afterEach(() => {
  setHost("http://localhost/");
  captured.length = 0;
});

test("an opened similar repo sends its row and nothing about the repo", async () => {
  setHost("https://stargrep.com/");
  capture("similar_repo_opened", { row: "not_starred" });
  await waitFor(() => expect(captured).toEqual([["similar_repo_opened", { row: "not_starred" }]]));
});

test("anywhere but prod sends nothing", async () => {
  capture("similar_repo_opened", { row: "in_stars" });
  await Promise.resolve();
  expect(captured).toEqual([]);
});
