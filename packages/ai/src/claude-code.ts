import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { AiOutputInvalid, AiRequestFailed } from "./errors.ts";
import * as TextGeneration from "./text-generation.ts";

const ResultEnvelope = Schema.Struct({
  type: Schema.Literal("result"),
  is_error: Schema.Boolean,
  structured_output: Schema.optional(Schema.Unknown),
  usage: Schema.optional(
    Schema.Struct({ input_tokens: Schema.optional(Schema.Finite), output_tokens: Schema.optional(Schema.Finite) }),
  ),
});
const decodeEnvelope = Schema.decodeUnknownEffect(Schema.fromJsonString(ResultEnvelope));

const args = (model: string, request: TextGeneration.RunRequest): ReadonlyArray<string> => [
  "-p",
  "--output-format",
  "json",
  "--json-schema",
  JSON.stringify(request.jsonSchema),
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

const make = Effect.fn("ClaudeCode.make")(function* (model: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const failed = (detail: string) => new AiRequestFailed({ operation: "generate", model, detail });
  const invalid = (detail: string) => new AiOutputInvalid({ operation: "generate", model, detail });

  const exec = Effect.fn("ClaudeCode.exec")(
    function* (request: TextGeneration.RunRequest) {
      const handle = yield* spawner.spawn(
        ChildProcess.make("claude", args(model, request), { stdin: Stream.encodeText(Stream.make(request.prompt)) }),
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

  const run = Effect.fn("ClaudeCode.run")(function* (request: TextGeneration.RunRequest) {
    const { stdout, exitCode } = yield* exec(request);
    if (exitCode !== 0) return yield* failed(`claude exited with code ${exitCode}`);
    const envelope = yield* decodeEnvelope(stdout).pipe(
      Effect.catchTags({
        SchemaError: () => Effect.fail(invalid(`claude printed ${stdout.length} bytes that are not a JSON result`)),
      }),
    );
    if (envelope.is_error) return yield* failed("claude reported an error result");
    if (envelope.structured_output === undefined) return yield* invalid("claude returned no structured output");
    return {
      output: envelope.structured_output,
      usage: { inputTokens: envelope.usage?.input_tokens, outputTokens: envelope.usage?.output_tokens },
    };
  });

  return TextGeneration.make({ provider: "claude-code", model, timeout: Duration.minutes(3), run });
});

export const layer = (model: string) => Layer.effect(TextGeneration.TextGeneration, make(model));
