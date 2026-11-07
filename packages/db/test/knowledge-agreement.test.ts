import { expect } from "bun:test";
import type { RepoId } from "@stargrep/github/schemas";
import { formatAtom } from "@stargrep/knowledge/atom";
import type { SubjectId } from "@stargrep/knowledge/ids";
import { type ClosedDim, closed, Dim, defaultRoles, type RoleId, roleIds, roles } from "@stargrep/knowledge/registry";
import * as it from "@stargrep/testing";
import * as Effect from "effect/Effect";
import * as Db from "../src/db.ts";
import { atomColumns } from "../src/schema.ts";
import * as TestDatabase from "./database.ts";
import { model, repoId } from "./fixtures.ts";
import { atom, decide, projectAtoms, revision, seedRepos } from "./knowledge-fixtures.ts";

type Services = Db.Db | Db.Transactions | TestDatabase.TestDatabase;

// mulberry32: a seeded generator, so a failing seed reproduces.
const generator = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};

const columnOf = (role: RoleId, dim: Dim): string => {
  const column = (atomColumns[role] as Partial<Record<Dim, string>>)[dim];
  if (column === undefined) throw new Error(`role ${role} has no ${dim} column`);
  return column;
};

// The predicate table search.md generates, from the registry: each atom form, the arrays it reads, whether it widens
// through Parent, Expand, and closed expansions, and whether the self rule applies.
interface Form {
  readonly role: RoleId | "any";
  readonly columns: ReadonlyArray<string>;
  readonly widen: boolean;
  readonly comparison: boolean;
}

const formsOf = (dim: Dim): ReadonlyArray<Form> => {
  const bare = defaultRoles(dim);
  const own = roleIds
    .filter((role) => roles[role].accepts.includes(dim) && !(bare.length === 1 && bare[0] === role))
    .map((role) => ({
      role,
      columns: [columnOf(role, dim)],
      widen: roles[role].matches !== "comparison",
      comparison: roles[role].matches === "comparison",
    }));
  return [{ role: "any", columns: bare.map((role) => columnOf(role, dim)), widen: true, comparison: false }, ...own];
};

