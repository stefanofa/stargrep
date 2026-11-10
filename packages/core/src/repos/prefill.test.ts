import { expect } from "bun:test";
import * as Fake from "@stargrep/ai/fake";
import * as SummarizeFake from "@stargrep/ai/summarize.fake";
import * as Db from "@stargrep/db";
import { EmbeddingModelId } from "@stargrep/db/embedding";
import * as TestDatabase from "@stargrep/db/test-database";
import type * as GitHub from "@stargrep/github/github";
import * as GitHubFake from "@stargrep/github/github.fixture";
import { Login, ObjectId, RepoId, RepoName, RepoNodeId } from "@stargrep/github/schemas";
import * as it from "@stargrep/testing";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as IconQueue from "../icons/icon-queue.ts";
import * as BlobStore from "./blob-store.ts";
import * as EnrichQueue from "./enrich-queue.ts";
import * as EnrichRepo from "./enrich-repo.ts";
import * as EnrichRetry from "./enrich-retry.ts";
import * as Prefill from "./prefill.ts";

const embeddingModel = Schema.decodeSync(EmbeddingModelId)("fake/hash-embedding");
const oid = (n: number) => Schema.decodeSync(ObjectId)(String(n).padStart(40, "c"));
const ref = (n: number): GitHub.ArchiveRef => ({
  id: RepoId.make(n),
  owner: Login.make("owner"),
  name: RepoName.make(`repo-${n}`),
});
const range = (from: number, count: number) => Array.from({ length: count }, (_, index) => from + index);

interface Remote {
  readonly description: string;
  // The ID GitHub now gives the name, when another repo took it.
  readonly databaseId?: number;
  readonly readme?: string;
}

const adapters = [
  ["PGlite", TestDatabase.layerMemory({ embeddingModel })],
  ["Postgres", TestDatabase.layerNodePostgres({ embeddingModel })],
] as const;

const fixture = () => {
  const remotes = new Map<number, Remote>();
  const node = (n: number, remote: Remote) => ({
    databaseId: remote.databaseId ?? n,
    id: `R_${remote.databaseId ?? n}`,
    name: `repo-${n}`,
    owner: { __typename: "User", login: "owner", avatarUrl: "https://avatars.githubusercontent.com/u/9?v=4" },
    description: remote.description,
    homepageUrl: null,
    primaryLanguage: { name: "Go" },
    licenseInfo: { spdxId: "MIT" },
    repositoryTopics: { nodes: [{ topic: { name: "cli" } }] },
    createdAt: "2020-01-01T00:00:00Z",
    pushedAt: "2026-10-01T00:00:00Z",
    isArchived: false,
    isFork: false,
    stargazerCount: 100,
    forkCount: 5,
    root: { entries: remote.readme === undefined ? [] : [{ name: "README.md", type: "blob", oid: oid(n) }] },
  });
  const github = GitHubFake.layer((sent) => {
    if (sent.url.pathname === "/graphql") {
      const { variables } = JSON.parse(sent.body ?? "{}") as { variables: Record<string, unknown> };
      if (Array.isArray(variables.ids)) {
        const nodes = variables.ids.map((nodeId: string) => {
          const n = Number(nodeId.slice(2));
          const remote = remotes.get(n);
          return remote === undefined ? null : node(n, remote);
        });
        return { body: { data: { nodes } } };
      }
      const data: Record<string, unknown> = {};
      const errors: Array<unknown> = [];
      for (let index = 0; `n${index}` in variables; index++) {
        const n = Number(String(variables[`n${index}`]).slice("repo-".length));
        const remote = remotes.get(n);
        data[`r${index}`] = remote === undefined ? null : node(n, remote);
        if (remote === undefined) errors.push({ type: "NOT_FOUND", path: [`r${index}`], message: "Not found" });
      }
      return { body: { data, errors } };
    }
    const blob = sent.url.pathname.split("/").at(-1);
    const found = [...remotes].find(([n]) => oid(n) === blob);
    return found?.[1].readme === undefined ? { status: 404 } : { body: found[1].readme };
  });
  const graphqlRequests = () => github.sent.filter((sent) => sent.url.pathname === "/graphql").length;

  // Every summary call a direct path or a consumer makes, by prompt.
  const asked: Array<string> = [];
  const respond = (prompt: string) => {
    asked.push(prompt);
    return SummarizeFake.respond(prompt);
  };
  const batches = Fake.batches(SummarizeFake.respond, "fake/summary");

  const layer = <E>(database: Layer.Layer<Db.Db | Db.Transactions | TestDatabase.TestDatabase, E>) =>
    Layer.provideMerge(
      Layer.merge(Prefill.layer, EnrichRepo.layer),
      Layer.mergeAll(
        database,
        github.layer,
        BlobStore.layerMemory,
        batches.layer,
        IconQueue.layerMemory().layer,
        Fake.layerTextGeneration(respond, "fake/summary"),
        Fake.layerEmbeddings(),
      ),
    );

  const seed = (numbers: ReadonlyArray<number>) => {
    for (const n of numbers) remotes.set(n, { description: `A CLI for task ${n}`, readme: `# repo-${n}\n\nA CLI.` });
  };

  return { remotes, github, graphqlRequests, asked, batches, layer, seed };
};

