builder.effect(function* ({ input }): ApiResult<"search", string> {
  return yield* input;
});