const membershipCases = (test: { readonly effect: it.Tester<Services> }) => {
  // Five random vocabularies of 120 subjects with merges, rejections, links, and split, parent, and expand edges, and
  // 300 repos each. For every subject in every atom form, the repos matching_atoms lists equal the repos the search
  // predicate returns.
  const forms = formsOf("subject");
  for (const seed of [11, 22, 33, 44, 55]) {
    test.effect(`matching_atoms and the search predicates agree on every subject atom, vocabulary ${seed}`, () =>
      Effect.gen(function* () {
        const db = yield* Db.Db;
        const database = yield* TestDatabase.TestDatabase;
        const repoIds = Array.from({ length: 300 }, (_, index) => repoId(80_001 + index));
        const random = generator(seed);
        const pick = <A>(items: ReadonlyArray<A>) => items[Math.floor(random() * items.length)] as A;
        for (const statement of [
          "delete from repos where id between 80001 and 80300",
          "delete from subject_matches",
          "delete from subject_closure",
          "delete from subject_canonical",
          "update subjects set repo_id = null",
          "delete from subjects",
        ]) {
          yield* database.query(statement);
        }
        yield* seedRepos(repoIds.map((id) => ({ id })));
        const ids = yield* db.knowledge.allocate(120);
        const at = (index: number) => ids[index - 1] as SubjectId;
        const parent = new Map<number, { readonly parent: number; readonly via: "split" | "parent" | "expand" }>();
        for (let child = 22; child <= 120; child++) {
          if (random() < 0.7) {
            parent.set(child, {
              parent: 21 + Math.floor(random() * (child - 21)),
              via: pick(["split", "parent", "expand"]),
            });
          }
        }
        const edges: Array<Db.VocabularyChange["edgesAdded"][number]> = [];
        const decided = revision((yield* db.knowledge.revision) + 1);
        for (const [descendant, first] of parent) {
          let { parent: ancestor, via } = first;
          for (let depth = 1; depth <= 3; depth++) {
            edges.push({
              ancestorId: at(ancestor),
              descendantId: at(descendant),
              depth: depth as 1 | 2 | 3,
              via,
              revision: decided,
            });
            const up = parent.get(ancestor);
            if (up === undefined) break;
            via =
              via === "split" && up.via === "split"
                ? "split"
                : via === "expand" || up.via === "expand"
                  ? "expand"
                  : "parent";
            ancestor = up.parent;
          }
        }
        const status = ids.map(() => (random() < 0.1 ? ("rejected" as const) : ("accepted" as const)));
        const merged = Array.from({ length: 20 }, (_, index) => index + 1)
          .filter(() => random() < 0.8)
          .map((origin) => ({
            originId: at(origin),
            canonicalId: at(21 + Math.floor(random() * 100)),
            revision: decided,
          }));
        // Distinct repos, because a repo is linked to at most one subject.
        const links = new Map<number, RepoId>();
        for (let index = 21; index <= 120; index++) {
          if (random() < 0.15) links.set(index, repoIds[2 * index] as RepoId);
        }
        yield* decide("create", {
          created: ids.map((id, index) => ({
            id,
            label: `s${index + 1}`,
            definition: null,
            status: status[index] ?? "accepted",
          })),
          presented: [...links].map(([index, repo]) => ({
            id: at(index),
            label: `s${index}`,
            definition: null,
            status: status[index - 1] ?? "accepted",
            repoId: repo,
          })),
          merged,
          edgesAdded: edges,
        });
        const any = () => at(1 + Math.floor(random() * 120));
        const linkedTo = new Map([...links].map(([index, repo]) => [repo, at(index)]));
        const held = new Map(
          repoIds.map((repo) => {
            const subjects = (role: RoleId, count: number) =>
              Array.from({ length: count }, () => atom(role, { dim: "subject", id: any() }));
            const self = linkedTo.get(repo);
            return [
              repo,
              [
                ...subjects("about", 3),
                ...subjects("for", 2),
                ...subjects("trait", 1),
                ...subjects("tagged", 1),
                ...subjects("built_with", 2),
                ...subjects("alternative_to", 2),
                ...subjects("replaced_by", 1),
                // A repo linked to a subject also names it as its alternative, so self-comparisons occur.
                ...(self === undefined ? [] : [atom("alternative_to", { dim: "subject", id: self })]),
              ],
            ] as const;
          }),
        );
        yield* projectAtoms((repo) => held.get(repo.id) ?? [], repoIds);
        const prefixes = forms.map((form) =>
          formatAtom({ role: form.role, value: { dim: "subject", id: 1 as SubjectId } }).slice(0, -1),
        );
        const predicate = forms
          .map((form, index) => {
            const arrays = form.columns.map((column) => `f.${column}`).join(" || ");
            const hit = form.comparison
              ? `exists (select 1 from unnest(${arrays}) as o (id) where o.id = any (t.origins)
                   and not exists (select 1 from knowledge_self_origins x where x.repo_id = f.repo_id and x.origin_id = o.id))`
              : `(${arrays}) && t.origins`;
            return `when ${index} then ${hit}`;
          })
          .join("\n");
        // JIT compiles this one statement for most of a second on pg, longer than it runs, so the check turns it off.
        yield* database.query(
          `create or replace function agreement(form_prefixes text[], form_widen boolean[])
           returns table (checked int, mismatches int, nonempty int) language sql set jit = off as $check$
           with forms as (
             select ordinality - 1 as form, prefix, widen
             from unnest(form_prefixes, form_widen) with ordinality as f (prefix, widen)
           ),
           targets as materialized (
             select s.id, coalesce(c.canonical_id, s.id) as canonical, f.form, f.prefix,
               knowledge_origins(array[s.id], f.widen) as origins
             from subjects s left join subject_canonical c on c.origin_id = s.id cross join forms f
           ),
           listed as (
             select atom, array_agg(distinct repo_id order by repo_id) as repos from matching_atoms
             where atom like '%subject:%' group by atom
           ),
           searched as (
             select t.*, coalesce((
               select array_agg(f.repo_id order by f.repo_id) from repo_facets f
               where case t.form ${predicate} end
             ), '{}') as repos
             from targets t
           )
           select count(*)::int as checked,
             count(*) filter (where coalesce(l.repos, '{}') is distinct from s.repos)::int as mismatches,
             count(*) filter (where cardinality(s.repos) > 0)::int as nonempty
           from searched s left join listed l on l.atom = s.prefix || s.canonical
           $check$`,
        );
        const [result] = yield* database.query("select * from agreement($1::text[], $2::boolean[])", [
          prefixes,
          forms.map((form) => form.widen),
        ]);
        const { checked, mismatches, nonempty } = result as { checked: number; mismatches: number; nonempty: number };
        expect({ checked, mismatches }).toEqual({ checked: 120 * forms.length, mismatches: 0 });
        expect(nonempty).toBeGreaterThan(checked / 2);
      }),
    );
  }
};

