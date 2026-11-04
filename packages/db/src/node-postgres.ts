import { drizzle } from "drizzle-orm/node-postgres";
import * as Effect from "effect/Effect";
import pg from "pg";
import type * as Postgres from "./postgres.ts";

// The server can end a connection pg is not reading from: Hyperdrive and Neon close idle ones, and a
// forced drop terminates them. pg emits that as an `error` event, and an unhandled emit ends the
// process. The next query on that connection fails with its own error.
export const ignoreError = () => {};

// A lost connection reaches pg's callers as a plain error with no code, from one of two sources. Check
// both sets again when upgrading pg or workerd. A server FATAL such as 57P01 arrives as a DatabaseError
// with its SQLSTATE, and a socket failure on Node or Bun carries its errno code.

// pg 8.23.1, pg/lib/client.js: the con.once('end') handler in Client._connect raises the two
// "Connection terminated" errors, and Client.query raises "not queryable" once
// Client._handleErrorEvent has marked the client broken.
const pgErrors = new Set([
  "Client has encountered a connection error and is not queryable",
  "Connection terminated",
  "Connection terminated unexpectedly",
]);

// On workerd, pg-cloudflare passes on the runtime's socket errors unchanged. workerd's
// src/workerd/api/sockets.c++ fails a refused or unreachable connect with the first two, and
// src/workerd/jsg/util.c++ reports a dropped socket with the third. The web Worker's
// "when the database is unreachable" test produces "connection attempt failed".
const workerdErrors = new Set([
  "connection attempt failed",
  "proxy request failed, cannot connect to the specified address",
  "Network connection lost.",
]);

const isConnectionError = (error: unknown) =>
  error instanceof Error && (pgErrors.has(error.message) || workerdErrors.has(error.message));

const makePool = (connectionString: string, max: number | undefined) => {
  const pool = new pg.Pool({ connectionString, ...(max === undefined ? {} : { max }) });
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
export const acquirePool = (connectionString: string, max?: number) =>
  Effect.acquireRelease(
    Effect.sync(() => makePool(connectionString, max)),
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
