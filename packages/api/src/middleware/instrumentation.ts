import { middlewareGen } from "@orpc/effect";
import { ORPCError } from "@orpc/server";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { wireError, withTraceId } from "../errors.ts";

export type Transport = "rpc" | "rest" | "mcp";

export type ProcedureTime = Ref.Ref<Option.Option<Duration.Duration>>;

const callsMade = Metric.counter("stargrep_api_calls", {
  description: "API calls, by procedure, transport, and outcome.",
});

const failureName = (error: unknown) => (error instanceof Error ? error.name : typeof error);

const outcomeOf = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) return "ok";
  const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  return error instanceof ORPCError ? error.code : "interrupted";
};

export const instrumentation = middlewareGen<
  { readonly transport: Transport; readonly procedureTime: ProcedureTime },
  { readonly traceId: string }
>(function* ({ next, path, context }) {
  const procedure = path.join(".");
  const attributes = { procedure, transport: context.transport };
  const started = yield* Clock.currentTimeMillis;
  return yield* Effect.useSpan(`Api.${procedure}`, { kind: "server" }, (span) =>
    Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan({
        "rpc.method": procedure,
        "api.transport": context.transport,
        "stargrep.trace_id": span.traceId,
      });
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off - oRPC types every downstream failure as unknown.
      return yield* next({ context: { traceId: span.traceId } }).pipe(
        Effect.tapError((error) =>
          error instanceof ORPCError
            ? Effect.void
            : Effect.logError("API call failed outside the error map", {
                procedure,
                traceId: span.traceId,
                failure: failureName(error),
              }),
        ),
        Effect.mapError((error) =>
          error instanceof ORPCError
            ? withTraceId(error, span.traceId)
            : wireError("INTERNAL_SERVER_ERROR", span.traceId),
        ),
      );
    }).pipe(
      Effect.withParentSpan(span),
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          const elapsed = Duration.millis((yield* Clock.currentTimeMillis) - started);
          yield* Ref.set(context.procedureTime, Option.some(elapsed));
          yield* Metric.update(Metric.withAttributes(callsMade, { ...attributes, outcome: outcomeOf(exit) }), 1);
        }),
      ),
    ),
  );
});