// Both sides of one subject atom: the repos matching_atoms lists under its key, and the repos its search predicate
// returns from repo_facets.
const bothSides = Effect.fn("bothSides")(function* (role: RoleId | "any", id: SubjectId) {
  const database = yield* TestDatabase.TestDatabase;
  const form = formsOf("subject").find((candidate) => candidate.role === role);
  if (form === undefined) return yield* Effect.die(new Error(`no ${role} form`));
  const arrays = form.columns.map((column) => `f.${column}`).join(" || ");
  const hit = form.comparison
    ? `exists (select 1 from unnest(${arrays}) as o (id) where o.id = any (g.origins)
         and not exists (select 1 from knowledge_self_origins x where x.repo_id = f.repo_id and x.origin_id = o.id))`
    : `(${arrays}) && g.origins`;
  const [searched] = yield* database.query(
    `with g as materialized (select knowledge_origins(array[$1]::bigint[], $2) as origins)
     select coalesce(array_agg(f.repo_id::float8 order by f.repo_id), '{}') as repos from repo_facets f, g where ${hit}`,
    [id, form.widen],
  );
  const [listed] = yield* database.query(
    `select coalesce(array_agg(distinct repo_id::float8 order by repo_id::float8), '{}') as repos from matching_atoms
     where atom = $1`,
    [formatAtom({ role, value: { dim: "subject", id } })],
  );
  return {
    matchingAtoms: (listed as { repos: Array<number> }).repos,
    search: (searched as { repos: Array<number> }).repos,
  };
});

