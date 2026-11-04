import * as Tracer from "effect/Tracer";
import { withoutResults } from "./tracer.ts";

const readable = (_key: string, value: unknown) => {
  if (typeof value === "bigint") return String(value);
  if (value instanceof Map) return [...value];
  return value;
};

export const collectSpans = () => {
  const spans: Array<Tracer.NativeSpan> = [];
  const tracer = withoutResults(
    Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    }),
  );
  return {
    spans,
    tracer,
    named: (name: string) => spans.find((span) => span.name === name),
    text: () => JSON.stringify(spans, readable),
  };
};
