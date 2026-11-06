import type { CallerKey } from "@stargrep/db";
import * as Context from "effect/Context";

// The network a request came from, worked out once per request. Every per-network limit counts by it. The address keys
// only the Workers rate limit bindings and is never stored or logged. Rows in Postgres hold the keyed hash instead.
export class Caller extends Context.Service<Caller, { readonly key: CallerKey; readonly address: string }>()(
  "@stargrep/api/caller",
) {}
