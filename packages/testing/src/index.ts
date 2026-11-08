import { afterAll, beforeAll, describe, onTestFinished, test } from "bun:test";
import * as Cause from "effect/Cause";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
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

// Bun gives onTestFinished the test's own timeout unless it has one, and on a
// hook timeout it reports that instead of the test's and moves on. Finalizers
// get their own budget, so a slow one holds the next test and still fails loudly
// if it hangs.
const finalizerTimeout = 30_000;

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
  }, finalizerTimeout);
  const exit = Effect.runPromiseExit(effect, { signal: controller.signal });
  return exit.then((result) => {
    // After an abort Bun has already failed the test and stopped awaiting this.
    if (controller.signal.aborted) return;
    reported = true;
    if (Exit.isFailure(result)) throw toError(result.cause);
  });
};

const makeTester = <R>(
  provide: <A, E>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E>,
  timeout?: number,
): Tester<R> => {
  // Bun throws when CI reads test.only, so read each modifier only when a test uses it.
  const register =
    (t: () => (name: string, fn: () => Promise<void>, timeout?: number) => void): Register<R> =>
    (name, body) =>
      t()(name, () => run(provide(Effect.suspend(body))), timeout);
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

// timeout bounds building and closing the layer. testTimeout bounds each test in the block, for tests that run many
// statements against a shared database and outgrow Bun's 5 s default under a parallel run.
export const layer =
  <ROut, E>(self: Layer.Layer<ROut, E>, options: { readonly timeout?: number; readonly testTimeout?: number } = {}) =>
  (name: string, f: (it: { readonly effect: Tester<ROut | Scope.Scope | TestServices> }) => void) =>
    describe(name, () => {
      const scope = Scope.makeUnsafe();
      let build: Fiber.Fiber<Context.Context<ROut | TestServices>> | undefined;
      const context = Effect.suspend(() => {
        build ??= Effect.runFork(Layer.buildWithScope(Layer.provideMerge(self, TestEnv), scope).pipe(Effect.orDie));
        return Fiber.join(build);
      });
      // When beforeAll times out, Bun stops awaiting it and runs afterAll while
      // the build may still run. Interrupt the build first, so it never queries
      // a resource the closed scope released, and keep its interrupt out of the
      // abandoned beforeAll promise.
      let closing = false;
      beforeAll(
        () =>
          runOrThrow(context).then(
            () => undefined,
            (error) => {
              if (!closing) throw error;
            },
          ),
        options.timeout,
      );
      afterAll(() => {
        closing = true;
        return runOrThrow(Effect.andThen(build ? Fiber.interrupt(build) : Effect.void, Scope.close(scope, Exit.void)));
      }, options.timeout);
      f({
        effect: makeTester(
          (self) => Effect.flatMap(context, (services) => self.pipe(Effect.scoped, Effect.provide(services))),
          options.testTimeout,
        ),
      });
    });
