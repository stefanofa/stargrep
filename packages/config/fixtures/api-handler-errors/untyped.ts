builder.effect(function* ({ input }) {
  return yield* input;
});

builder.effect(function* ({ input }): Generator<unknown, string, never> {
  return yield* input;
});

builder.effect(({ input }) => input);
