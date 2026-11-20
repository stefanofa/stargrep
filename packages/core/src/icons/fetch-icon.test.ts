import { expect } from "bun:test";
import * as Db from "@stargrep/db";
import { EmbeddingModelId } from "@stargrep/db/embedding";
import * as TestDatabase from "@stargrep/db/test-database";
import { blobOid } from "@stargrep/github/blob-oid";
import * as GitHubFake from "@stargrep/github/github.fixture";
import { ObjectId, Repo, type RepoFile, type RepoId } from "@stargrep/github/schemas";
import * as it from "@stargrep/testing";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as BlobStore from "../repos/blob-store.ts";
import * as FetchIcon from "./fetch-icon.ts";
import * as IconHttp from "./icon-http.ts";
import * as IconQueue from "./icon-queue.ts";
import * as IconStore from "./icon-store.ts";
import * as Keys from "./keys.ts";
import * as Normalize from "./normalize.ts";

const embeddingModel = Schema.decodeSync(EmbeddingModelId)("fake/hash-embedding");
const oid = (digit: string) => Schema.decodeSync(ObjectId)(digit.repeat(40));
const repo = (n: number) => Schema.decodeSync(Repo)({ id: n, nodeId: `R_${n}`, owner: "acme", name: `kit-${n}` });
const idOf = (n: number) => repo(n).id;
const encode = (text: string) => new TextEncoder().encode(text);
const blobOidOf = (text: string) => Effect.map(blobOid(encode(text)), Schema.decodeSync(ObjectId));
const templateFavicon = new Uint8Array(
  await Bun.file(new URL("./fixtures/next-favicon-current.ico", import.meta.url)).arrayBuffer(),
);

const fixture = () => {
  const replies = new Map<string, IconHttp.Download>();
  const asked: Array<string> = [];
  const got = (text: string, url = "https://example.test/") => IconHttp.Download.Got({ bytes: encode(text), url });
  const http = Layer.succeed(
    IconHttp.IconHttp,
    IconHttp.IconHttp.of({
      get: (url) =>
        Effect.sync(() => {
          asked.push(url);
          return replies.get(url) ?? IconHttp.Download.Missing({ reason: "status" });
        }),
    }),
  );

  const normalized: Array<string> = [];
  const normalizer = Layer.succeed(
    Normalize.IconNormalizer,
    Normalize.IconNormalizer.of({
      normalize: (bytes) =>
        Effect.sync(() => {
          const text = new TextDecoder().decode(bytes);
          normalized.push(text);
          return text.includes("banner")
            ? Normalize.Normalized.Rejected({ reason: "not-square" })
            : Normalize.Normalized.Accepted({ webp: bytes, plate: text.includes("white") ? "dark" : "none", size: 64 });
        }),
    }),
  );

  const remoteReadmes = new Map<number, { readonly oid: ObjectId; readonly logo: string }>();
  // Repos GitHub sends with a null databaseId, which its schema allows and no repo row can be keyed by.
  const unkeyed = new Set<number>();
  const github = GitHubFake.layer((sent) => {
    if (sent.url.pathname !== "/graphql") return { status: 500 };
    const ids: ReadonlyArray<string> = JSON.parse(sent.body ?? "{}").variables.ids;
    return {
      body: {
        data: {
          nodes: ids.map((nodeId) => {
            const n = Number(nodeId.slice(2));
            const readme = remoteReadmes.get(n);
            return n % 7 === 0
              ? null
              : {
                  databaseId: unkeyed.has(n) ? null : n,
                  id: nodeId,
                  name: `kit-${n}`,
                  owner: {
                    __typename: "Organization",
                    login: "acme",
                    avatarUrl: "https://avatars.githubusercontent.com/u/7",
                  },
                  description: null,
                  homepageUrl: "https://kit.dev",
                  primaryLanguage: null,
                  licenseInfo: null,
                  repositoryTopics: { nodes: [] },
                  createdAt: "2020-01-01T00:00:00Z",
                  pushedAt: null,
                  isArchived: false,
                  isFork: false,
                  isPrivate: false,
                  stargazerCount: 1,
                  forkCount: 0,
                  root: { entries: readme === undefined ? [] : [{ name: "README.md", type: "blob", oid: readme.oid }] },
                };
          }),
        },
      },
    };
  });

  const queue = IconQueue.layerMemory();
  const store = IconStore.layerMemory();

  const layer = FetchIcon.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        TestDatabase.layerMemory({ embeddingModel }),
        github.layer,
        BlobStore.layerMemory,
        http,
        normalizer,
        queue.layer,
        store.layer,
        Digest.layerWebCrypto,
      ),
    ),
  );

  const reset = Effect.sync(() => {
    replies.clear();
    asked.length = 0;
    normalized.length = 0;
    queue.sent.length = 0;
  });

  const seed = (numbers: ReadonlyArray<number>) =>
    Effect.gen(function* () {
      yield* reset;
      yield* (yield* Db.Db).repos.upsertRefs(numbers.map(repo));
    });

  const stored = (id: RepoId) => Effect.flatMap(Db.Db, (db) => Effect.map(db.repos.get(id), Option.getOrThrow));

  const raw = (n: number, path: string) => `https://raw.githubusercontent.com/acme/kit-${n}/HEAD/${path}`;

  const request = (
    n: number,
    facts: { readonly iconFiles?: ReadonlyArray<RepoFile>; readonly readmeOid?: ObjectId; readonly homepage?: string },
  ) =>
    IconQueue.IconRequest.make({
      repoId: idOf(n),
      owner: repo(n).owner,
      name: repo(n).name,
      homepage: facts.homepage ?? null,
      iconFiles: facts.iconFiles ?? [],
      readmeOid: facts.readmeOid ?? null,
    });

  const fetchIcon = (message: IconQueue.IconRequest) =>
    Effect.flatMap(FetchIcon.FetchIcon, (icons) => icons.fetchIcon(message));

  const unavailable = (status: number | null, retryAfterMillis: number | null = null) =>
    IconHttp.Download.Unavailable({ reason: status === null ? "transport" : "status", status, retryAfterMillis });

  return {
    replies,
    asked,
    got,
    http,
    normalized,
    normalizer,
    remoteReadmes,
    unkeyed,
    github,
    queue,
    store,
    layer,
    reset,
    seed,
    stored,
    raw,
    request,
    fetchIcon,
    unavailable,
  };
};

