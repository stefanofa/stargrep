import { expect } from "bun:test";
import * as it from "@stargrep/testing";
import * as Effect from "effect/Effect";
import { adapters, fixture, query, range, ref, run } from "../src/repos/prefill.fixture.ts";
import * as Gates from "./pilot-gates.ts";

const row = (id: number, overrides: Partial<Gates.SampleRow>): Gates.SampleRow => ({
  id,
  owner: "owner",
  name: `repo-${id}`,
  hasReadme: true,
  hasKind: true,
  hasAbout: true,
  lanes: null,
  claims: null,
  carried: null,
  capturedAt: null,
  asked: true,
  retried: false,
  failed: false,
  legacy: true,
  altKeys: [],
  ...overrides,
});

it.effect("compares the prod repos' answers that never decode with the ones their recipe 1 never gave", () =>
  Effect.sync(() => {
    const prod = new Set([1, 2, 3]);
    const rows = [row(1, {}), row(2, { retried: true }), row(3, { retried: true, failed: true }), row(4, {})];
    expect(Gates.againstRecipeOne(rows, prod)).toEqual({
      asked: 3,
      retried: 2,
      failed: [3],
      prod: 3,
      recipeOneFailed: 0,
      pass: false,
    });
    expect(Gates.againstRecipeOne([row(1, {}), row(2, { failed: true, legacy: false })], new Set([1, 2])).pass).toBe(
      true,
    );
    expect(Gates.strataOf("# header\n1 owner/repo-1 prod\n2 owner/repo-2 comparison\n")).toEqual(
      new Map([
        [1, "prod"],
        [2, "comparison"],
      ]),
    );
  }),
);

for (const [adapter, database] of adapters) {
  const f = fixture();

  it.layer(f.layer(database), { timeout: 60_000 })(`pilot gates on ${adapter}`, (it) => {
    it.effect("counts a repo whose answer never decodes over every repo the run asked", () =>
      Effect.gen(function* () {
        const ids = range(31001, 3);
        f.seed(ids);
        f.broken.always.add(31002);
        f.broken.once.add(31003);
        yield* run(ids.map(ref));
        f.broken.always.delete(31002);
        yield* query(
          `insert into receipts (id, repo_id, source, input_hash, recipe, model, summary, keywords, claims, lanes)
           values ('00000000-0000-4000-8000-000000031001', 31001, 'legacy', repeat('a', 64), 1, 'legacy', 'Old',
             '[]', '[]', '{}')`,
        );
        const rows = yield* Gates.decodeSampleRows(yield* query(Gates.sampleRows, [ids, Gates.recipe]));
        expect(Gates.decodeGate(rows)).toEqual({ asked: 3, retried: 2, failed: [31002] });
        expect(rows.filter((sampled) => sampled.legacy).map((sampled) => sampled.id)).toEqual([31001]);
        expect(yield* Gates.decodeRepeated(yield* query(Gates.repeatedAsks, [ids, Gates.recipe]))).toEqual([
          { repeated: 0 },
        ]);
      }),
    );
  });
}
