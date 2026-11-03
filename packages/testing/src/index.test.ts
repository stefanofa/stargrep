import { beforeAll, describe, expect, test } from "bun:test";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { effect, layer, live } from "./index.ts";

describe("virtual time", () => {
  effect("Effect.sleep finishes after TestClock.adjust, not on the wall clock", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Effect.sleep("1 hour").pipe(Effect.as("woke")));
      yield* TestClock.adjust("1 hour");
      expect(yield* Fiber.join(fiber)).toBe("woke");
      expect(yield* Clock.currentTimeMillis).toBe(3_600_000);
    }),
  );

  effect("Effect.timeout fails with TimeoutError once the clock passes it", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Effect.flip(Effect.timeout(Effect.never, "5 seconds")));
      yield* TestClock.adjust("4 seconds");
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("1 second");
      expect((yield* Fiber.join(fiber))._tag).toBe("TimeoutError");
    }),
  );

  effect("each test starts on a fresh clock", () =>
    Effect.gen(function* () {
      expect(yield* Clock.currentTimeMillis).toBe(0);
    }),
  );
});

class Boom extends Schema.TaggedError<Boom, { readonly brand: unique symbol }>()("Boom", {}) {}

describe("finalizers", () => {
  const released: Array<string> = [];
  const resource = (label: string) =>
    Effect.acquireRelease(Effect.succeed(label), (name, exit) =>
      Effect.sync(() => {
        released.push(`${name}:${exit._tag}`);
      }),
    );

  effect("run on success", () => resource("success"));
  effect.failing("run on a typed failure", () => resource("typed").pipe(Effect.andThen(Effect.fail(new Boom()))));
  effect.failing("run on a defect", () => resource("defect").pipe(Effect.andThen(Effect.die("bad"))));
  effect.failing("run when expect throws", () =>
    resource("expect").pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(1).toBe(2);
        }),
      ),
    ),
  );
  live("run in live tests", () => resource("live"));

  test("all ran, in order, before the next test", () => {
    expect(released).toEqual(["success:Success", "typed:Failure", "defect:Failure", "expect:Failure", "live:Success"]);
  });
});

describe("timeout", () => {
  let stdout = "";
  let stderr = "";
  let code = 0;
  beforeAll(async () => {
    const run = Bun.spawn([process.execPath, "test", `${import.meta.dir}/timeout.fixture.ts`], {
      stdout: "pipe",
      stderr: "pipe",
    });
    [stdout, stderr, code] = await Promise.all([run.stdout.text(), run.stderr.text(), run.exited]);
  });

  test("fails the test past its timeout", () => {
    expect(code).toBe(1);
    expect(stderr).toContain("(fail) hangs past its timeout [");
    expect(stderr).toContain("timed out after 50ms");
  });

  test("interrupts the fiber and runs its finalizers", () => {
    expect(stdout).toContain("released:interrupted");
  });

  test("reports a finalizer that fails after the timeout", () => {
    expect(stderr).toContain("error: finalizer broke after timeout");
  });
});

class Counter extends Context.Service<Counter, { readonly build: number; readonly ticks: Ref.Ref<number> }>()(
  "@stargrep/testing/index.test/Counter",
) {}

describe("layer", () => {
  let builds = 0;
  let releases = 0;
  const CounterLayer = Layer.effect(
    Counter,
    Effect.gen(function* () {
      const build = yield* Effect.acquireRelease(
        Effect.sync(() => ++builds),
        () =>
          Effect.sync(() => {
            releases++;
          }),
      );
      const ticks = yield* Ref.make(0);
      yield* Effect.forkScoped(
        Effect.forever(Effect.sleep("1 minute").pipe(Effect.andThen(Ref.update(ticks, (n) => n + 1)))),
      );
      return { build, ticks };
    }),
  );

  layer(CounterLayer)("one build per block", (it) => {
    it.effect("the first test sees build 1", () =>
      Effect.gen(function* () {
        expect((yield* Counter).build).toBe(1);
      }),
    );
    it.effect("the second test sees the same build", () =>
      Effect.gen(function* () {
        expect((yield* Counter).build).toBe(1);
        expect(releases).toBe(0);
      }),
    );
    it.effect("the layer's fibers run on the block's TestClock", () =>
      Effect.gen(function* () {
        yield* TestClock.adjust("3 minutes");
        expect(yield* Ref.get((yield* Counter).ticks)).toBe(3);
      }),
    );
  });

  test("the layer was built once and released after the block", () => {
    expect(builds).toBe(1);
    expect(releases).toBe(1);
  });
});

class GitHub extends Context.Service<
  GitHub,
  {
    readonly getRepo: (name: string) => Effect.Effect<{ readonly stars: number }>;
    readonly listStargazers: (name: string) => Effect.Effect<ReadonlyArray<string>>;
  }
>()("@stargrep/testing/index.test/GitHub") {}

const GitHubMock = Layer.mock(GitHub, {
  getRepo: () => Effect.succeed({ stars: 42 }),
});

layer(GitHubMock)("Layer.mock", (it) => {
  it.effect("a stubbed method answers", () =>
    Effect.gen(function* () {
      const github = yield* GitHub;
      expect((yield* github.getRepo("effect")).stars).toBe(42);
    }),
  );
  it.effect("an unstubbed method dies", () =>
    Effect.gen(function* () {
      const github = yield* GitHub;
      const exit = yield* Effect.exit(github.listStargazers("effect"));
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
    }),
  );
});