{
  const { replies, asked, got, normalized, store, layer, seed, stored, raw, request, fetchIcon, unavailable } =
    fixture();

  it.layer(layer, { timeout: 30_000 })("fetchIcon", (it) => {
    it.effect(
      "builds candidates from the facts and the stored README, and keeps the first the normalizer accepts",
      () =>
        Effect.gen(function* () {
          yield* seed([1]);
          yield* (yield* BlobStore.BlobStore).put(
            BlobStore.readmeKey(oid("e")),
            "# Kit\n\n![logo](docs/logo-white.svg)",
          );
          replies.set(raw(1, "logo.png"), got("wide banner"));
          replies.set(raw(1, "docs/logo-white.svg"), got("<svg>logo white</svg>"));
          const outcome = yield* fetchIcon(
            request(1, {
              iconFiles: [{ name: "logo.png", oid: yield* blobOidOf("wide banner") }],
              readmeOid: oid("e"),
              homepage: "https://kit.dev",
            }),
          );

          expect(outcome._tag).toBe("Found");
          expect(asked).toEqual([raw(1, "logo.png"), raw(1, "docs/logo-white.svg")]);
          const { icon, iconCheckedAt } = yield* stored(idOf(1));
          expect(icon).toMatchObject({ source: "readme-image", plate: "dark", size: 64 });
          expect(icon?.key).toMatch(/^v2\/sha256\/[0-9a-f]{64}\.webp$/);
          expect(iconCheckedAt).not.toBeNull();
          expect(store.objects.get(icon?.key ?? "")?.stored).toEqual({ plate: "dark", size: 64 });
        }),
    );

    it.effect("retries through the settlement table when the README read fails, and records nothing", () => {
      const failing = Layer.succeed(
        BlobStore.BlobStore,
        BlobStore.BlobStore.of({
          get: (key) => Effect.fail(new BlobStore.BlobStoreFailed({ operation: "get", key, cause: null })),
          put: () => Effect.void,
        }),
      );
      return Effect.gen(function* () {
        yield* seed([11]);
        const error = yield* fetchIcon(request(11, { readmeOid: oid("f"), homepage: "https://kit.dev" })).pipe(
          Effect.provide(Layer.fresh(FetchIcon.layer).pipe(Layer.provide(failing))),
          Effect.flip,
        );

        expect(error._tag).toBe("BlobStoreFailed");
        expect(asked).toEqual([]);
        expect((yield* stored(idOf(11))).iconCheckedAt).toBeNull();
      });
    });

    it.effect("reuses a repo file R2 already holds, without downloading or normalizing it again", () =>
      Effect.gen(function* () {
        yield* seed([2]);
        yield* (yield* IconStore.IconStore).put(Keys.gitKey(oid("b")), encode("webp"), { plate: "light", size: 32 });
        yield* fetchIcon(request(2, { iconFiles: [{ name: "logo.svg", oid: oid("b") }] }));

        expect(asked).toEqual([]);
        expect(normalized).toEqual([]);
        expect((yield* stored(idOf(2))).icon).toEqual({
          key: `v2/git/${"b".repeat(40)}.webp`,
          source: "repo-file",
          plate: "light",
          size: 32,
        });
      }),
    );

    it.effect("normalizes an icon stored under an older key version again, so stricter rules can drop it", () =>
      Effect.gen(function* () {
        yield* seed([15]);
        const svg = "<svg>banner the renderer drew without its text</svg>";
        const oldKey = `v1/sha256/${yield* (yield* Digest.Digest).digestHex(Digest.sha256, encode(svg))}.webp`;
        yield* (yield* IconStore.IconStore).put(oldKey, encode("webp"), { plate: "none", size: 128 });
        yield* (yield* Db.Db).repos.saveIcon({
          id: idOf(15),
          icon: { key: oldKey, source: "homepage", plate: "none", size: 128 },
        });
        replies.set("https://kit.dev/", got(`<link rel="icon" href="/favicon.svg">`, "https://kit.dev/"));
        replies.set("https://kit.dev/favicon.svg", got(svg));
        const outcome = yield* fetchIcon(request(15, { homepage: "https://kit.dev" }));

        expect(outcome._tag).toBe("NoIcon");
        expect(normalized).toEqual([svg]);
        expect((yield* stored(idOf(15))).icon).toBeNull();
      }),
    );

    it.effect("skips a homepage that serves a template favicon, by the blob ID of the bytes", () =>
      Effect.gen(function* () {
        yield* seed([3]);
        replies.set("https://kit.dev/", got(`<link rel="icon" href="/favicon.ico">`, "https://kit.dev/"));
        replies.set(
          "https://kit.dev/favicon.ico",
          IconHttp.Download.Got({ bytes: templateFavicon, url: "https://kit.dev/favicon.ico" }),
        );
        const outcome = yield* fetchIcon(request(3, { homepage: "https://kit.dev" }));

        expect(outcome._tag).toBe("NoIcon");
        expect(normalized).toEqual([]);
        expect((yield* stored(idOf(3))).iconCheckedAt).not.toBeNull();
      }),
    );

    it.effect("fails on a raw 429 without trying a lower candidate, and leaves the repo unchecked", () =>
      Effect.gen(function* () {
        yield* seed([4]);
        replies.set(raw(4, "logo.svg"), unavailable(429, 30_000));
        const error = yield* fetchIcon(
          request(4, { iconFiles: [{ name: "logo.svg", oid: oid("c") }], homepage: "https://kit.dev" }),
        ).pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "IconFetchFailed",
          host: "raw.githubusercontent.com",
          status: 429,
          retryAfterMillis: 30_000,
        });
        expect(asked).toEqual([raw(4, "logo.svg")]);
        expect((yield* stored(idOf(4))).iconCheckedAt).toBeNull();
      }),
    );

    it.effect(
      "reads a homepage that is unreachable or answers 5xx as a miss with one request, and checks the repo",
      () =>
        Effect.gen(function* () {
          const sites = [
            [5, "https://dead.dev", unavailable(null)],
            [6, "https://busy.dev", unavailable(503)],
            [8, "https://parked.dev", unavailable(521)],
            [9, "https://badcert.dev", unavailable(526)],
          ] as const;
          yield* seed(sites.map(([n]) => n));
          for (const [n, site, reply] of sites) {
            replies.set(`${site}/`, reply);
            asked.length = 0;
            expect((yield* fetchIcon(request(n, { homepage: site })))._tag).toBe("NoIcon");
            expect(asked).toEqual([`${site}/`]);
            expect((yield* stored(idOf(n))).iconCheckedAt).not.toBeNull();
          }
        }),
    );

    it.effect("reads a homepage icon link that answers 5xx as a miss, and checks the repo", () =>
      Effect.gen(function* () {
        yield* seed([10]);
        replies.set("https://kit.dev/", got(`<link rel="icon" href="/icon.png">`, "https://kit.dev/"));
        replies.set("https://kit.dev/icon.png", unavailable(520));

        expect((yield* fetchIcon(request(10, { homepage: "https://kit.dev" })))._tag).toBe("NoIcon");
        expect((yield* stored(idOf(10))).iconCheckedAt).not.toBeNull();
      }),
    );

    it.effect("ends a homepage 429 with no Retry-After as a miss, and retries one that names a time", () =>
      Effect.gen(function* () {
        yield* seed([12, 13]);
        replies.set("https://challenge.dev/", unavailable(429));
        replies.set("https://limited.dev/", unavailable(429, 120_000));

        expect((yield* fetchIcon(request(12, { homepage: "https://challenge.dev" })))._tag).toBe("NoIcon");
        expect(asked).toEqual(["https://challenge.dev/"]);
        expect((yield* stored(idOf(12))).iconCheckedAt).not.toBeNull();

        const error = yield* fetchIcon(request(13, { homepage: "https://limited.dev" })).pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "IconFetchFailed", status: 429, retryAfterMillis: 120_000 });
      }),
    );
  });
}

