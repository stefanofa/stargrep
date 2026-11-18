import * as Db from "@stargrep/db";
import type { DbQueryFailed, DbRowInvalid } from "@stargrep/db/errors";
import { blobOid } from "@stargrep/github/blob-oid";
import type { GitHubError } from "@stargrep/github/errors";
import * as GitHub from "@stargrep/github/github";
import type { ObjectId, RepoId } from "@stargrep/github/schemas";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as BlobStore from "../repos/blob-store.ts";
import { candidates, type IconCandidate, ownSite } from "./candidates.ts";
import { iconUrls } from "./homepage.ts";
import * as IconHttp from "./icon-http.ts";
import { BackfillIcons, IconQueue, type IconQueueFailed, type IconRequest, iconRequest } from "./icon-queue.ts";
import { IconStore, type IconStoreFailed } from "./icon-store.ts";
import { contentKey, gitKey, outputVersion } from "./keys.ts";
import { IconNormalizer } from "./normalize.ts";
import { templateBlobs } from "./templates.ts";

export class IconFetchFailed extends Schema.TaggedError<IconFetchFailed, { readonly brand: unique symbol }>()(
  "IconFetchFailed",
  {
    host: Schema.String,
    reason: Schema.Literals(["status", "timeout", "transport", "stale"]),
    status: Schema.NullOr(Schema.Int),
    retryAfterMillis: Schema.NullOr(Schema.Int),
  },
) {
  override get message(): string {
    return `Fetching an icon from '${this.host}' failed with ${this.status ?? this.reason}`;
  }
}

export type FetchIconError =
  | IconFetchFailed
  | IconStoreFailed
  | BlobStore.BlobStoreFailed
  | DbQueryFailed
  | DbRowInvalid;
export type BackfillError = GitHubError | IconQueueFailed | DbQueryFailed | DbRowInvalid;

export type IconOutcome = Data.TaggedEnum<{
  Found: { readonly id: RepoId; readonly icon: Db.RepoIcon };
  Kept: { readonly id: RepoId; readonly icon: Db.RepoIcon };
  NoIcon: { readonly id: RepoId };
  NotFound: { readonly id: RepoId };
}>;
export const IconOutcome = Data.taggedEnum<IconOutcome>();

export interface Backfilled {
  readonly queued: number;
  readonly next: RepoId | null;
}

export class FetchIcon extends Context.Service<
  FetchIcon,
  {
    readonly fetchIcon: (request: IconRequest) => Effect.Effect<IconOutcome, FetchIconError>;
    readonly backfill: (after: number) => Effect.Effect<Backfilled, BackfillError>;
  }
>()("@stargrep/core/icons/fetch-icon/FetchIcon") {}

const iconLimit: IconHttp.Limit = { maxBytes: 1024 * 1024, overflow: "miss" };
const pageLimit: IconHttp.Limit = { maxBytes: 256 * 1024, overflow: "truncate" };
export const backfillPage = 100;
export const refreshAfter = Duration.days(30);

type Unavailable = Extract<IconHttp.Download, { readonly _tag: "Unavailable" }>;

// One try at a download or an icon. Gone says nothing is there, and Unreachable says the place could not be reached.
type Attempt<A> = Data.TaggedEnum<{
  Found: { readonly value: A };
  Gone: Record<never, never>;
  Unreachable: Record<never, never>;
}>;
interface AttemptDefinition extends Data.TaggedEnum.WithGenerics<1> {
  readonly taggedEnum: Attempt<this["A"]>;
}
const Attempt = Data.taggedEnum<AttemptDefinition>();

// Tries each item in turn and stops at the first found. With none found, one unreachable try makes the whole unreachable.
const firstFound = Effect.fnUntraced(function* <I, A, E, R>(
  items: Iterable<I>,
  attempt: (item: I) => Effect.Effect<Attempt<A>, E, R>,
) {
  let unreachable = false;
  for (const item of items) {
    const tried = yield* attempt(item);
    if (tried._tag === "Found") return tried;
    unreachable ||= tried._tag === "Unreachable";
  }
  return unreachable ? Attempt.Unreachable() : Attempt.Gone();
});

