import * as Alchemy from "alchemy";
const { Telemetry: T } = Alchemy;
export const tracer = T.layer(undefined as never);
