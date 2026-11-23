import { type Client, type LibraryRepo, wireCode } from "./rpc.ts";

// A page of 1,000 stars spends milliseconds in the Worker and 0.5 to 0.9 s reaching a browser in Europe, so later
// pages load four at a time rather than one after another.
const concurrency = 4;

type Page = Awaited<ReturnType<Client["stars"]>>;

// A login's synced stars, newest first, a page at a time and in order. The first page names where every later page
// starts. An answer cached before pages named them continues through each page's cursor instead. A sync between two
// reads can move a star to the next page, so a repo already given is left out. A login with no synced stars yet has
// none to page through.
export async function* starsPages(client: Pick<Client, "stars">, login: string) {
  const first = await client.stars({ login }).catch((error: unknown): Page => {
    if (wireCode(error) === "ACCOUNT_NOT_SYNCED") return { login, repos: [], nextCursor: null, labels: {} };
    throw error;
  });
  const seen = new Set<number>();
  const fresh = (page: Page) => page.repos.filter((repo) => !seen.has(repo.id) && seen.add(repo.id));
  yield fresh(first);
  if (first.cursors === undefined) {
    for (let cursor = first.nextCursor; cursor !== null; ) {
      const page = await client.stars({ login, cursor });
      yield fresh(page);
      cursor = page.nextCursor;
    }
    return;
  }
  const { cursors } = first;
  const reading: Array<Promise<Page>> = [];
  let next = 0;
  const read = () => {
    const cursor = cursors[next++];
    if (cursor === undefined) return;
    const page = client.stars({ login, cursor });
    // A page that fails surfaces when its turn comes, as it did when each page waited for the one before.
    page.catch(() => {});
    reading.push(page);
  };
  while (next < concurrency) read();
  for (let page = reading.shift(); page !== undefined; page = reading.shift()) {
    const answered = await page;
    read();
    yield fresh(answered);
  }
}

export const findStar = async (client: Pick<Client, "stars">, login: string, fullName: string) => {
  for await (const page of starsPages(client, login)) {
    const found = page.find((repo) => `${repo.owner}/${repo.name}` === fullName);
    if (found !== undefined) return found;
  }
  return null;
};

export const allStars = async (client: Pick<Client, "stars">, login: string) => {
  const repos: Array<LibraryRepo> = [];
  for await (const page of starsPages(client, login)) repos.push(...page);
  return repos;
};
