import * as Db from "@stargrep/db";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as RateLine from "../limits/rate-line.ts";

export const ModelCall = Schema.Literals(["plan", "embed"]);
export type ModelCall = typeof ModelCall.Type;

export class ModelCallRefused extends Schema.TaggedError<ModelCallRefused, { readonly brand: unique symbol }>()(
  "ModelCallRefused",
  {
    call: ModelCall,
    // The line that had no room, or meter-down when the lines could not be read.
    reason: Schema.Literals(["network", "all", "meter-down"]),
  },
) {
  override get message(): string {
    return `The model allowance refused a ${this.call} call: ${this.reason}`;
  }
}

// Answers whether a planner or query embedding call may go ahead, and counts it when it may. A cached plan or embedding
// never reaches a model, so callers ask only on a cache miss.
export class ModelAllowance extends Context.Service<
  ModelAllowance,
  {
    readonly take: (call: ModelCall) => Effect.Effect<void, ModelCallRefused>;
  }
>()("@stargrep/core/search/model-allowance/ModelAllowance") {}

export const callsRefused = Metric.counter("stargrep_model_calls_refused", {
  description:
    "Planner and query embedding calls the model allowance refused, by call and by the line that refused them.",
});

// Meters calls exactly across every Worker location, with one atomic reservation per line in Postgres. The network's
// line goes first, so a network past its own limit never spends from everyone's. A meter that cannot be read refuses,
// because a refused call still answers with the words as typed.
export const layerMetered = (caller: Db.CallerKey) =>
  Layer.effect(
    ModelAllowance,
    Effect.gen(function* () {
      const db = yield* Db.Db;
      const lines = [
        { reason: "network", line: RateLine.modelNetwork(caller) },
        { reason: "all", line: RateLine.modelAll },
      ] as const;
      const take = Effect.fn("ModelAllowance.take")(
        function* (call: ModelCall) {
          yield* Effect.annotateCurrentSpan("model.call", call);
          const at = yield* DateTime.now;
          for (const { reason, line } of lines) {
            const started = yield* RateLine.reserve(db.rateLines, line, at, 1).pipe(
              Effect.catch((error) =>
                Effect.logWarning("Model allowance could not be read, so the call is refused", {
                  error: error._tag,
                }).pipe(Effect.andThen(new ModelCallRefused({ call, reason: "meter-down" }))),
              ),
            );
            if (Option.isNone(started)) return yield* new ModelCallRefused({ call, reason });
          }
        },
        Effect.tapError((refused) =>
          Metric.update(Metric.withAttributes(callsRefused, { call: refused.call, reason: refused.reason }), 1),
        ),
      );
      return ModelAllowance.of({ take });
    }),
  );

// Lets every call through, for tools, evals, and tests that do not meter.
const allowAll: ModelAllowance["Service"] = { take: () => Effect.void };

export const layerUnmetered = Layer.succeed(ModelAllowance, allowAll);