// A homepage is a site Stargrep does not control. A dead one, one whose proxy answers 5xx such as Cloudflare's 521, or a
// bot challenge that names no time to come back, fails the same way every time, so it is a miss. The periodic refresh
// checks it again. Only a 429 that names a time waits for it.
const homepageMiss = (failure: Unavailable) => !(failure.status === 429 && failure.retryAfterMillis !== null);

const fetchFailed = (url: string, failure: Unavailable) =>
  new IconFetchFailed({
    host: new URL(url).hostname,
    reason: failure.reason,
    status: failure.status,
    retryAfterMillis: failure.retryAfterMillis,
  });

const make = Effect.gen(function* () {
  const db = yield* Db.Db;
  const github = yield* GitHub.GitHub;
  const blobs = yield* BlobStore.BlobStore;
  const http = yield* IconHttp.IconHttp;
  const store = yield* IconStore;
  const normalizer = yield* IconNormalizer;
  const queue = yield* IconQueue;
  const digest = yield* Digest.Digest;
  const oidOf = (bytes: Uint8Array) => Effect.provideService(blobOid(bytes), Digest.Digest, digest);

  const download = (url: string, limit: IconHttp.Limit, source: Db.IconSource) =>
    Effect.flatMap(
      http.get(url, limit),
      IconHttp.Download.$match({
        Got: ({ bytes }) => Effect.succeed(Attempt.Found({ value: bytes })),
        Missing: () => Effect.succeed(Attempt.Gone()),
        Unavailable: (failure) =>
          source === "homepage" && homepageMiss(failure)
            ? Effect.succeed(Attempt.Unreachable())
            : Effect.fail(fetchFailed(url, failure)),
      }),
    );

  const reuse = (row: Db.Repo, key: string, source: Db.IconSource) =>
    row.icon?.key === key
      ? Effect.succeedSome(row.icon)
      : Effect.map(
          store.head(key),
          Option.map((stored): Db.RepoIcon => ({ key, source, ...stored })),
        );

  const keep = Effect.fn("FetchIcon.keep")(function* (bytes: Uint8Array, key: string, source: Db.IconSource) {
    const normalized = yield* normalizer.normalize(bytes, source);
    if (normalized._tag === "Rejected") {
      yield* Effect.logDebug("Icon candidate rejected", { key, source, reason: normalized.reason });
      return Attempt.Gone();
    }
    const stored = { plate: normalized.plate, size: normalized.size };
    yield* store.put(key, normalized.webp, stored);
    return Attempt.Found({ value: { key, source, ...stored } });
  });

  const fromBytes = Effect.fn("FetchIcon.fromBytes")(function* (row: Db.Repo, url: string, source: Db.IconSource) {
    const fetched = yield* download(url, iconLimit, source);
    if (fetched._tag !== "Found") return fetched;
    if (templateBlobs.has(yield* oidOf(fetched.value))) return Attempt.Gone();
    const key = contentKey(yield* digest.digestHex(Digest.sha256, fetched.value));
    const reused = yield* reuse(row, key, source);
    return Option.isSome(reused) ? Attempt.Found({ value: reused.value }) : yield* keep(fetched.value, key, source);
  });

  const fromRepoFile = Effect.fn("FetchIcon.fromRepoFile")(function* (row: Db.Repo, url: string, oid: ObjectId) {
    const key = gitKey(oid);
    const reused = yield* reuse(row, key, "repo-file");
    if (Option.isSome(reused)) return Attempt.Found({ value: reused.value });
    const fetched = yield* download(url, iconLimit, "repo-file");
    if (fetched._tag !== "Found") return fetched;
    // raw.githubusercontent.com caches HEAD for minutes, so right after a change it can serve the old file. The key
    // names the new blob forever, so the old bytes must not land there.
    if ((yield* oidOf(fetched.value)) !== oid) {
      return yield* new IconFetchFailed({
        host: new URL(url).hostname,
        reason: "stale",
        status: null,
        retryAfterMillis: null,
      });
    }
    return yield* keep(fetched.value, key, "repo-file");
  });

  const homepageIcons = (page: string) =>
    Effect.flatMap(
      http.get(page, pageLimit),
      IconHttp.Download.$match({
        Got: (got) =>
          Effect.succeedSome(ownSite(got.url) ? iconUrls(new TextDecoder().decode(got.bytes), got.url) : []),
        Missing: () => Effect.succeedSome(iconUrls("", page)),
        Unavailable: (failure) =>
          homepageMiss(failure) ? Effect.succeedNone : Effect.fail(fetchFailed(page, failure)),
      }),
    );

  const fromHomepage = Effect.fn("FetchIcon.fromHomepage")(function* (row: Db.Repo, page: string) {
    const urls = yield* homepageIcons(page);
    if (Option.isNone(urls)) return Attempt.Unreachable();
    return yield* firstFound(urls.value, (url) => fromBytes(row, url, "homepage"));
  });

  const attempt = (row: Db.Repo, candidate: IconCandidate) => {
    switch (candidate.source) {
      case "repo-file":
        return fromRepoFile(row, candidate.url, candidate.oid);
      case "readme-image":
        return fromBytes(row, candidate.url, candidate.source);
      case "homepage":
        return fromHomepage(row, candidate.url);
    }
  };

  const readme = (oid: ObjectId | null) =>
    oid === null ? Effect.succeed(null) : Effect.map(blobs.get(BlobStore.readmeKey(oid)), Option.getOrNull);

  const fetchIcon = Effect.fn("FetchIcon.fetchIcon")(function* (request: IconRequest) {
    const id = request.repoId;
    const row = yield* db.repos.get(id);
    if (Option.isNone(row)) return IconOutcome.NotFound({ id });
    const tried = yield* firstFound(candidates({ ...request, readme: yield* readme(request.readmeOid) }), (candidate) =>
      attempt(row.value, candidate),
    );
    if (tried._tag === "Found") {
      yield* db.repos.saveIcon({ id, icon: tried.value });
      return IconOutcome.Found({ id, icon: tried.value });
    }
    // A homepage that could not be reached says nothing about the icon found before, so a refresh keeps it.
    const kept = tried._tag === "Unreachable" ? row.value.icon : null;
    yield* db.repos.saveIcon({ id, icon: kept });
    return kept === null ? IconOutcome.NoIcon({ id }) : IconOutcome.Kept({ id, icon: kept });
  });

  const backfill = Effect.fn("FetchIcon.backfill")(function* (after: number) {
    const checkedBefore = DateTime.subtractDuration(yield* DateTime.now, refreshAfter);
    const page = yield* db.repos.dueIcons({ after, limit: backfillPage, checkedBefore, keyVersion: outputVersion });
    if (page.length === 0) return { queued: 0, next: null };
    const facts = yield* github.repoFacts(page.map((row) => row.nodeId));
    const live = new Set<number>(facts.map((entry) => entry.id));
    yield* db.repos.saveOwners(
      facts.map((entry) => ({ id: entry.id, ownerType: entry.ownerType, ownerAvatarUrl: entry.ownerAvatarUrl })),
    );
    yield* Effect.forEach(
      page,
      (row) => (live.has(row.id) ? Effect.void : db.repos.saveIcon({ id: row.id, icon: null })),
      {
        discard: true,
      },
    );
    const next = page.length === backfillPage ? (page.at(-1)?.id ?? null) : null;
    const requests = facts.map(iconRequest);
    yield* queue.send(next === null ? requests : [...requests, BackfillIcons.make({ after: next })]);
    return { queued: requests.length, next };
  });

  return FetchIcon.of({ fetchIcon, backfill });
});

export const layer = Layer.effect(FetchIcon, make).pipe(Layer.provide(Digest.layerWebCrypto));
