import { afterAll, beforeAll, describe, onTestFinished, test } from "bun:test";
import * as Cause from "effect/Cause";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as TestConsole from "effect/testing/TestConsole";

export type TestServices = TestClock.TestClock | TestConsole.TestConsole;

const TestEnv = Layer.mergeAll(TestConsole.layer, TestClock.layer());

type Body<A, E, R> = () => Effect.Effect<A, E, R>;
type Register = (name: string, fn: () => Promise<void>, timeout?: number) => void;

const toError = (cause: Cause.Cause<unknown>): unknown => {
  // A thrown expect() is a defect. Rethrow it untouched: reading its stack
  // first, as prettyErrors does, makes Bun lose the code frame.
  const [reason, ...rest] = cause.reasons;
  if (rest.length === 0 && reason && Cause.isDieReason(reason) && reason.defect instanceof Error) return reason.defect;
  const errors = Cause.prettyErrors(cause);
  return errors.length === 1 ? errors[0] : new Error(Cause.pretty(cause));
};

// Bun passes no AbortSignal to a test. On timeout it still runs onTestFinished
// and awaits its promise, so aborting there interrupts the fiber and holds the
// next test until the finalizers finish. Bun refuses onTestFinished inside a
// concurrent test, so there a timed-out fiber keeps running.
const run = <A, E>(effect: Effect.Effect<A, E>): Promise<void> => {
  const controller = new AbortController();
  let exit: Promise<Exit.Exit<A, E>> | undefined;
  try {
    onTestFinished(() => {
      controller.abort();
      return exit?.then(() => undefined);
    });
  } catch {}
  exit = Effect.runPromiseExit(effect, { signal: controller.signal });
  return exit.then((result) => {
    // After an abort Bun has already failed the test and stopped awaiting this.
    if (Exit.isFailure(result) && !controller.signal.aborted) throw toError(result.cause);
  });
};

const makeTester = <R>(provide: <A, E>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E>) => {
  const register =
    (t: Register) =>
    <A, E>(name: string, body: Body<A, E, R>, timeout?: number) =>
      t(name, () => run(provide(Effect.suspend(body))), timeout);
  return Object.assign(register(test), {
    only: register(test.only),
    skip: register(test.skip),
    failing: register(test.failing),
  });
};

export const effect = makeTester<Scope.Scope | TestServices>((self) =>
  self.pipe(Effect.scoped, Effect.provide(TestEnv)),
);

export const live = makeTester<Scope.Scope>(Effect.scoped);

export const layer =
  <ROut, E>(self: Layer.Layer<ROut, E>) =>
  (
    name: string,
    f: (it: { readonly effect: ReturnType<typeof makeTester<ROut | Scope.Scope | TestServices>> }) => void,
  ) =>
    describe(name, () => {
      const scope = Scope.makeUnsafe();
      let context: Context.Context<ROut | TestServices> | undefined;
      beforeAll(async () => {
        const exit = await Effect.runPromiseExit(Layer.buildWithScope(Layer.provideMerge(self, TestEnv), scope));
        if (Exit.isFailure(exit)) throw toError(exit.cause);
        context = exit.value;
      });
      afterAll(() => Effect.runPromise(Scope.close(scope, Exit.void)));
      f({
        effect: makeTester<ROut | Scope.Scope | TestServices>((self) =>
          Effect.suspend(() => {
            if (context === undefined) return Effect.die(new Error(`layer for "${name}" was not built`));
            return self.pipe(Effect.scoped, Effect.provide(context));
          }),
        ),
      });
    });
