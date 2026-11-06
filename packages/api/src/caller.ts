import type { CallerKey } from "@stargrep/db";
import * as Context from "effect/Context";

// A keyed hash of the network a request came from. Per-caller limits count by it and never store an address.
export class Caller extends Context.Service<Caller, { readonly key: CallerKey }>()("@stargrep/api/caller") {}
