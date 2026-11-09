import type { Atom, AtomRole } from "@stargrep/knowledge/atom";
import { type ClosedDim, closed, type Dim, defaultRoles, type RoleId, roles } from "@stargrep/knowledge/registry";
import { type SQL, sql } from "drizzle-orm";
import { atomColumns } from "../schema.ts";

// Every predicate reads the repos row as r and the repo_facets row as fc. A closed column is on repos, a subject column
// is in repo_facets, and atomColumns maps each role and dimension to one of them.

const enumTypes: Readonly<Record<ClosedDim, string>> = {
  kind: "knowledge_kind",
  language: "knowledge_language",
  license: "knowledge_license",
  platform: "knowledge_platform",
  status: "knowledge_status",
};

const columnOf = (role: RoleId, dim: Dim): SQL => {
  const column = (atomColumns[role] as Partial<Record<Dim, string>>)[dim];
  if (column === undefined) throw new Error(`role '${role}' stores no '${dim}' atoms`);
  return sql.raw(column);
};

const isComparison = (role: RoleId) => roles[role].matches === "comparison";

const reached = (role: AtomRole, dim: Dim): ReadonlyArray<RoleId> => (role === "any" ? defaultRoles(dim) : [role]);

const anyOf = (tests: ReadonlyArray<SQL>): SQL => sql`(${sql.join([...tests], sql` or `)})`;

export const isClosed = (atom: Atom): atom is Atom & { readonly value: { readonly dim: ClosedDim } } =>
  atom.value.dim !== "subject";

// Every role the atom reaches, ORed. A membership role also matches the registry's expansions, so lang:javascript
// matches a TypeScript repo. A comparison matches its value alone.
export const closedTest = (atom: Atom & { readonly value: { readonly dim: ClosedDim } }): SQL => {
  const { dim, id } = atom.value;
  const expands = closed[dim].find((value) => value.id === id)?.expands ?? [];
  return anyOf(
    reached(atom.role, dim).map((role) => {
      const ids = isComparison(role) ? [id] : [id, ...expands];
      return sql`r.${columnOf(role, dim)} && ${sql.param(ids)}::${sql.raw(enumTypes[dim])}[]`;
    }),
  );
};

// Membership and built_with widen through Parent and Expand. A comparison widens through merges and splits only.
export const widens = (role: AtomRole): boolean => role === "any" || !isComparison(role);

// origins yields the origin IDs knowledge_origin_ids gave, or null for words that did not resolve, which tests null.
// A role no bare atom reaches, built_with or a comparison, never matches a stored subject that names the repo's own
// project, the self rule the views apply through knowledge_self_origins.
export const subjectTest = (role: AtomRole, origins: SQL): SQL => {
  if (role === "any") return sql`fc.members && ${origins}`;
  const column = columnOf(role, "subject");
  // The overlap test runs first, so most rows never start the subplan.
  return roles[role].matches !== "bare"
    ? sql`(fc.${column} && ${origins} and exists (
        select 1 from unnest(fc.${column}) as x (id) where x.id = any (${origins}::bigint[]) and not exists (
          select 1 from knowledge_self_origins so where so.repo_id = fc.repo_id and so.origin_id = x.id)))`
    : sql`fc.${column} && ${origins}`;
};

// A condition every match of subjectTest meets, which a GIN index on repo_facets serves: members for every role a bare
// atom reaches, and each other role's own column.
export const subjectIndexTest = (role: AtomRole, origins: SQL): SQL =>
  role === "any" || roles[role].matches === "bare"
    ? sql`fc.members && ${origins}`
    : sql`fc.${columnOf(role, "subject")} && ${origins}`;

export const any = anyOf;
