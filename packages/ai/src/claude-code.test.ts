import { describe, expect } from "bun:test";
import { decodeFacets } from "@stargrep/knowledge/claims";
import { collectSpans } from "@stargrep/telemetry/collector";
import * as it from "@stargrep/testing";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ClaudeCode from "./claude-code.ts";
import type { AiError } from "./errors.ts";
import recordedAnswers from "./prompts/summarize.recorded.json";
import * as Summarize from "./prompts/summarize.ts";

interface Process {
  readonly stdout?: string;
  readonly exitCode?: number;
  readonly hang?: boolean;
  readonly stderr?: string;
}

interface Seen {
  args: ReadonlyArray<string>;
  stdin: string;
  closed: boolean;
}

const fakeClaude = (process: Process) => {
  const seen: Seen = { args: [], stdin: "", closed: false };
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand") return yield* Effect.die("expected one command");
      seen.args = command.args.map(String);
      const stdin = command.options.stdin;
      if (Stream.isStream(stdin)) seen.stdin = yield* Stream.mkString(Stream.decodeText(stdin)).pipe(Effect.orDie);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          seen.closed = true;
        }),
      );
      const output = process.hang ? Stream.never : Stream.encodeText(Stream.make(process.stdout ?? ""));
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: process.hang ? Effect.never : Effect.succeed(ChildProcessSpawner.ExitCode(process.exitCode ?? 0)),
        isRunning: Effect.succeed(false),
        unref: Effect.succeed(Effect.void),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: output,
        stderr: Stream.encodeText(Stream.make(process.stderr ?? "")),
        all: output,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  const layer = ClaudeCode.layer("haiku").pipe(
    Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
  );
  return { seen, layer };
};

const repo: Summarize.RepoFacts = {
  fullName: "ratatui/ratatui",
  description: "A Rust crate for cooking up terminal user interfaces",
  topics: ["rust"],
  language: "Rust",
  readme: "PRIVATE README TEXT about terminal dashboards",
};

const summary = {
  summary: "A Rust library for terminal user interfaces.",
  keywords: ["tui"],
  facets: [{ role: "is", term: "library" }],
};

const result = (fields: Record<string, unknown>) =>
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "", ...fields });

