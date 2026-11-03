import { afterAll, beforeAll, describe, onTestFinished, test } from "bun:test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as TestConsole from "effect/testing/TestConsole";

export type TestServices = TestClock.TestClock | TestConsole.TestConsole;

type Register<R> = <A, E>(name: string, body: () => Effect.Effect<A, E, R>) => void;

export type Tester<R> = Register<R> & {
  readonly only: Register<R>;
  readonly skip: Register<R>;
  readonly failing: Register<R>;
};

const TestEnv = Layer.mergeAll(TestConsole.layer, TestClock.layer());

const toError = (cause: Cause.Cause<unknown>): unknown => {
  // A thrown expect() is a defect. Rethrow it untouched: reading its stack
  // first, as prettyErrors does, makes Bun lose the code frame.
  const [reason, ...rest] = cause.reasons;
  if (rest.length === 0 && reason && Cause.isDieReason(reason) && reason.defect instanceof Error) return reason.defect;
  const errors = Cause.prettyErrors(cause);
  return errors.length === 1 ? errors[0] : new Error(Cause.pretty(cause));
};

const runOrThrow = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromiseExit(effect).then((exit) => {
    if (Exit.isFailure(exit)) throw toError(exit.cause);
    return exit.value;
  });

// Bun passes no AbortSignal to a test. On timeout it still runs onTestFinished
// and awaits its promise, so aborting there interrupts the fiber and holds the
// next test until the finalizers finish. Bun refuses onTestFinished inside a
// concurrent test, so it is registered before the fiber starts.
const run = <A, E>(effect: Effect.Effect<A, E>): Promise<void> => {
  const controller = new AbortController();
  let reported = false;
  onTestFinished(() => {
    controller.abort();
    return exit.then((result) => {
      if (reported || Exit.isSuccess(result)) return;
      // Bun already reported the timeout, so only a finalizer failure is left.
      const failures = result.cause.reasons.filter((reason) => !Cause.isInterruptReason(reason));
      if (failures.length > 0) throw toError(Cause.fromReasons(failures));
    });
  });
  const exit = Effect.runPromiseExit(effect, { signal: controller.signal });
  return exit.then((result) => {
    // After an abort Bun has already failed the test and stopped awaiting this.
    if (controller.signal.aborted) return;
    reported = true;
    if (Exit.isFailure(result)) throw toError(result.cause);
  });
};

const makeTester = <R>(provide: <A, E>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E>): Tester<R> => {
  // Bun throws when CI reads test.only, so read each modifier only when a test uses it.
  const register =
    (t: () => (name: string, fn: () => Promise<void>) => void): Register<R> =>
    (name, body) =>
      t()(name, () => run(provide(Effect.suspend(body))));
  return Object.assign(
    register(() => test),
    {
      only: register(() => test.only),
      skip: register(() => test.skip),
      failing: register(() => test.failing),
    },
  );
};

export const effect = makeTester<Scope.Scope | TestServices>((self) =>
  self.pipe(Effect.scoped, Effect.provide(TestEnv)),
);

export const live = makeTester<Scope.Scope>(Effect.scoped);

export const layer =
  <ROut, E>(self: Layer.Layer<ROut, E>) =>
  (name: string, f: (it: { readonly effect: Tester<ROut | Scope.Scope | TestServices> }) => void) =>
    describe(name, () => {
      const scope = Scope.makeUnsafe();
      const context = Layer.buildWithScope(Layer.provideMerge(self, TestEnv), scope).pipe(
        Effect.orDie,
        Effect.cached,
        Effect.runSync,
      );
      beforeAll(() => runOrThrow(context));
      afterAll(() => runOrThrow(Scope.close(scope, Exit.void)));
      f({
        effect: makeTester((self) =>
          Effect.flatMap(context, (services) => self.pipe(Effect.scoped, Effect.provide(services))),
        ),
      });
    });
