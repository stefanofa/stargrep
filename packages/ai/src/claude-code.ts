import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as PlatformError from "effect/PlatformError";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { AiOutputInvalid, AiRequestFailed } from "./errors.ts";
import * as TextGeneration from "./text-generation.ts";

const Usage = Schema.Struct({
  input_tokens: Schema.optional(Schema.Finite),
  output_tokens: Schema.optional(Schema.Finite),
  cache_creation_input_tokens: Schema.optional(Schema.NullOr(Schema.Finite)),
  cache_read_input_tokens: Schema.optional(Schema.NullOr(Schema.Finite)),
});

const ResultEnvelope = Schema.Struct({
  type: Schema.Literal("result"),
  is_error: Schema.Boolean,
  structured_output: Schema.optional(Schema.Unknown),
  usage: Schema.optional(Usage),
});
const decodeEnvelope = Schema.decodeUnknownEffect(Schema.fromJsonString(ResultEnvelope));

// The CLI reports the input it sent uncached apart from what it read from or wrote to the prompt cache, which holds
// nearly all of a prompt. The port counts all three as input, as the Gateway reports it, and keeps the cache shares.
const usageOf = (usage: typeof Usage.Type | undefined): TextGeneration.RunResult["usage"] => {
  const cacheWriteTokens = usage?.cache_creation_input_tokens ?? undefined;
  const cacheReadTokens = usage?.cache_read_input_tokens ?? undefined;
  const parts = [usage?.input_tokens, cacheWriteTokens, cacheReadTokens].flatMap((part) =>
    part === undefined ? [] : [part],
  );
  return {
    inputTokens: parts.length === 0 ? undefined : parts.reduce((total, part) => total + part, 0),
    outputTokens: usage?.output_tokens,
    cacheReadTokens,
    cacheWriteTokens,
  };
};

// The CLI turns thinking on or off in its settings and takes an effort of low to max, so minimal asks for low.
const thinking = (reasoning: TextGeneration.Reasoning) => {
  if (reasoning === "none") return { settings: { alwaysThinkingEnabled: false }, effort: [] };
  if (reasoning === "provider-default") return { settings: {}, effort: [] };
  return {
    settings: { alwaysThinkingEnabled: true },
    effort: ["--effort", reasoning === "minimal" ? "low" : reasoning],
  };
};

const args = (model: string, request: TextGeneration.RunRequest): ReadonlyArray<string> => {
  const { settings, effort } = thinking(request.reasoning);
  return [
    "-p",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(request.jsonSchema),
    "--model",
    model,
    ...effort,
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
    JSON.stringify({ disableAllHooks: true, ...settings }),
    "--permission-mode",
    "dontAsk",
  ];
};

export const maxStdoutBytes = 1024 * 1024;

const make = Effect.fn("ClaudeCode.make")(function* (alias: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // Receipts and token counts name the CLI with the model it was asked for, such as claude-code/sonnet, so an answer
  // the CLI wrote never reads as the Gateway's, and a Haiku run never reads as a Sonnet run.
  const model = `claude-code/${alias}`;
  const failed = (detail: string) => new AiRequestFailed({ operation: "generate", model, detail });
  const invalid = (detail: string) => new AiOutputInvalid({ operation: "generate", model, detail });
  const tooLarge = invalid(`claude printed more than ${maxStdoutBytes} bytes`);

  const readStdout = (stdout: Stream.Stream<Uint8Array, PlatformError.PlatformError>) => {
    const decoder = new TextDecoder();
    return Stream.runFoldEffect(
      stdout,
      () => ({ bytes: 0, text: "" }),
      (read, chunk) =>
        read.bytes + chunk.length > maxStdoutBytes
          ? Effect.fail(tooLarge)
          : Effect.succeed({
              bytes: read.bytes + chunk.length,
              text: read.text + decoder.decode(chunk, { stream: true }),
            }),
    );
  };

  const exec = Effect.fnUntraced(
    function* (request: TextGeneration.RunRequest) {
      const handle = yield* spawner.spawn(
        ChildProcess.make("claude", args(alias, request), { stdin: Stream.encodeText(Stream.make(request.prompt)) }),
      );
      const [stdout, exitCode] = yield* Effect.all(
        [readStdout(handle.stdout), handle.exitCode, Stream.runDrain(handle.stderr)],
        { concurrency: "unbounded" },
      );
      yield* Effect.annotateCurrentSpan({ exitCode, stdoutBytes: stdout.bytes });
      return { stdout: stdout.text, exitCode };
    },
    Effect.scoped,
    Effect.catchTags({ PlatformError: () => Effect.fail(failed("could not run the claude binary")) }),
  );

  const run = Effect.fnUntraced(function* (request: TextGeneration.RunRequest) {
    const { stdout, exitCode } = yield* exec(request);
    if (exitCode !== 0) return yield* failed(`claude exited with code ${exitCode}`);
    const envelope = yield* decodeEnvelope(stdout).pipe(
      Effect.catchTags({
        SchemaError: () =>
          Effect.fail(invalid(`claude printed ${stdout.length} characters that are not a JSON result`)),
      }),
    );
    if (envelope.is_error) return yield* failed("claude reported an error result");
    if (envelope.structured_output === undefined) return yield* invalid("claude returned no structured output");
    return { output: envelope.structured_output, usage: usageOf(envelope.usage) };
  });

  return TextGeneration.make({ provider: "claude-code", model, timeout: Duration.minutes(3), run });
});

export const layer = (model: string) => Layer.effect(TextGeneration.TextGeneration, make(model));
