import { describe, expect } from "bun:test";
import { effect } from "@stargrep/testing";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ClaudeCode from "./claude-code.ts";
import type { AiError } from "./errors.ts";
import * as Summarize from "./prompts/summarize.ts";

interface Process {
  readonly stdout?: string;
  readonly exitCode?: number;
  readonly hang?: boolean;
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
        stderr: Stream.empty,
        all: output,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  const layer = ClaudeCode.layer({ model: "haiku" }).pipe(
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

const summary = { summary: "A Rust library for terminal user interfaces.", keywords: ["tui"], kind: "library" };

const result = (fields: Record<string, unknown>) =>
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "", ...fields });

describe("claude code text generation", () => {
  effect("decodes structured_output through the summary schema", () => {
    const { seen, layer } = fakeClaude({ stdout: result({ structured_output: summary }) });
    return Effect.gen(function* () {
      expect(yield* Summarize.summarize(repo)).toEqual(summary as Summarize.RepoSummary);
      expect(seen.args).toContain("--json-schema");
      expect(seen.args.slice(seen.args.indexOf("--model"), seen.args.indexOf("--model") + 2)).toEqual([
        "--model",
        "haiku",
      ]);
      expect(seen.args.join(" ")).not.toContain("PRIVATE README TEXT");
      expect(seen.stdin).toContain("PRIVATE README TEXT");
    }).pipe(Effect.provide(layer));
  });

  const failures: ReadonlyArray<[string, Process, AiError["_tag"]]> = [
    ["output that is not JSON", { stdout: "Sure, here is a summary" }, "AiOutputInvalid"],
    ["partial JSON", { stdout: result({ structured_output: summary }).slice(0, 40) }, "AiOutputInvalid"],
    ["a result without structured_output", { stdout: result({}) }, "AiOutputInvalid"],
    [
      "structured_output that misses the schema",
      { stdout: result({ structured_output: { ...summary, kind: "spaceship" } }) },
      "AiOutputInvalid",
    ],
    ["an error result", { stdout: result({ is_error: true, result: "auth failed" }) }, "AiRequestFailed"],
    ["a non-zero exit", { stdout: "", exitCode: 1 }, "AiRequestFailed"],
  ];

  for (const [name, process, tag] of failures) {
    effect(`maps ${name} to ${tag} without the prompt or output`, () => {
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

  effect("fails with AiTimeout and closes the process when claude hangs", () => {
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
