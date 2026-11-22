// The follow controls also render on topic pages, which load no Effect, so the follows code reads the platform's clock
// and timers through these.

// @effect-diagnostics-next-line globalDate:off - topic pages load no Effect.
export const wallNow = () => Date.now();

// @effect-diagnostics-next-line globalDate:off - topic pages load no Effect.
export const isoAt = (millis: number) => new Date(millis).toISOString();

// Runs after the wait and answers how to cancel it.
export const after = (millis: number, run: () => void) => {
  // @effect-diagnostics-next-line globalTimers:off - topic pages load no Effect.
  const timer = setTimeout(run, millis);
  return () => clearTimeout(timer);
};