const namedCases = (test: { readonly effect: it.Tester<Services> }) => {
  // The divergences three reviewers found in revision 1, each with the repos its intent requires: a rejected parent
  // matches nothing (opus 7 A, grok 3), a comparison skips the repo that is its own target (opus 7 B, grok 4), a
  // role-qualified atom widens through a parent (opus 7 C), and the self rule follows a link moved between a split
  // child and its broad subject (sol 4).
  test.effect("search and matching_atoms return the repos each reviewed case requires", () =>
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const names = [
        "databases",
        "vector databases",
        "Redis",
        "Redis server",
        "PostgreSQL",
        "pgvector",
        "agent",
        "user agent",
        "Slack",
        "Slack clone",
        "Mattermost",
        "rejected parent",
        "accepted child",
      ] as const;
      const ids = yield* db.knowledge.allocate(names.length);
      const s = (name: (typeof names)[number]) => ids[names.indexOf(name)] as SubjectId;
      const r = (n: number) => repoId(76_000 + n);
      yield* seedRepos([1, 10, 20, 21, 22, 30, 41, 42, 100, 200, 400].map((n) => ({ id: 76_000 + n })));
      const rejected = new Set<string>(["databases", "rejected parent"]);
      const links = new Map<string, RepoId>([
        ["Redis server", r(20)],
        ["user agent", r(41)],
        ["Slack clone", r(100)],
        ["Mattermost", r(400)],
      ]);
      const decided = revision((yield* db.knowledge.revision) + 1);
      const edge = (ancestor: (typeof names)[number], descendant: (typeof names)[number], via: "split" | "parent") => ({
        ancestorId: s(ancestor),
        descendantId: s(descendant),
        depth: 1 as const,
        via,
        revision: decided,
      });
      const created = (name: (typeof names)[number]) => ({
        id: s(name),
        label: name,
        definition: null,
        status: rejected.has(name) ? ("rejected" as const) : ("accepted" as const),
      });
      const presentation = (name: (typeof names)[number], repo: RepoId | null) => ({ ...created(name), repoId: repo });
      yield* decide("create", {
        created: names.map(created),
        presented: [...links].map(([name, repo]) => presentation(name as (typeof names)[number], repo)),
        edgesAdded: [
          edge("databases", "vector databases", "parent"),
          edge("Redis", "Redis server", "split"),
          edge("PostgreSQL", "pgvector", "parent"),
          edge("agent", "user agent", "split"),
          edge("Slack", "Slack clone", "split"),
          edge("rejected parent", "accepted child", "parent"),
        ],
      });
      const subject = (role: RoleId, name: (typeof names)[number]) => atom(role, { dim: "subject", id: s(name) });
      const held = new Map<RepoId, ReadonlyArray<Db.StoredAtom>>([
        [r(1), [subject("about", "vector databases")]],
        [r(20), [subject("alternative_to", "Redis server")]],
        [r(22), [subject("alternative_to", "Redis server")]],
        [r(21), [subject("alternative_to", "Redis")]],
        [r(30), [subject("for", "pgvector")]],
        [r(41), [subject("alternative_to", "user agent")]],
        [r(42), [subject("alternative_to", "user agent")]],
        [r(100), [subject("alternative_to", "Slack clone")]],
        [r(200), [subject("alternative_to", "Slack clone")]],
        [r(400), [subject("alternative_to", "Mattermost")]],
        [r(10), [subject("about", "accepted child")]],
      ]);
      yield* projectAtoms((repo) => held.get(repo.id) ?? [], [...held.keys()]);
      const required = (repos: ReadonlyArray<number>) => {
        const expected = repos.map(r);
        return { matchingAtoms: expected, search: expected };
      };
      expect(yield* bothSides("any", s("databases"))).toEqual(required([]));
      expect(yield* bothSides("any", s("rejected parent"))).toEqual(required([]));
      expect(yield* bothSides("alternative_to", s("Redis"))).toEqual(required([21, 22]));
      expect(yield* bothSides("for", s("PostgreSQL"))).toEqual(required([30]));
      expect(yield* bothSides("any", s("PostgreSQL"))).toEqual(required([30]));
      expect(yield* bothSides("alternative_to", s("agent"))).toEqual(required([42]));
      expect(yield* bothSides("alternative_to", s("Slack"))).toEqual(required([200]));
      expect(yield* bothSides("alternative_to", s("Mattermost"))).toEqual(required([]));

      yield* decide("link", { presented: [presentation("user agent", null), presentation("agent", r(41))] });
      expect(yield* bothSides("alternative_to", s("agent"))).toEqual(required([41, 42]));
    }),
  );
};

