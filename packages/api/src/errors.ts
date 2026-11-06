import { ORPCError } from "@orpc/server";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";

const TraceData = Schema.Struct({
  traceId: Schema.String.annotate({ description: "Quote this ID when you report the error." }),
});

const wire = {
  UNAUTHORIZED: { status: 401, message: "Sign in with GitHub to see your stars." },
  LOGIN_NOT_FOUND: { status: 404, message: "GitHub has no user or org with this login." },
  ACCOUNT_NOT_SYNCED: { status: 404, message: "Stargrep has not synced this login's stars yet. Trigger a sync first." },
  REPO_NOT_FOUND: { status: 404, message: "Stargrep has no repo with this ID." },
  SCOPE_UNAVAILABLE: { status: 422, message: "This search scope is not available yet." },
  TOO_MANY_REQUESTS: { status: 429, message: "Too many requests from your network. Try again in a minute." },
  SYNC_BUSY: {
    status: 503,
    message: "Stargrep is importing as many accounts as GitHub allows right now. Try again later.",
  },
  SERVICE_UNAVAILABLE: { status: 503, message: "Stargrep could not reach a service it needs. Try again shortly." },
  INTERNAL_SERVER_ERROR: { status: 500, message: "Stargrep failed to answer." },
};

export type WireCode = keyof typeof wire;

export const errors = Record.map(wire, ({ message }) => ({ message, data: TraceData }));

export const errorStatus = Record.map(wire, ({ status }) => status);

export const wireError = (code: WireCode, traceId: string) =>
  new ORPCError(code, { message: wire[code].message, data: { traceId } });

export const withTraceId = <E extends ORPCError<string, unknown>>(error: E, traceId: string): E => {
  const data = Predicate.isObject(error.data) ? error.data : {};
  if (!("traceId" in data)) error.data = { ...data, traceId };
  return error;
};