{
  const f = fixture();

  it.layer(f.layer, { timeout: 30_000 })("refresh", (it) => {
    it.effect(
      "keeps an icon found earlier when the homepage times out or answers a bare 429, and drops it once gone",
      () =>
        Effect.gen(function* () {
          yield* f.seed([21, 22, 23]);
          for (const [n, site] of [
            [21, "https://slow.dev"],
            [22, "https://challenge.dev"],
            [23, "https://gone.dev"],
          ] as const) {
            f.replies.set(`${site}/`, f.got(`<link rel="icon" href="/icon.svg">`, `${site}/`));
            f.replies.set(`${site}/icon.svg`, f.got(`<svg>${site}</svg>`));
            expect((yield* f.fetchIcon(f.request(n, { homepage: site })))._tag).toBe("Found");
          }
          const before = [(yield* f.stored(idOf(21))).icon, (yield* f.stored(idOf(22))).icon];

          f.replies.set(
            "https://slow.dev/",
            IconHttp.Download.Unavailable({ reason: "timeout", status: null, retryAfterMillis: null }),
          );
          f.replies.set("https://challenge.dev/", f.unavailable(429));
          f.replies.set("https://gone.dev/", f.got("<html><head></head></html>", "https://gone.dev/"));
          f.replies.delete("https://gone.dev/icon.svg");

          expect(yield* f.fetchIcon(f.request(21, { homepage: "https://slow.dev" }))).toMatchObject({ _tag: "Kept" });
          expect(yield* f.fetchIcon(f.request(22, { homepage: "https://challenge.dev" }))).toMatchObject({
            _tag: "Kept",
          });
          expect((yield* f.fetchIcon(f.request(23, { homepage: "https://gone.dev" })))._tag).toBe("NoIcon");
          expect([(yield* f.stored(idOf(21))).icon, (yield* f.stored(idOf(22))).icon]).toEqual(before);
          expect((yield* f.stored(idOf(23))).icon).toBeNull();
        }),
    );
  });
}

