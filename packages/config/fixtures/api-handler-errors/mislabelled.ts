const router = {
  syncStatus: builder.effect(function* ({ input }): ApiResult<"triggerSync", string> {
    return yield* input;
  }),
};