describe("claude code text generation", () => {
  it.effect("decodes structured_output through the summary schema", () => {
    const { seen, layer } = fakeClaude({ stdout: result({ structured_output: summary }) });
    return Effect.gen(function* () {
      expect(yield* Summarize.summarize(repo)).toEqual({
        summary: summary.summary,
        keywords: summary.keywords,
        facets: decodeFacets(summary.facets, Summarize.promptOf(repo).input),
      });
      expect(seen.args).toContain("--json-schema");
      expect(seen.args.slice(seen.args.indexOf("--model"), seen.args.indexOf("--model") + 2)).toEqual([
        "--model",
        "haiku",
      ]);
      expect(seen.args.join(" ")).not.toContain("PRIVATE README TEXT");
      expect(seen.stdin).toContain("PRIVATE README TEXT");
    }).pipe(Effect.provide(layer));
  });

  // Answers the production model wrote for pilot 1, as the CLI printed them. No test here runs the binary.
  it.effect("decodes recorded answers with every fact", () =>
    Effect.forEach(recordedAnswers, ({ facts, text }) => {
      const answer = JSON.parse(text);
      const { layer } = fakeClaude({ stdout: result({ structured_output: answer }) });
      return Summarize.summarize(facts).pipe(
        Effect.tap((summary) =>
          Effect.sync(() =>
            expect(summary).toEqual({
              summary: answer.summary,
              keywords: answer.keywords,
              facets: decodeFacets(answer.facets, Summarize.promptOf(facts).input),
            }),
          ),
        ),
        Effect.provide(layer),
      );
    }),
  );

  const failures: ReadonlyArray<[string, Process, AiError["_tag"]]> = [
    ["output that is not JSON", { stdout: "Sure, here is a summary" }, "AiOutputInvalid"],
    ["partial JSON", { stdout: result({ structured_output: summary }).slice(0, 40) }, "AiOutputInvalid"],
    ["a result without structured_output", { stdout: result({}) }, "AiOutputInvalid"],
    [
      "structured_output that misses the schema",
      { stdout: result({ structured_output: { ...summary, keywords: "spaceship" } }) },
      "AiOutputInvalid",
    ],
    ["an error result", { stdout: result({ is_error: true, result: "auth failed" }) }, "AiRequestFailed"],
    ["a non-zero exit", { stdout: "", exitCode: 1 }, "AiRequestFailed"],
  ];

  for (const [name, process, tag] of failures) {
    it.effect(`maps ${name} to ${tag} without the prompt or output`, () => {
      const { layer } = fakeClaude(process);
      return Effect.gen(function* () {
        const error = yield* Effect.flip(Summarize.summarize(repo));
        expect(error._tag).toBe(tag);
        const serialized = `${JSON.stringify(error)} ${error.message}`;
        expect(serialized).not.toContain("PRIVATE README TEXT");
        expect(serialized).not.toContain("Sure, here is");
        expect(serialized).not.toContain("auth failed");
      }).pipe(Effect.provide(layer));
    });
  }

  it.effect("fails with AiTimeout and closes the process when claude hangs", () => {
    const { seen, layer } = fakeClaude({ hang: true });
    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Effect.flip(Summarize.summarize(repo)));
      yield* TestClock.adjust("179 seconds");
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("1 second");
      const error = yield* Fiber.join(fiber);
      expect(error._tag).toBe("AiTimeout");
      expect(error.message).toBe("Model 'haiku' did not answer 'generate' within 180000 ms");
      expect(seen.closed).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});

const outputCanary = "PRIVATE_OUTPUT_CANARY";
const promptCanary = "PRIVATE_PROMPT_CANARY";
const huge = "x".repeat(8 * 1024 * 1024);

const observe = <A, E>(effect: Effect.Effect<A, E>) => {
  const { spans, tracer } = collectSpans();
  const logs: Array<unknown> = [];
  const logger = Logger.make((options) => {
    logs.push({ message: options.message, cause: options.cause });
  });
  return effect.pipe(
    Effect.exit,
    Effect.withTracer(tracer),
    Effect.provide(Logger.layer([logger])),
    Effect.map((exit) => ({ exit, spans, logs })),
  );
};

const serialize = (value: unknown) =>
  JSON.stringify(value, (_, inner) =>
    typeof inner === "bigint" ? String(inner) : inner instanceof Map ? [...inner] : inner,
  );

describe("claude code telemetry and output size", () => {
  const privateRepo = { ...repo, readme: promptCanary };
  const cases: ReadonlyArray<[string, Process, "Success" | AiError["_tag"]]> = [
    [
      "metadata fields next to a valid result",
      { stdout: result({ structured_output: summary, result: outputCanary }) },
      "Success",
    ],
    [
      "an invalid result",
      { stdout: result({ structured_output: { ...summary, keywords: outputCanary }, result: outputCanary }) },
      "AiOutputInvalid",
    ],
    ["8 MiB of output that is not JSON", { stdout: outputCanary + huge }, "AiOutputInvalid"],
    [
      "an 8 MiB valid envelope",
      { stdout: result({ structured_output: summary, result: outputCanary + huge }) },
      "AiOutputInvalid",
    ],
    [
      "an 8 MiB structured summary",
      { stdout: result({ structured_output: { ...summary, summary: outputCanary + huge } }) },
      "AiOutputInvalid",
    ],
    ["stderr noise with empty stdout", { stdout: "", stderr: outputCanary }, "AiOutputInvalid"],
    [
      "stderr noise next to a valid result",
      { stdout: result({ structured_output: summary }), stderr: outputCanary },
      "Success",
    ],
  ];

  for (const [name, process, expected] of cases) {
    it.effect(`keeps ${name} out of errors, logs, and every span`, () => {
      const { seen, layer } = fakeClaude(process);
      return Effect.gen(function* () {
        const { exit, spans, logs } = yield* observe(Summarize.summarize(privateRepo).pipe(Effect.provide(layer)));
        expect(
          exit._tag === "Success"
            ? "Success"
            : exit.cause.reasons.map((reason) => (reason._tag === "Fail" ? reason.error._tag : reason._tag)).join(),
        ).toBe(expected);
        const recorded = serialize({
          exit,
          logs,
          spans,
        });
        expect(recorded).not.toContain(outputCanary);
        expect(recorded).not.toContain(promptCanary);
        expect(recorded.length).toBeLessThan(10_000);
        expect(seen.closed).toBe(true);
        const generate = spans.find((span) => span.name === "TextGeneration.generate");
        expect(generate?.attributes.get("provider")).toBe("claude-code");
      });
    });
  }
});