{
  const f = fixture();

  it.layer(f.layer, { timeout: 30_000 })("redirected homepage", (it) => {
    it.effect("resolves relative icon links against the page the redirect landed on", () =>
      Effect.gen(function* () {
        yield* f.seed([8]);
        f.replies.set("https://kit.dev/home", f.got(`<link rel="icon" href="logo.svg">`, "https://kit.dev/docs/"));
        f.replies.set("https://kit.dev/docs/logo.svg", f.got("<svg>docs logo</svg>"));

        expect((yield* f.fetchIcon(f.request(8, { homepage: "https://kit.dev/home" })))._tag).toBe("Found");
        expect(f.asked).toEqual(["https://kit.dev/home", "https://kit.dev/docs/logo.svg"]);
      }),
    );

    it.effect("takes no icon from a page that redirects to a package registry", () =>
      Effect.gen(function* () {
        yield* f.seed([9]);
        f.replies.set(
          "https://kit.dev/pypi",
          f.got(`<link rel="icon" href="/favicon.ico">`, "https://pypi.org/project/kit/"),
        );

        expect((yield* f.fetchIcon(f.request(9, { homepage: "https://kit.dev/pypi" })))._tag).toBe("NoIcon");
        expect(f.asked).toEqual(["https://kit.dev/pypi"]);
      }),
    );
  });
}

