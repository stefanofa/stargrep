import * as Exit from "effect/Exit";
import * as Tracer from "effect/Tracer";

export const withoutResults = (tracer: Tracer.Tracer): Tracer.Tracer =>
  Tracer.make({
    ...tracer,
    span(options) {
      const span = tracer.span(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => end(endTime, Exit.isSuccess(exit) ? Exit.void : exit);
      return span;
    },
  });
