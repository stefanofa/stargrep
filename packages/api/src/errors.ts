import { ORPCError } from "@orpc/server";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";

const TraceData = Schema.Struct({
  traceId: Schema.String.annotate({ description: "Quote this ID when you report the error." }),
});

const wire = {
  ACCOUNT_NOT_SYNCED: { status: 404, message: "Stargrep has not synced this login's stars yet. Trigger a sync first." },
  REPO_NOT_FOUND: { status: 404, message: "Stargrep has no repo with this ID." },
  SCOPE_UNAVAILABLE: { status: 422, message: "This search scope is not available yet." },
  TOO_MANY_REQUESTS: { status: 429, message: "Too many sync requests. Try again in a minute." },
  SERVICE_UNAVAILABLE: { status: 503, message: "Stargrep could not reach a service it needs. Try again shortly." },
  INTERNAL_SERVER_ERROR: { status: 500, message: "Stargrep failed to answer." },
};

export type WireCode = keyof typeof wire;

export const errors = Record.map(wire, ({ message }) => ({ message, data: TraceData }));

export const errorStatus = Record.map(wire, ({ status }) => status);

export const wireError = (code: WireCode, traceId: string) =>
  new ORPCError(code, { message: wire[code].message, data: { traceId } });
