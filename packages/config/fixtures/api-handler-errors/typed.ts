builder.effect(function* ({ input }): ApiResult<"search", string> {
  return yield* input;
});

const router = {
  syncStatus: builder.effect(function* ({ input }): ApiResult<"syncStatus", string> {
    return yield* input;
  }),
};
