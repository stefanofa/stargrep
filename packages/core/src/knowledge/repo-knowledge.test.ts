import { expect } from "bun:test";
import * as Db from "@stargrep/db";
import { DbQueryFailed } from "@stargrep/db/errors";
import * as TestDatabase from "@stargrep/db/test-database";
import type { RepoId } from "@stargrep/github/schemas";
import type { Atom } from "@stargrep/knowledge/atom";
import { decodeFacets } from "@stargrep/knowledge/claims";
import type { ReceiptId } from "@stargrep/knowledge/ids";
import * as it from "@stargrep/testing";
import * as Effect from "effect/Effect";
import {
  create,
  embeddingModel,
  heldBy,
  inputHash,
  readmeOid,
  record,
  repoId,
  seed,
  split,
  staleAmong,
  sweepAll,
} from "./knowledge.fixture.ts";
import * as RepoKnowledge from "./repo-knowledge.ts";

it.layer(TestDatabase.layerMemory({ embeddingModel }), { timeout: 60_000, testTimeout: 60_000 })(
  "RepoKnowledge",
  (it) => {
    it.effect("projects repos from GitHub facts alone, with no receipt, and leaves nothing stale", () =>
      Effect.gen(function* () {
        const database = yield* TestDatabase.TestDatabase;
        const ids = yield* seed([
          { id: 501, language: "TypeScript", license: "MIT", topics: ["react", "typescript", "cli", "linux"] },
          { id: 502 },
          { id: 503, language: "Dockerfile", license: "NOASSERTION", topics: ["nodejs"] },
        ]);
        yield* sweepAll;
        expect(yield* staleAmong(ids)).toBe(0);
        expect(
          yield* database.query(
            `select r.id::float8 as id, r.written_in::text[] as "writtenIn", r.licensed::text[] as licensed,
             r.for_languages::text[] as "forLanguages", r.runs_on::text[] as "runsOn", r.kinds::text[] as kinds,
             f.unresolved_keys as unresolved, f.receipt_id as receipt
           from repos r join repo_facets f on f.repo_id = r.id where r.id = any($1::bigint[]) order by r.id`,
            [ids],
          ),
        ).toEqual([
          {
            id: 501,
            writtenIn: ["typescript"],
            licensed: ["MIT"],
            forLanguages: ["typescript"],
            runsOn: ["linux"],
            kinds: [],
            unresolved: ["react"],
            receipt: null,
          },
          {
            id: 502,
            writtenIn: [],
            licensed: [],
            forLanguages: [],
            runsOn: [],
            kinds: [],
            unresolved: [],
            receipt: null,
          },
          {
            id: 503,
            writtenIn: [],
            licensed: [],
            forLanguages: [],
            runsOn: ["node"],
            kinds: [],
            unresolved: [],
            receipt: null,
          },
        ]);
        expect(yield* RepoKnowledge.reproject()).toEqual({ projected: 0, minted: 0, conflicts: 0 });
        yield* database.query(`update repos set topics = '["macos"]' where id = 502`);
        expect(yield* RepoKnowledge.reproject()).toEqual({ projected: 1, minted: 0, conflicts: 0 });
        expect(yield* database.query("select runs_on::text[] as runs from repos where id = 502")).toEqual([
          { runs: ["macos"] },
        ]);
      }),
    );

    it.effect("projects at most its groups per run, lowest ID first, and the next run picks up the rest", () =>
      Effect.gen(function* () {
        const ids = yield* seed([601, 602, 603, 604, 605].map((id) => ({ id, language: "Go" })));
        expect(yield* RepoKnowledge.reproject({ groupSize: 2, groups: 2 })).toEqual({
          projected: 4,
          minted: 0,
          conflicts: 0,
        });
        expect(yield* staleAmong(ids)).toBe(1);
        expect(yield* staleAmong([repoId(605)])).toBe(1);
        expect(yield* RepoKnowledge.reproject({ groupSize: 2, groups: 2 })).toEqual({
          projected: 1,
          minted: 0,
          conflicts: 0,
        });
      }),
    );

    it.effect(
      "mints what a receipt's claims need, projects the claims, and re-marks a repo whose topic missed the key",
      () =>
        Effect.gen(function* () {
          const database = yield* TestDatabase.TestDatabase;
          const [early, minter] = yield* seed([
            { id: 701, topics: ["edge rendering"] },
            {
              id: 702,
              facets: [
                { role: "about", term: "Edge rendering" },
                { role: "is", term: "library" },
              ],
            },
          ]);
          expect(yield* RepoKnowledge.projectRepos([early as RepoId])).toEqual({ projected: 1, minted: 0 });
          expect(yield* RepoKnowledge.projectRepos([minter as RepoId])).toEqual({ projected: 1, minted: 1 });
          expect(yield* staleAmong([early as RepoId])).toBe(1);
          yield* sweepAll;
          expect(yield* heldBy([early as RepoId, minter as RepoId], "")).toEqual([
            ["tagged:subject:Edge rendering"],
            ["about:subject:Edge rendering", "is:kind:library"],
          ]);
          const verdicts = yield* database.query("select verdicts from receipts where repo_id = 702");
          expect(verdicts).toEqual([
            {
              verdicts: [
                {
                  claim: { from: "receipt", ordinal: 0 },
                  outcome: "used",
                  reason: "label",
                  atom: expect.stringMatching(/^about:subject:\d+$/),
                },
                {
                  claim: { from: "receipt", ordinal: 1 },
                  outcome: "used",
                  reason: "closed-value",
                  atom: "kind:library",
                },
              ],
            },
          ]);
        }),
    );

    it.effect("reads the decision log back as the Decision schema decodes it, with the subject each one created", () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        const id = yield* create("logged subject");
        const logged = (yield* db.knowledge.decisions).at(-1);
        expect(logged).toEqual({
          revision: yield* db.knowledge.revision,
          decision: { _tag: "Create", label: "logged subject", definition: "", aliases: [], status: "accepted" },
          created: id,
        });
      }),
    );

    it.effect("a decision that lands between two groups of one sweep reaches the later group", () =>
      Effect.gen(function* () {
        yield* sweepAll;
        const db = yield* Db.Db;
        const [first, second] = yield* seed([
          { id: 951, language: "Go" },
          { id: 952, language: "Go" },
        ]);
        const curated = yield* create("between groups");
        const atom: Atom = { role: "about", value: { dim: "subject", id: curated } };
        // A second writer records a correction for the second repo after the first group commits.
        const correct = record({ _tag: "Correct", repo: second as number, atom, present: true }).pipe(
          Effect.provideService(Db.Db, db),
          Effect.orDie,
        );
        let groups = 0;
        const landing = Db.Db.of({
          ...db,
          knowledge: {
            ...db.knowledge,
            stale: (limit) =>
              Effect.gen(function* () {
                if (groups++ === 1) yield* correct;
                return yield* db.knowledge.stale(limit);
              }),
          },
        });
        const result = yield* RepoKnowledge.reproject({ groupSize: 1, groups: 2 }).pipe(
          Effect.provideService(Db.Db, landing),
        );
        expect(result).toEqual({ projected: 2, minted: 0, conflicts: 0 });
        expect(yield* heldBy([first as RepoId, second as RepoId], "")).toEqual([
          ["written_in:language:go"],
          ["about:subject:between groups", "written_in:language:go"],
        ]);
      }),
    );

    it.effect("a group that loses a deadlock leaves its rows stale for the next group, and the run goes on", () =>
      Effect.gen(function* () {
        yield* sweepAll;
        const db = yield* Db.Db;
        const ids = yield* seed([961, 962, 963].map((id) => ({ id, language: "Rust" })));
        const failing = (reason: DbQueryFailed["reason"], times: number) => {
          let left = times;
          const project: Db.Db["Service"]["knowledge"]["project"] = (repoIds, compute) =>
            left-- > 0
              ? Effect.fail(new DbQueryFailed({ operation: "knowledge.project", reason, sqlState: "40P01" }))
              : db.knowledge.project(repoIds, compute);
          return Db.Db.of({ ...db, knowledge: { ...db.knowledge, project } });
        };
        const lost = yield* RepoKnowledge.reproject({ groupSize: 2, groups: 5 }).pipe(
          Effect.provideService(Db.Db, failing("conflict", 1)),
        );
        expect(lost).toEqual({ projected: 3, minted: 0, conflicts: 1 });
        expect(yield* staleAmong(ids)).toBe(0);
        const broken = yield* seed([{ id: 964, language: "Rust" }]);
        const failure = yield* RepoKnowledge.reproject().pipe(
          Effect.provideService(Db.Db, failing("transport", 1)),
          Effect.flip,
        );
        expect(failure).toMatchObject({ _tag: "DbQueryFailed", reason: "transport" });
        expect(yield* staleAmong(broken)).toBe(1);
        yield* sweepAll;
      }),
    );

    // The rows the sweep converges to must not depend on the order repos were first projected in. The fixture covers
    // every input projection reads: a topic that matches a key another repo's claim mints, a split rule, a correction,
    // closed values in for and in comparisons, and GitHub facts.
    it.effect("projecting a fixture in random order and sweeping equals projecting it in ID order", () =>
      Effect.gen(function* () {
        const next = (() => {
          let state = 20261108;
          return () => {
            state = (state * 1103515245 + 12345) % 2147483648;
            return state / 2147483648;
          };
        })();
        const orders: Array<ReadonlyArray<number>> = [[0, 1, 2, 3, 4, 5, 6]];
        for (let run = 0; run < 8; run++) {
          orders.push(
            [0, 1, 2, 3, 4, 5, 6]
              .map((n) => [next(), n] as const)
              .sort(([a], [b]) => a - b)
              .map(([, n]) => n),
          );
        }
        const outcomes: Array<ReadonlyArray<ReadonlyArray<string>>> = [];
        for (const [run, order] of orders.entries()) {
          const tag = `t${run}`;
          const agent = yield* create(`user agent ${tag}`);
          yield* split(agent, `user agent parsing ${tag}`, ["browser", "user-agent"]);
          const curated = yield* create(`curated ${tag}`);
          const base = 800 + run * 10;
          const atom: Atom = { role: "about", value: { dim: "subject", id: curated } };
          yield* record({ _tag: "Correct", repo: base + 5, atom, present: true });
          const ids = yield* seed([
            { id: base, language: "Rust", license: "MIT", topics: [`acme widget protocol ${tag}`] },
            {
              id: base + 1,
              facets: [
                { role: "is", term: "library" },
                { role: "for", term: "Node.js" },
                { role: "about", term: `unsignalled capability ${tag}` },
              ],
            },
            {
              id: base + 2,
              facets: [
                { role: "about", term: `acme widget protocol ${tag}` },
                { role: "about", term: `unsignalled capability ${tag}` },
                { role: "alternative_to", term: `zapier ${tag}` },
                { role: "alternative_to", term: "Deno" },
              ],
            },
            {
              id: base + 3,
              topics: [`unsignalled capability ${tag}`],
              facets: [{ role: "about", term: `user agent ${tag}`, quote: "parses browser user-agent strings" }],
            },
            { id: base + 4, facets: [{ role: "about", term: `user agent ${tag}`, quote: "an AI agent that browses" }] },
            { id: base + 5, topics: ["linux"], facets: [{ role: "is", term: "cli" }] },
            { id: base + 6, topics: [`zapier ${tag}`] },
          ]);
          for (const position of order) yield* RepoKnowledge.projectRepos([ids[position] as RepoId]);
          yield* sweepAll;
          expect(yield* staleAmong(ids)).toBe(0);
          outcomes.push(yield* heldBy(ids, tag));
        }
        const expected = [
          ["licensed:license:MIT", "tagged:subject:acme widget protocol", "written_in:language:rust"],
          ["about:subject:unsignalled capability", "for:platform:node", "is:kind:library"],
          [
            "about:subject:acme widget protocol",
            "about:subject:unsignalled capability",
            "alternative_to:platform:deno",
            "alternative_to:subject:zapier",
          ],
          ["about:subject:user agent parsing", "tagged:subject:unsignalled capability"],
          ["about:subject:user agent"],
          ["about:subject:curated", "is:kind:cli", "runs_on:platform:linux"],
          ["tagged:subject:zapier"],
        ];
        expect(outcomes).toEqual(orders.map(() => expected));
      }),
    );

    it.effect("the nightly count lists a subject two repos hold and no other", () =>
      Effect.gen(function* () {
        const database = yield* TestDatabase.TestDatabase;
        const changed = yield* RepoKnowledge.count();
        expect(changed.changed).toBeGreaterThan(0);
        const listed = yield* database.query(
          `select label, repo_count as repos, listed from subjects
         where label in ('unsignalled capability t0', 'zapier t0', 'user agent parsing t0', 'user agent t0', 'curated t0')
         order by label`,
        );
        expect(listed).toEqual([
          { label: "curated t0", repos: 1, listed: false },
          { label: "unsignalled capability t0", repos: 3, listed: true },
          { label: "user agent parsing t0", repos: 1, listed: false },
          { label: "user agent t0", repos: 2, listed: true },
          { label: "zapier t0", repos: 2, listed: true },
        ]);
        expect(yield* RepoKnowledge.count()).toEqual({ changed: 0 });
      }),
    );
  },
);

