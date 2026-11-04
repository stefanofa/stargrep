import * as Effect from "effect/Effect";
import pg from "pg";

// The server can end a connection pg is not reading from: Hyperdrive and Neon close idle ones, and a
// forced drop terminates them. pg emits that as an `error` event, and an unhandled emit ends the
// process. The next query on that connection fails with its own error.
export const ignoreError = () => {};

const makePool = (connectionString: string) => {
  const pool = new pg.Pool({ connectionString });
  pool.on("error", ignoreError);
  const open = new Set<pg.PoolClient>();
  pool.on("connect", (client) => {
    open.add(client);
    client.once("end", () => open.delete(client));
  });
  const end = async () => {
    // pool.end() resolves once it has asked each client to close, before the server sees the goodbye.
    await pool.end();
    await Promise.all(Array.from(open, (client) => new Promise((resolve) => client.once("end", resolve))));
  };
  return { pool, end };
};

// A pg pool whose release waits until every connection has closed.
export const acquirePool = (connectionString: string) =>
  Effect.acquireRelease(
    Effect.sync(() => makePool(connectionString)),
    ({ end }) => Effect.promise(end),
  ).pipe(Effect.map(({ pool }) => pool));
