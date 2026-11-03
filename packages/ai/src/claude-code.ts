import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { AiOutputInvalid, AiRequestFailed, AiTimeout } from "./errors.ts";
import * as SchemaBridge from "./schema-bridge.ts";
import * as TextGeneration from "./text-generation.ts";

export interface ClaudeCodeConfig {
  readonly model: string;
  readonly binary?: string;
  readonly timeout?: Duration.Duration;
}

const defaultTimeout = Duration.minutes(3);

const ResultEnvelope = Schema.Struct({
  type: Schema.Literal("result"),
  is_error: Schema.Boolean,
  structured_output: Schema.optional(Schema.Unknown),
});
const decodeEnvelope = Schema.decodeUnknownEffect(Schema.fromJsonString(ResultEnvelope));

const args = (model: string, request: TextGeneration.GenerateRequest<unknown>): ReadonlyArray<string> => [
  "-p",
  "--output-format",
  "json",
  "--json-schema",
  JSON.stringify(SchemaBridge.jsonSchema(request.schema)),
  "--model",
  model,
  "--system-prompt",
  request.system,
  "--tools",
  "",
  "--disable-slash-commands",
  "--no-session-persistence",
  "--strict-mcp-config",
  "--setting-sources",
  "",
  "--settings",
  '{"disableAllHooks":true}',
  "--permission-mode",
  "dontAsk",
];

const make = Effect.fn("ClaudeCode.make")(function* (config: ClaudeCodeConfig) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const model = config.model;
  const timeout = config.timeout ?? defaultTimeout;
  const failed = (detail: string) => new AiRequestFailed({ operation: "generate", model, detail });
  const invalid = (detail: string) => new AiOutputInvalid({ operation: "generate", model, detail });

  const run = Effect.fn("ClaudeCode.run")(
    function* (request: TextGeneration.GenerateRequest<unknown>) {
      const handle = yield* spawner.spawn(
        ChildProcess.make(config.binary ?? "claude", args(model, request), {
          stdin: Stream.encodeText(Stream.make(request.prompt)),
        }),
      );
      const [stdout, exitCode] = yield* Effect.all(
        [Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode, Stream.runDrain(handle.stderr)],
        { concurrency: "unbounded" },
      );
      return { stdout, exitCode };
    },
    Effect.scoped,
    Effect.catchTags({ PlatformError: () => Effect.fail(failed("could not run the claude binary")) }),
  );

  const generate = Effect.fn("TextGeneration.generate")(
    function* <A>(request: TextGeneration.GenerateRequest<A>) {
      const { stdout, exitCode } = yield* run(request);
      if (exitCode !== 0) return yield* failed(`claude exited with code ${exitCode}`);
      const envelope = yield* decodeEnvelope(stdout).pipe(
        Effect.catchTags({
          SchemaError: () => Effect.fail(invalid(`claude printed ${stdout.length} bytes that are not a JSON result`)),
        }),
      );
      if (envelope.is_error) return yield* failed("claude reported an error result");
      if (envelope.structured_output === undefined) return yield* invalid("claude returned no structured output");
      const output = yield* SchemaBridge.validate(request.schema, envelope.structured_output);
      if (Option.isNone(output)) return yield* invalid("structured output does not match the schema");
      return output.value;
    },
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () =>
        Effect.fail(new AiTimeout({ operation: "generate", model, timeoutMillis: Duration.toMillis(timeout) })),
    }),
  );

  return TextGeneration.TextGeneration.of({ model, generate });
});

export const layer = (config: ClaudeCodeConfig) => Layer.effect(TextGeneration.TextGeneration, make(config));