const closedCases = (test: { readonly effect: it.Tester<Services> }) => {
  // 600 repos with random closed arrays, 30 of them gone. For every atom form of every value tried, the repos
  // matching_atoms lists equal the repos the generated array predicate on repos returns.
  test.effect("matching_atoms and the closed array predicates agree on every closed atom over random repos", () =>
    Effect.gen(function* () {
      const database = yield* TestDatabase.TestDatabase;
      const random = generator(303);
      const repoIds = Array.from({ length: 600 }, (_, index) => repoId(90_001 + index));
      yield* seedRepos(repoIds.map((id) => ({ id })));
      const tried: Readonly<Record<ClosedDim, ReadonlyArray<string>>> = {
        kind: closed.kind.map((value) => value.id),
        language: ["javascript", "typescript", "python", "rust", "go", "powershell", "shell"],
        license: ["MIT", "Apache-2.0", "GPL-3.0"],
        platform: closed.platform.map((value) => value.id),
        status: closed.status.map((value) => value.id),
      };
      const sample = (dim: ClosedDim, upTo: number) => {
        const pool = [...tried[dim]];
        return Array.from(
          { length: Math.min(Math.floor(random() * (upTo + 1)), pool.length) },
          () => pool.splice(Math.floor(random() * pool.length), 1)[0] ?? "",
        );
      };
      const limit: Readonly<Record<string, number>> = { kinds: 2, licensed: 1 };
      const held = new Map(
        repoIds.map((repo) => [
          repo,
          roleIds.flatMap((role) =>
            roles[role].accepts.flatMap((dim) =>
              dim === "subject"
                ? []
                : sample(dim, limit[columnOf(role, dim)] ?? 2).map((id) =>
                    atom(role, { dim, id } as Db.StoredAtom["value"]),
                  ),
            ),
          ),
        ]),
      );
      yield* projectAtoms((repo) => held.get(repo.id) ?? [], repoIds);
      yield* database.query("update repos set gone_at = now() where id between 90001 and 90030");
      const expansions = (dim: ClosedDim, id: string): ReadonlyArray<string> => {
        const direct = closed[dim].find((value) => value.id === id)?.expands ?? [];
        return [id, ...direct.flatMap((next) => expansions(dim, next))];
      };
      const listed = yield* database.query(
        "select atom, array_agg(repo_id::float8 order by repo_id) as repos from matching_atoms where atom not like '%subject:%' group by atom",
      );
      const byAtom = new Map(
        listed.map((row) => [(row as { atom: string }).atom, (row as { repos: Array<number> }).repos]),
      );
      let checked = 0;
      let withRepos = 0;
      const mismatches: Array<string> = [];
      for (const dim of Dim.literals.filter((dim): dim is ClosedDim => dim !== "subject")) {
        for (const form of formsOf(dim)) {
          for (const id of tried[dim]) {
            const atomKey = formatAtom({ role: form.role, value: { dim, id } as Db.StoredAtom["value"] });
            const values = form.widen ? expansions(dim, id) : [id];
            const [row] = yield* database.query(
              `select coalesce(array_agg(id::float8 order by id), '{}') as repos from repos
               where gone_at is null and (${form.columns.map((column) => `${column} && $1::knowledge_${dim}[]`).join(" or ")})`,
              [values],
            );
            const byPredicate = (row as { repos: Array<number> }).repos;
            checked++;
            if (byPredicate.length > 0) withRepos++;
            if (JSON.stringify(byPredicate) !== JSON.stringify(byAtom.get(atomKey) ?? [])) mismatches.push(atomKey);
          }
        }
      }
      expect(mismatches).toEqual([]);
      expect(withRepos).toBeGreaterThan(checked * 0.9);
    }),
  );
};

it.layer(TestDatabase.layerMemory({ embeddingModel: model }), { timeout: 120_000 })(
  "PGlite membership agreement",
  membershipCases,
);
it.layer(TestDatabase.layerNodePostgres({ embeddingModel: model }), { timeout: 120_000 })(
  "node-postgres membership agreement",
  membershipCases,
);
it.layer(TestDatabase.layerMemory({ embeddingModel: model }), { timeout: 120_000 })(
  "PGlite closed agreement",
  closedCases,
);
it.layer(TestDatabase.layerNodePostgres({ embeddingModel: model }), { timeout: 120_000 })(
  "node-postgres closed agreement",
  closedCases,
);
it.layer(TestDatabase.layerMemory({ embeddingModel: model }), { timeout: 120_000 })("PGlite named cases", namedCases);
it.layer(TestDatabase.layerNodePostgres({ embeddingModel: model }), { timeout: 120_000 })(
  "node-postgres named cases",
  namedCases,
);
