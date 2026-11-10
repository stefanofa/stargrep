import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { SubjectId } from "./ids.ts";
import {
  type ClosedDim,
  Dim,
  defaultRoles,
  dimPrefix,
  KindId,
  LanguageId,
  LicenseId,
  PlatformId,
  RoleId,
  roleIds,
  roles,
  StatusId,
} from "./registry.ts";

export const FacetRef = Schema.Union([
  Schema.Struct({ dim: Schema.Literal("kind"), id: KindId }),
  Schema.Struct({ dim: Schema.Literal("language"), id: LanguageId }),
  Schema.Struct({ dim: Schema.Literal("license"), id: LicenseId }),
  Schema.Struct({ dim: Schema.Literal("platform"), id: PlatformId }),
  Schema.Struct({ dim: Schema.Literal("status"), id: StatusId }),
  Schema.Struct({ dim: Schema.Literal("subject"), id: SubjectId }),
]);
export type FacetRef = typeof FacetRef.Type;

// "any" is every default role of the value's dimension, the form people and pages use most.
export const AtomRole = Schema.Union([RoleId, Schema.Literal("any")]);
export type AtomRole = typeof AtomRole.Type;

// A dimension with one default role has no role-qualified form: "is:kind:app" is "kind:app".
const soleDefaultRole = (dim: Dim): RoleId | null => {
  const [only, ...rest] = defaultRoles(dim);
  return only !== undefined && rest.length === 0 ? only : null;
};

// One form per meaning: a dimension's only default role is written "any".
export const Atom = Schema.Struct({ role: AtomRole, value: FacetRef }).check(
  Schema.makeFilter(
    (atom) =>
      atom.role === "any" ||
      (roles[atom.role].accepts.includes(atom.value.dim) && soleDefaultRole(atom.value.dim) !== atom.role),
    { expected: `a role that accepts the value's dimension, or "any" for its only default role` },
  ),
);
export type Atom = typeof Atom.Type;

export type ClosedAtom = Atom & { readonly value: { readonly dim: ClosedDim } };

export const isClosed = (atom: Atom): atom is ClosedAtom => atom.value.dim !== "subject";

const prefixDims = new Map(Dim.literals.map((dim) => [dimPrefix[dim], dim]));
const wireRoles = new Map(roleIds.map((role) => [roles[role].wire, role]));
const subjectDigits = /^[1-9][0-9]*$/;
const atomKeyPattern = /^(?!any:)(?:[a-z-]+:)?(?:kind|lang|license|platform|status|subject):[A-Za-z0-9.+-]+$/;

// Unknown names pass through unchanged, so the Atom schema reports them as the precise issue.
const keyToAtom = (key: string): typeof Atom.Encoded => {
  const parts = key.split(":");
  const wire = parts.length === 3 ? (parts[0] ?? null) : null;
  const [prefix = "", id = ""] = parts.slice(-2);
  const dim = prefixDims.get(prefix) ?? prefix;
  const role = wire === null ? "any" : (wireRoles.get(wire) ?? wire);
  const value = { dim, id: dim !== "subject" ? id : subjectDigits.test(id) ? Number(id) : id };
  return {
    role: role === soleDefaultRole(dim as Dim) ? "any" : role,
    value,
  } as typeof Atom.Encoded;
};

// [role ":"] prefix ":" id, always in the shortest form, so equal atoms get equal keys.
export const formatAtom = (atom: typeof Atom.Encoded): string => {
  const prefix = `${dimPrefix[atom.value.dim]}:${atom.value.id}`;
  return atom.role === "any" || atom.role === soleDefaultRole(atom.value.dim)
    ? prefix
    : `${roles[atom.role].wire}:${prefix}`;
};

export const AtomKey = Schema.String.check(Schema.isPattern(atomKeyPattern)).pipe(
  Schema.decodeTo(Atom, SchemaTransformation.transform({ decode: keyToAtom, encode: formatAtom })),
);
export type AtomKey = typeof AtomKey.Encoded;

// OR within a group. A negated group excludes repos matching any of its atoms.
export const Group = Schema.Struct({ negate: Schema.Boolean, any: Schema.NonEmptyArray(Atom) });
export type Group = typeof Group.Type;

// AND across groups. The empty selection is everything.
export const Selection = Schema.Struct({ all: Schema.Array(Group) });
export type Selection = typeof Selection.Type;

export const everything: Selection = { all: [] };

const SelectionFromKeys = Schema.Struct({
  all: Schema.Array(Schema.Struct({ negate: Schema.Boolean, any: Schema.NonEmptyArray(AtomKey) })),
});

// "lang:rust subject:4127 subject:812|subject:9031 -kind:list". Spaces separate groups, "|" separates a group's atoms,
// and "-" negates a group. The empty string is everything.
const keyToSelection = (key: string): typeof SelectionFromKeys.Encoded => ({
  all:
    key === ""
      ? []
      : key.split(" ").map((group) => {
          const negate = group.startsWith("-");
          return { negate, any: (negate ? group.slice(1) : group).split("|") as [string, ...Array<string>] };
        }),
});

const selectionToKey = (selection: typeof SelectionFromKeys.Encoded): string =>
  selection.all.map((group) => `${group.negate ? "-" : ""}${group.any.join("|")}`).join(" ");

export const SelectionKey = Schema.String.check(Schema.isMaxLength(2000)).pipe(
  Schema.decodeTo(
    SelectionFromKeys,
    SchemaTransformation.transform({ decode: keyToSelection, encode: selectionToKey }),
  ),
);

const byKey = <A>([a]: readonly [string, A], [b]: readonly [string, A]) => (a < b ? -1 : a > b ? 1 : 0);

// Sorts atoms within groups and groups within the selection, positive groups first, and drops repeated atoms and
// repeated groups. Subject IDs stay as given, so a merge or its undo never rewrites a stored selection.
export const normalize = (selection: Selection): Selection => {
  const groups = new Map<string, Group>();
  for (const group of selection.all) {
    const atoms = [...new Map(group.any.map((atom) => [formatAtom(atom), atom]))].sort(byKey);
    const key = `${group.negate ? "-" : " "}${atoms.map(([atomKey]) => atomKey).join("|")}`;
    groups.set(key, { negate: group.negate, any: atoms.map(([, atom]) => atom) as [Atom, ...Array<Atom>] });
  }
  return { all: [...groups].sort(byKey).map(([, group]) => group) };
};
