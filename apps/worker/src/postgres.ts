import * as Effect from "effect/Effect";
import { Client } from "pg";

export const connect = (connectionString: string) =>
  Effect.acquireRelease(
    Effect.tryPromise(async () => {
      const client = new Client({ connectionString });
      // On workerd, end() closes the socket under pg's read loop, which pg reports as a client error event.
      // A real failure still rejects the pending query, so the event needs a listener, not a handler.
      client.on("error", () => {});
      await client.connect();
      return client;
    }),
    (client) => Effect.promise(() => client.end()).pipe(Effect.ignore),
  );
