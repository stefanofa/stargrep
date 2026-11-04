import * as Schema from "effect/Schema";

export const TraceData = Schema.Struct({
  traceId: Schema.String.annotate({ description: "Quote this ID when you report the error." }),
});

export const errors = {
  ACCOUNT_NOT_SYNCED: {
    message: "Stargrep has not synced this login's stars yet. Trigger a sync first.",
    data: TraceData,
  },
  REPO_NOT_FOUND: { message: "Stargrep has no repo with this ID.", data: TraceData },
  SCOPE_UNAVAILABLE: { message: "This search scope is not available yet.", data: TraceData },
  TOO_MANY_REQUESTS: { message: "Too many sync requests. Try again in a minute.", data: TraceData },
  SERVICE_UNAVAILABLE: { message: "Stargrep could not reach a service it needs. Try again shortly.", data: TraceData },
  INTERNAL_SERVER_ERROR: { message: "Stargrep failed to answer.", data: TraceData },
};

export type WireCode = keyof typeof errors;

export const errorStatus: Record<WireCode, number> = {
  ACCOUNT_NOT_SYNCED: 404,
  REPO_NOT_FOUND: 404,
  SCOPE_UNAVAILABLE: 422,
  TOO_MANY_REQUESTS: 429,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL_SERVER_ERROR: 500,
};
