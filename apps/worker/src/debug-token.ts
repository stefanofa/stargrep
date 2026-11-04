import * as Alchemy from "alchemy";
import * as Redacted from "effect/Redacted";

export const DebugToken = Alchemy.makeRandom("DebugToken");

const encoder = new TextEncoder();
export const authorized = (header: string | undefined, token: Redacted.Redacted<string>) => {
  const given = encoder.encode(header ?? "");
  const expected = encoder.encode(`Bearer ${Redacted.value(token)}`);
  let difference = given.byteLength ^ expected.byteLength;
  for (const [index, byte] of expected.entries()) difference |= byte ^ (given[index] ?? 0);
  return difference === 0;
};
