import type { PlannedClient } from "./planned.ts";
import { type LibraryRepo, wireCode } from "./rpc.ts";

// A login's synced stars, newest first, a page at a time. A login with no synced stars yet has none to page through.
export async function* starsPages(client: Pick<PlannedClient, "stars">, login: string) {
  let cursor: string | undefined;
  do {
    const page = await client.stars(cursor === undefined ? { login } : { login, cursor }).catch((error: unknown) => {
      if (cursor === undefined && wireCode(error) === "ACCOUNT_NOT_SYNCED") return { repos: [], nextCursor: null };
      throw error;
    });
    yield page.repos as ReadonlyArray<LibraryRepo>;
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
}

export const allStars = async (client: Pick<PlannedClient, "stars">, login: string) => {
  const repos: Array<LibraryRepo> = [];
  for await (const page of starsPages(client, login)) repos.push(...page);
  return repos;
};
