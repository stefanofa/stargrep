import { database, sql } from "./stubs.ts";

export type RepoKind = "app" | "library";
export const scope = { kind: "stars" } as const;
export const fields = (row: { readonly kind: string | null }) => [row.kind, scope.kind];
export const decision = database.query("insert into decisions (owner_id, revision, kind) values (1, 1, 'undo')");
export const statements = database.query("update repos set gone_at = now() where id = 1; update decisions set kind = 'undo'");
export const dimension = sql`select 'kind'::text as dim from unnest(r.kinds) as v`;