{
  const f = fixture();

  it.layer(f.layer, { timeout: 30_000 })("stale raw cache", (it) => {
    it.effect(
      "retries when raw serves bytes that are not the tree's blob, and stores nothing under that blob's key",
      () =>
        Effect.gen(function* () {
          yield* f.seed([7]);
          const changed = yield* blobOidOf("<svg>new logo</svg>");
          f.replies.set(f.raw(7, "logo.svg"), f.got("<svg>old logo</svg>"));
          const error = yield* f
            .fetchIcon(f.request(7, { iconFiles: [{ name: "logo.svg", oid: changed }] }))
            .pipe(Effect.flip);

          expect(error).toMatchObject({ _tag: "IconFetchFailed", reason: "stale", retryAfterMillis: null });
          expect(f.store.objects.has(Keys.gitKey(changed))).toBe(false);
          expect(f.normalized).toEqual([]);
          expect((yield* f.stored(idOf(7))).iconCheckedAt).toBeNull();
        }),
    );
  });
}

{
  const f = fixture();

  // Starts a chain at this page, as a daily start does at the page the chain stands at.
  const startAt = (after: number) =>
    Effect.gen(function* () {
      yield* (yield* TestDatabase.TestDatabase).query(
        "insert into icon_backfill (after) values ($1) on conflict (singleton) do update set after = excluded.after",
        [after],
      );
      return yield* (yield* FetchIcon.FetchIcon).backfill(after);
    });

  it.layer(f.layer, { timeout: 30_000 })("backfill", (it) => {
    it.effect(
      "queues facts for due repos, writes owners, settles gone repos, and leaves summaries and embeddings alone",
      () =>
        Effect.gen(function* () {
          const database = yield* TestDatabase.TestDatabase;
          const db = yield* Db.Db;
          yield* f.seed([10, 11, 12, 14]);
          const [summarized, fresh, checked, gone] = [idOf(10), idOf(11), idOf(12), idOf(14)];
          f.remoteReadmes.set(10, { oid: oid("d"), logo: "img/logo.svg" });
          yield* database.query(
            `update repos set summary = 'kept', summary_readme_oid = $2, readme_oid = $2, embedding_model = $3,
           embedding = ('[' || array_to_string(array_fill(0.5::float4, array[1024]), ',') || ']')::halfvec
         where id = $1`,
            [summarized, oid("d"), embeddingModel],
          );
          yield* db.repos.saveIcon({ id: checked, icon: null });
          const before = yield* f.stored(summarized);

          const result = yield* startAt(9);

          expect(result).toEqual({ queued: 2, next: null });
          expect(f.queue.sent).toEqual([
            f.request(10, { readmeOid: oid("d"), homepage: "https://kit.dev" }),
            f.request(11, { homepage: "https://kit.dev" }),
          ]);
          expect(f.github.sent.map((sent) => sent.url.pathname)).toEqual(["/graphql"]);
          expect(yield* f.stored(summarized)).toEqual({
            ...before,
            ownerType: "org",
            ownerAvatarUrl: "https://avatars.githubusercontent.com/u/7",
          });
          expect((yield* f.stored(fresh)).ownerType).toBe("org");
          expect((yield* f.stored(gone)).iconCheckedAt).not.toBeNull();
          expect(
            yield* database.query("select embedding is not null as embedded from repos where id = $1", [summarized]),
          ).toEqual([{ embedded: true }]);
          expect(yield* db.repos.pendingEnrichment([summarized])).toEqual([]);
        }),
    );

    it.effect("sends a checked repo whose icon key has an older version, and skips one on the current version", () =>
      Effect.gen(function* () {
        yield* f.seed([2003, 2004]);
        const db = yield* Db.Db;
        const icon = { source: "repo-file", plate: "none", size: 64 } as const;
        yield* db.repos.saveIcon({ id: idOf(2003), icon: { ...icon, key: `v1/git/${"a".repeat(40)}.webp` } });
        yield* db.repos.saveIcon({ id: idOf(2004), icon: { ...icon, key: Keys.gitKey(oid("a")) } });

        expect(yield* startAt(2002)).toEqual({ queued: 1, next: null });
        expect(f.queue.sent).toEqual([f.request(2003, { homepage: "https://kit.dev" })]);

        yield* db.repos.saveIcon({ id: idOf(2003), icon: { ...icon, key: Keys.gitKey(oid("b")) } });
        expect(yield* startAt(2002)).toEqual({ queued: 0, next: null });
      }),
    );

    it.effect("keeps the icon of a repo whose GitHub facts the decoder refuses, and queues its page-mates", () =>
      Effect.gen(function* () {
        yield* f.seed([5001, 5002]);
        f.unkeyed.add(5001);
        const db = yield* Db.Db;
        const icon = { key: Keys.gitKey(oid("e")), source: "repo-file", plate: "none", size: 64 } as const;
        yield* db.repos.saveIcon({ id: idOf(5001), icon });
        yield* (yield* TestDatabase.TestDatabase).query(
          "update repos set icon_checked_at = now() - interval '40 days' where id = $1",
          [idOf(5001)],
        );

        expect(yield* startAt(5000)).toEqual({ queued: 1, next: null });
        expect(f.queue.sent).toEqual([f.request(5002, { homepage: "https://kit.dev" })]);
        expect((yield* f.stored(idOf(5001))).icon).toEqual(icon);
        yield* db.repos.markIconChecked(idOf(5001));
        yield* db.repos.markIconChecked(idOf(5002));
      }),
    );

    it.effect("skips a repo marked checked, and keeps the icon it had", () =>
      Effect.gen(function* () {
        yield* f.seed([3001, 3002]);
        const db = yield* Db.Db;
        const icon = { key: Keys.gitKey(oid("c")), source: "repo-file", plate: "none", size: 64 } as const;
        yield* db.repos.saveIcon({ id: idOf(3001), icon });
        yield* (yield* TestDatabase.TestDatabase).query(
          "update repos set icon_checked_at = now() - interval '40 days' where id = $1",
          [idOf(3001)],
        );
        yield* db.repos.markIconChecked(idOf(3001));
        yield* db.repos.markIconChecked(idOf(3002));

        expect(yield* startAt(3000)).toEqual({ queued: 0, next: null });
        expect((yield* f.stored(idOf(3001))).icon).toEqual(icon);
        expect((yield* f.stored(idOf(3002))).icon).toBeNull();
      }),
    );

    it.effect("pages by repo ID and chains the next page until a short page ends it", () =>
      Effect.gen(function* () {
        const numbers = Array.from({ length: FetchIcon.backfillPage + 1 }, (_, index) => 1001 + index);
        yield* f.seed(numbers);
        const lastOfPage = idOf(1000 + FetchIcon.backfillPage);
        const backfill = (yield* FetchIcon.FetchIcon).backfill;

        const first = yield* startAt(1000);
        expect(first.next).toBe(lastOfPage);
        expect(f.queue.sent.at(-1)).toEqual(IconQueue.BackfillIcons.make({ after: lastOfPage }));

        f.queue.sent.length = 0;
        expect(yield* backfill(first.next ?? 0)).toEqual({ queued: 1, next: null });
        expect(f.queue.sent).toEqual([expect.objectContaining({ repoId: idOf(1001 + FetchIcon.backfillPage) })]);
      }),
    );
  });
}

