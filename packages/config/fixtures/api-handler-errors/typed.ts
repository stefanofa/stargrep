builder.effect(function* ({ input }): ApiResult<string> {
  return yield* input;
});
