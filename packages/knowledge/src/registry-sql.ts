import {
  type ClosedDim,
  closed,
  Dim,
  defaultRoles,
  dimPrefix,
  type RoleId,
  reservedKeys,
  roleIds,
  roles,
} from "./registry.ts";

const quote = (text: string) => `'${text.replaceAll("'", "''")}'`;

// Fills lines of at most 117 characters with the items, separated by ", ".
const wrap = (items: ReadonlyArray<string>, indent: string): string => {
  const lines: Array<string> = [];
  let line = indent;
  for (const item of items) {
    const piece = `${item}, `;
    if (line.length + piece.length > 118 && line !== indent) {
      lines.push(line.trimEnd());
      line = indent;
    }
    line += piece;
  }
  lines.push(line.replace(/, $/, ""));
  return lines.join("\n");
};

const enumType = (dim: ClosedDim) => {
  const values = closed[dim].map((entry) => quote(entry.id));
  const oneLine = `create type knowledge_${dim} as enum (${values.join(", ")});`;
  return oneLine.length <= 120 ? oneLine : `create type knowledge_${dim} as enum (\n${wrap(values, "  ")}\n);`;
};

const closedDims = Dim.literals.filter((dim): dim is ClosedDim => dim !== "subject");

const expansions = (dim: ClosedDim): ReadonlyArray<readonly [string, string, string]> => {
  const direct = new Map(closed[dim].map((entry) => [entry.id, entry.expands]));
  const reach = (from: string, seen: ReadonlySet<string>): ReadonlyArray<string> =>
    (direct.get(from) ?? []).flatMap((to) => (seen.has(to) ? [] : [to, ...reach(to, new Set([...seen, to]))]));
  return closed[dim].flatMap((entry) =>
    [...new Set(reach(entry.id, new Set([entry.id])))].map((to) => [dim, entry.id, to] as const),
  );
};

const expansionRows = () => {
  const rows = closedDims
    .flatMap(expansions)
    .map((row, index) => `(${row.map((cell) => (index === 0 ? `${quote(cell)}::text` : quote(cell))).join(", ")})`);
  return rows.length === 0 ? "select null::text, null::text, null::text where false" : `values ${rows.join(", ")}`;
};

const roleWire = (group: ReadonlyArray<RoleId>) =>
  group.every((role) => roles[role].wire === role)
    ? "role"
    : group.every((role) => roles[role].wire === role.replaceAll("_", "-"))
      ? "replace(role, '_', '-')"
      : `(case role ${group.map((role) => `when ${quote(role)} then ${quote(roles[role].wire)}`).join(" ")} end)`;

const roleKeyCases = Dim.literals.flatMap((dim) => {
  const group = defaultRoles(dim);
  const roleList = group.map(quote).join(", ");
  return group.length < 2
    ? []
    : [
        `    when dim = ${quote(dim)} and role in (${roleList}) then ${roleWire(group)} || ':${dimPrefix[dim]}:' || value`,
      ];
});

const keptRoleCases = roleIds
  .filter((role) => roles[role].matches !== "bare")
  .map((role) => `      when ${quote(role)} then ${quote(`${roles[role].wire}:`)}`);

const prefixCases = Dim.literals
  .filter((dim) => dimPrefix[dim] !== dim)
  .map((dim) => `when ${quote(dim)} then ${quote(dimPrefix[dim])}`);

// The SQL the registry generates: the closed enums, their expansions, the reserved label keys, and the atom key
// functions. A migration carries it, and registry.sql holds the current output.
export const renderRegistrySql = (): string =>
  `-- Generated from packages/knowledge/src/registry.ts by \`bun run --cwd packages/knowledge generate\`. Edit the
-- registry, not this file, and carry the result into a migration.

${closedDims.map(enumType).join("\n\n")}

-- A filter on from_id also matches to_id, written out as a transitive closure.
create function knowledge_closed_expansions()
returns table (dim text, from_id text, to_id text)
language sql immutable parallel safe
as $$ ${expansionRows()} $$;

-- The label key of every id, label, and alias of a kind, language, platform, or status. No subject label may use one,
-- so "about: rust" cannot mint a subject that competes with the language. License keys and the names that only imply
-- a value reserve nothing, so PostgreSQL, zlib, Chrome, and Ubuntu stay free to be subjects.
create function knowledge_reserved_key(key text)
returns boolean
language sql immutable parallel safe
as $$
  select key = any (array[
${wrap([...reservedKeys].sort().map(quote), "    ")}
  ])
$$;

-- The key a consumer counts an atom by. A role that bare atoms match gives the bare key, "lang:rust" or
-- "subject:4127". Any other role keeps its name, as "with:subject:812" or "alt:platform:node".
create function knowledge_atom_key(role text, dim text, value text)
returns text
language sql immutable parallel safe
as $$
  select (case role
${keptRoleCases.join("\n")}
      else '' end)
    || (case dim ${prefixCases.join(" ")} else dim end) || ':' || value
$$;

-- The role-qualified key of an atom in a role that bare atoms match, as "for:subject:812" or "written-in:lang:rust".
-- Null when no other role of the dimension is matched by bare atoms, as for kinds, because the bare key already means
-- the same repos.
create function knowledge_role_key(role text, dim text, value text)
returns text
language sql immutable parallel safe
as $$
  select case
${roleKeyCases.join("\n")}
  end
$$;

create function knowledge_no_nulls(anyarray)
returns boolean
language sql immutable parallel safe
as $$ select array_position($1, null) is null $$;
`;