{
  const f = fixture();

  it.layer(f.layer, { timeout: 30_000 })("backfill chain", (it) => {
    it.effect(
      "runs one chain: a second copy of a page sends nothing, and a start resumes the chain where it stands",
      () =>
        Effect.gen(function* () {
          const numbers = Array.from({ length: FetchIcon.backfillPage + 1 }, (_, index) => 1 + index);
          yield* f.seed(numbers);
          const lastOfPage = idOf(FetchIcon.backfillPage);
          const backfill = (yield* FetchIcon.FetchIcon).backfill;
          const start = FetchIcon.startBackfill();

          expect(yield* start).toBe(0);
          expect(f.queue.sent).toEqual([IconQueue.BackfillIcons.make({ after: 0 })]);
          f.queue.sent.length = 0;

          expect((yield* backfill(0)).next).toBe(lastOfPage);
          expect(f.queue.sent.at(-1)).toEqual(IconQueue.BackfillIcons.make({ after: lastOfPage }));
          f.queue.sent.length = 0;
          expect(yield* backfill(0)).toEqual({ queued: 0, next: null });
          expect(f.queue.sent).toEqual([]);

          expect(yield* start).toBe(lastOfPage);
          expect(f.queue.sent).toEqual([IconQueue.BackfillIcons.make({ after: lastOfPage })]);
          f.queue.sent.length = 0;
          expect(yield* backfill(lastOfPage)).toEqual({ queued: 1, next: null });
          expect(yield* backfill(lastOfPage)).toEqual({ queued: 0, next: null });
          expect(f.queue.sent).toEqual([expect.objectContaining({ repoId: idOf(FetchIcon.backfillPage + 1) })]);

          expect(yield* start).toBe(0);
        }),
    );
  });
}
