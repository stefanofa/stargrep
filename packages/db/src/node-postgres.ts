import { drizzle } from "drizzle-orm/node-postgres";
import * as Effect from "effect/Effect";
import pg from "pg";
import type * as Postgres from "./postgres.ts";

// The server can end a connection pg is not reading from: Hyperdrive and Neon close idle ones, and a
// forced drop terminates them. pg emits that as an `error` event, and an unhandled emit ends the
// process. The next query on that connection fails with its own error.
export const ignoreError = () => {};

// pg 8.23.1 reports a lost connection with these plain errors, which carry no code. In
// pg/lib/client.js, the con.once('end') handler in Client._connect raises "Connection terminated"
// and "Connection terminated unexpectedly", and Client.query raises "not queryable" once
// Client._handleErrorEvent has marked the client broken. Check this set again when upgrading pg.
// A server FATAL such as 57P01 arrives as a DatabaseError with its SQLSTATE, and a socket failure
// carries its errno code.
const connectionErrors = new Set([
  "Client has encountered a connection error and is not queryable",
  "Connection terminated",
  "Connection terminated unexpectedly",
]);

const isConnectionError = (error: unknown) => error instanceof Error && connectionErrors.has(error.message);

const makePool = (connectionString: string) => {
  const pool = new pg.Pool({ connectionString });
  pool.on("error", ignoreError);
  const open = new Set<pg.PoolClient>();
  pool.on("connect", (client) => {
    client.on("error", ignoreError);
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

// A pg pool that ignores errors on every pooled client, idle or checked out, and whose release waits
// until every connection has closed.
export const acquirePool = (connectionString: string) =>
  Effect.acquireRelease(
    Effect.sync(() => makePool(connectionString)),
    ({ end }) => Effect.promise(end),
  ).pipe(Effect.map(({ pool }) => pool));

export const driver = (pool: pg.Pool): Postgres.Driver => ({
  database: drizzle({ client: pool }),
  connect: async () => {
    const client = await pool.connect();
    return {
      database: drizzle({ client }),
      query: (statement) => client.query(statement),
      release: (broken) => client.release(broken),
    };
  },
  isDatabaseError: (error) => error instanceof pg.DatabaseError,
  isConnectionError,
  exclusive: (effect) => effect,
});