const run = (refs: ReadonlyArray<GitHub.ArchiveRef>) =>
  Effect.flatMap(Prefill.Prefill, (prefill) =>
    prefill.run({ refs, adapter: "gateway-batch", chunk: 250, concurrency: 4 }),
  );

const tally = (report: Prefill.PrefillReport) => {
  const counts: Partial<Record<Prefill.Outcome, number>> = {};
  for (const outcome of report.outcomes.values()) counts[outcome] = (counts[outcome] ?? 0) + 1;
  return counts;
};

for (const [adapter, database] of adapters) {
  const f = fixture();
  const query = (text: string, values: ReadonlyArray<unknown> = []) =>
    Effect.flatMap(TestDatabase.TestDatabase, (test) => test.query(text, values));

  // The regular sweep, and the queue consumer's service on every repo it sends, as the deployed cron and queue run them.
  const sweepAndConsume = Effect.gen(function* () {
    const queue = EnrichQueue.layerMemory();
    yield* EnrichRetry.sweep().pipe(Effect.provide(queue.layer));
    const enricher = yield* EnrichRepo.EnrichRepo;
    if (queue.sent.length > 0) yield* enricher.enrichRepos(queue.sent.map((message) => message.repoId));
    return queue.sent.length;
  });

  it.layer(f.layer(database), { timeout: 60_000 })(`prefill on ${adapter}`, (it) => {
    it.effect("saves a chunk through one batch, with its manifest, receipts, atoms, and embeddings", () =>
      Effect.gen(function* () {
        f.seed(range(1001, 3));
        const report = yield* run(range(1001, 3).map(ref));
        expect(tally(report)).toEqual({ saved: 3 });
        expect(report.manifests).toEqual({ resumed: 0, dropped: 0, created: 1, closed: 1 });
        const [manifest] = yield* query(
          "select state, adapter, model, cardinality(repo_ids)::int as items, provider_batch_id is not null as named from extraction_batches",
        );
        expect(manifest).toEqual({
          state: "captured",
          adapter: "gateway-batch",
          model: "fake/summary",
          items: 3,
          named: true,
        });
        expect(
          yield* query(
            `select count(*)::int as receipts, count(*) filter (where c.batch_id is not null)::int as batched,
               count(*) filter (where r.embedding is not null and r.enrich_retry_at is null)::int as read,
               count(*) filter (where not f.stale)::int as projected
             from receipts c join repos r on r.receipt_id = c.id join repo_facets f on f.repo_id = r.id
             where r.id between 1001 and 1003`,
          ),
        ).toEqual([{ receipts: 3, batched: 3, read: 3, projected: 3 }]);
        expect(f.asked).toEqual([]);
      }),
    );

    it.effect("keeps a repo only when GitHub's ID for its name is the archive's", () =>
      Effect.gen(function* () {
        f.seed([1101]);
        f.remotes.set(1102, { description: "Another repo took this name", databaseId: 9_999_102 });
        const report = yield* run([ref(1101), ref(1102), ref(1103)]);
        expect(tally(report)).toEqual({ saved: 1, unresolved: 2 });
        expect(report.unresolved).toEqual([
          { id: RepoId.make(1102), reason: "other-repo" },
          { id: RepoId.make(1103), reason: "missing" },
        ]);
        expect(yield* query("select count(*)::int as stored from repos where id in (1102, 1103, 9999102)")).toEqual([
          { stored: 0 },
        ]);
      }),
    );

    it.effect("leaves a repo another attempt holds to that attempt", () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        f.seed([1201, 1202]);
        yield* run([ref(1201)]);
        yield* db.repos.upsertRefs([
          {
            id: RepoId.make(1202),
            nodeId: RepoNodeId.make("R_1202"),
            owner: Login.make("owner"),
            name: RepoName.make("repo-1202"),
          },
        ]);
        const now = yield* DateTime.now;
        yield* db.repos.lease({
          ids: [RepoId.make(1202)],
          now,
          until: DateTime.addDuration(now, EnrichRetry.attemptLease),
        });
        const report = yield* run([ref(1202)]);
        expect(tally(report)).toEqual({ held: 1 });
        expect(yield* query("select count(*)::int as receipts from receipts where repo_id = 1202")).toEqual([
          { receipts: 0 },
        ]);
      }),
    );

    it.effect(
      "a run killed mid-batch resumes with no repaid item, no duplicate receipt, and no paid call from the sweep or the consumer",
      () =>
        Effect.gen(function* () {
          const db = yield* Db.Db;
          const ids = range(2001, 150);
          f.seed(ids);
          const paidBefore = f.batches.paid.length;
          const submittedBefore = f.batches.submissions.length;
          const askedBefore = f.asked.length;
          const paused = yield* Deferred.make<void>();
          let captures = 0;
          const killing = Layer.succeed(
            Db.Db,
            Db.Db.of({
              ...db,
              knowledge: {
                ...db.knowledge,
                capture: (answers) =>
                  ++captures === 2
                    ? Deferred.succeed(paused, undefined).pipe(Effect.andThen(Effect.never))
                    : db.knowledge.capture(answers),
              },
            }),
          );
          const first = yield* run(ids.map(ref)).pipe(
            Effect.provide(Layer.fresh(Prefill.layer).pipe(Layer.provide(killing))),
            Effect.forkChild,
          );
          yield* Deferred.await(paused);
          yield* Fiber.interrupt(first);

          const [held] = yield* query(
            `select count(*) filter (where r.receipt_id is not null)::int as saved,
               count(*) filter (where r.enrich_retry_at = b.lease_until)::int as leased
             from repos r, extraction_batches b where r.id = any(b.repo_ids) and b.state = 'submitted'`,
          );
          expect(held).toEqual({ saved: 64, leased: 86 });

          // The sweep and a consumer that gets every manifest repo, such as from a user's star sync, pay for none.
          expect(yield* sweepAndConsume).toBe(0);
          const consumed = yield* Effect.flatMap(EnrichRepo.EnrichRepo, (enricher) =>
            enricher.enrichRepos(ids.map((n) => RepoId.make(n))),
          );
          expect(new Set(consumed.map((outcome) => outcome._tag))).toEqual(new Set(["Unchanged", "Backoff"]));
          expect(f.asked.length - askedBefore).toBe(0);

          const resumed = yield* run(ids.map(ref));
          expect(resumed.manifests).toEqual({ resumed: 1, dropped: 0, created: 0, closed: 1 });
          expect(tally(resumed)).toEqual({ saved: 86, done: 64 });
          expect(f.batches.submissions.slice(submittedBefore).map((submission) => submission.replayed)).toEqual([
            false,
            true,
          ]);
          expect(f.batches.paid.length - paidBefore).toBe(150);
          expect(f.asked.length - askedBefore).toBe(0);
          expect(
            yield* query(
              `select count(*)::int as receipts, count(distinct repo_id)::int as repos,
                 count(*) filter (where r.receipt_id = c.id)::int as current
               from receipts c join repos r on r.id = c.repo_id where c.repo_id between 2001 and 2150`,
            ),
          ).toEqual([{ receipts: 150, repos: 150, current: 150 }]);
          expect(yield* query("select state from extraction_batches where $1 = any(repo_ids)", [2001])).toEqual([
            { state: "captured" },
          ]);

          // Rerunning the finished run sends nothing, reads nothing from GitHub, and writes nothing.
          const requests = f.github.sent.length;
          const rerun = yield* run(ids.map(ref));
          expect(tally(rerun)).toEqual({ done: 150 });
          expect(rerun.manifests).toEqual({ resumed: 0, dropped: 0, created: 0, closed: 0 });
          expect(f.github.sent.length).toBe(requests);
          expect(f.batches.submissions.length - submittedBefore).toBe(2);
        }),
    );

    it.effect("asks an item the batch answered badly directly, and counts a repo whose answers never decode", () =>
      Effect.gen(function* () {
        f.seed([5001, 5002, 5003]);
        const invalid = { summary: "", keywords: [] };
        const names =
          (...numbers: ReadonlyArray<number>) =>
          (prompt: string) =>
            numbers.some((n) => prompt.startsWith(`Repository: owner/repo-${n}\n`));
        const batchBroken = names(5001, 5002);
        const alwaysBroken = names(5001);
        const asked: Array<string> = [];
        const models = Layer.merge(
          Fake.batches((prompt) => (batchBroken(prompt) ? invalid : SummarizeFake.respond(prompt)), "fake/summary")
            .layer,
          Fake.layerTextGeneration((prompt) => {
            asked.push(prompt);
            return alwaysBroken(prompt) ? invalid : SummarizeFake.respond(prompt);
          }, "fake/summary"),
        );
        const report = yield* run([ref(5001), ref(5002), ref(5003)]).pipe(
          Effect.provide(Layer.fresh(Prefill.layer).pipe(Layer.provide(models))),
        );
        expect(tally(report)).toEqual({ saved: 2, failed: 1 });
        expect(report.direct.map(Number).sort()).toEqual([5001, 5002]);
        expect(asked).toHaveLength(2);
        expect(
          yield* query(
            "select id::int, enrich_failures as failures, enrich_retry_at is not null as waiting, receipt_id is not null as saved from repos where id between 5001 and 5003 order by id",
          ),
        ).toEqual([
          { id: 5001, failures: 1, waiting: true, saved: false },
          { id: 5002, failures: 0, waiting: false, saved: true },
          { id: 5003, failures: 0, waiting: false, saved: true },
        ]);
        expect(yield* query("select state from extraction_batches where $1 = any(repo_ids)", [5001])).toEqual([
          { state: "captured" },
        ]);
      }),
    );

    it.effect("answers stale when facts move while the batch is open, and leaves the repo pending", () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        f.seed([3001, 3002]);
        const moved = Layer.succeed(
          Db.Db,
          Db.Db.of({
            ...db,
            knowledge: {
              ...db.knowledge,
              capture: (answers) =>
                Effect.gen(function* () {
                  const [row] = yield* db.repos.getMany([RepoId.make(3001)]);
                  if (row !== undefined) yield* db.repos.saveFacts({ ...row, description: "Moved on" });
                  return yield* db.knowledge.capture(answers);
                }),
            },
          }),
        );
        const report = yield* run([ref(3001), ref(3002)]).pipe(
          Effect.provide(Layer.fresh(Prefill.layer).pipe(Layer.provide(moved))),
        );
        expect(tally(report)).toEqual({ saved: 1, stale: 1 });
        expect(
          yield* query(
            "select id::int, enrich_retry_at is null as free, receipt_id is null as unsaved from repos where id in (3001, 3002) order by id",
          ),
        ).toEqual([
          { id: 3001, free: true, unsaved: true },
          { id: 3002, free: true, unsaved: false },
        ]);
      }),
    );

    it.effect("drops a manifest whose request was never stored, and prefills its repos again", () =>
      Effect.gen(function* () {
        const blobs = yield* BlobStore.BlobStore;
        f.seed([4001, 4002]);
        const submitted = f.batches.submissions.length;
        const lost = Layer.succeed(
          BlobStore.BlobStore,
          BlobStore.BlobStore.of({
            get: blobs.get,
            put: (key, value) =>
              key.startsWith("prefill/")
                ? Effect.fail(new BlobStore.BlobStoreFailed({ operation: "put", key, cause: null }))
                : blobs.put(key, value),
          }),
        );
        const failed = yield* Effect.flip(
          run([ref(4001), ref(4002)]).pipe(Effect.provide(Layer.fresh(Prefill.layer).pipe(Layer.provide(lost)))),
        );
        expect(failed._tag).toBe("BlobStoreFailed");
        expect(yield* query("select count(*)::int as open from extraction_batches where state = 'prepared'")).toEqual([
          { open: 1 },
        ]);
        const report = yield* run([ref(4001), ref(4002)]);
        expect(report.manifests).toEqual({ resumed: 0, dropped: 1, created: 1, closed: 1 });
        expect(tally(report)).toEqual({ saved: 2 });
        expect(f.batches.submissions.length - submitted).toBe(1);
      }),
    );
  });
}