it.layer(TestDatabase.layerMemory({ embeddingModel }), { timeout: 60_000, testTimeout: 60_000 })(
  "RepoKnowledge.accept",
  (it) => {
    const input = { fullName: "probe/repo", description: "A CLI for terminal dashboards", topics: [], readme: "" };
    const paid = (id: number, facets: unknown, overrides: Partial<RepoKnowledge.Paid> = {}): RepoKnowledge.Paid => ({
      repoId: repoId(id),
      readmeOid,
      inputHash,
      source: "stand-in",
      model: "recorded-no-model-call",
      answer: { summary: `summary of ${id}`, keywords: ["dashboards"], facets: decodeFacets(facets, input) },
      lease: null,
      ...overrides,
    });
    const row = (id: number) =>
      Effect.flatMap(TestDatabase.TestDatabase, (database) =>
        database.query(
          `select r.summary, r.kinds::text[] as kinds, f.stale, cardinality(f.about) as about,
             (select count(*)::int from receipts c where c.repo_id = r.id) as receipts
           from repos r left join repo_facets f on f.repo_id = r.id where r.id = $1`,
          [id],
        ),
      );

    it.effect("saves the summary and the receipt, then projects the repo's atoms at once", () =>
      Effect.gen(function* () {
        yield* seed([{ id: 81_001 }]);
        const accepted = yield* RepoKnowledge.accept([
          paid(81_001, [
            { role: "is", term: "CLI" },
            { role: "about", term: "terminal dashboards" },
          ]),
        ]);
        expect(accepted).toEqual({
          captured: [
            RepoKnowledge.Captured.Saved({
              repoId: repoId(81_001),
              receiptId: expect.any(String) as unknown as ReceiptId,
              summary: "summary of 81001",
              keywords: ["dashboards"],
            }),
          ],
          projected: true,
        });
        expect(yield* row(81_001)).toEqual([
          { summary: "summary of 81001", kinds: ["cli"], stale: false, about: 1, receipts: 1 },
        ]);
      }),
    );

    it.effect("keeps an answer to inputs that moved on, or for a gone repo, as history and returns Stale", () =>
      Effect.gen(function* () {
        const database = yield* TestDatabase.TestDatabase;
        yield* seed([{ id: 81_002 }, { id: 81_003 }]);
        yield* database.query("update repos set input_hash = $2 where id = $1", [81_002, "c".repeat(64)]);
        yield* database.query("update repos set gone_at = now() where id = $1", [81_003]);
        const accepted = yield* RepoKnowledge.accept([
          paid(81_002, [{ role: "is", term: "CLI" }]),
          paid(81_003, [{ role: "is", term: "CLI" }]),
        ]);
        expect(accepted.captured).toEqual([
          RepoKnowledge.Captured.Stale({ repoId: repoId(81_002) }),
          RepoKnowledge.Captured.Stale({ repoId: repoId(81_003) }),
        ]);
        expect(yield* row(81_002)).toEqual([{ summary: null, kinds: [], stale: true, about: 0, receipts: 1 }]);
        expect(yield* row(81_003)).toMatchObject([{ summary: null, kinds: [], receipts: 1 }]);
        expect(yield* RepoKnowledge.capture([paid(81_009, [])])).toEqual([
          RepoKnowledge.Captured.NotFound({ repoId: repoId(81_009) }),
        ]);
      }),
    );

    it.effect("when projection fails after commit A, the summary stays saved and the sweep projects it", () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        yield* seed([{ id: 81_004 }]);
        const failing = Db.Db.of({
          ...db,
          knowledge: {
            ...db.knowledge,
            project: () =>
              Effect.fail(new DbQueryFailed({ operation: "knowledge.project", reason: "transport", sqlState: null })),
          },
        });
        const accepted = yield* RepoKnowledge.accept([paid(81_004, [{ role: "is", term: "library" }])]).pipe(
          Effect.provideService(Db.Db, failing),
        );
        expect(accepted).toMatchObject({ captured: [{ _tag: "Saved" }], projected: false });
        expect(yield* row(81_004)).toEqual([
          { summary: "summary of 81004", kinds: [], stale: true, about: 0, receipts: 1 },
        ]);

        // The sweep reads the receipt, with no model in its context.
        expect(yield* RepoKnowledge.reproject()).toMatchObject({ conflicts: 0 });
        expect(yield* row(81_004)).toEqual([
          { summary: "summary of 81004", kinds: ["library"], stale: false, about: 0, receipts: 1 },
        ]);
      }),
    );
  },
);
