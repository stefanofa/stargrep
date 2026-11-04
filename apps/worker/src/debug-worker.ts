import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Database } from "./database.ts";
import { withClient } from "./postgres.ts";
import { EnrichRepos, queueNames, SyncStars } from "./queues.ts";

const UNITS_PER_MINUTE = 300;

export const DebugToken = Alchemy.makeRandom("DebugToken");

const DebugJobs = Cloudflare.Queues.Queue("DebugJobs");
const DebugCache = Cloudflare.KV.Namespace("DebugCache");
const DebugBlobs = Cloudflare.R2.Bucket("DebugBlobs");

export class Counter extends Cloudflare.DurableObject<Counter>()(
  "Counter",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const read = Effect.fn("Counter.read")(function* () {
      return (yield* state.storage.get<number>("count")) ?? 0;
    });
    return Effect.succeed({
      read,
      increment: Effect.fn("Counter.increment")(function* () {
        const next = (yield* read()) + 1;
        yield* state.storage.put("count", next);
        return next;
      }),
    });
  }),
) {}

export class Budget extends Cloudflare.DurableObject<Budget>()(
  "Budget",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const read = Effect.fn("Budget.read")(function* () {
      const minute = Math.floor(DateTime.toEpochMillis(yield* DateTime.now) / 60_000);
      const stored = yield* state.storage.get<{ minute: number; used: number }>("budget");
      return { minute, used: stored?.minute === minute ? stored.used : 0, cap: UNITS_PER_MINUTE };
    });
    return Effect.succeed({
      read,
      spend: Effect.fn("Budget.spend")(function* (units: number) {
        const budget = yield* read();
        if (budget.used + units > budget.cap) return { allowed: false, budget };
        const used = budget.used + units;
        yield* state.storage.put("budget", { minute: budget.minute, used });
        return { allowed: true, budget: { ...budget, used } };
      }),
    });
  }),
) {}

const decodePing = Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }));
const decodeCount = Schema.decodeUnknownOption(
  Schema.NumberFromString.pipe(Schema.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 100 }))),
);
const decodeSeconds = Schema.decodeUnknownOption(
  Schema.NumberFromString.pipe(Schema.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 60 }))),
);
const decodeTransactionRow = Schema.decodeUnknownEffect(Schema.Struct({ pid: Schema.Int, sum: Schema.Int }));

const encoder = new TextEncoder();
const authorized = (header: string | undefined, token: Redacted.Redacted<string>) => {
  const given = encoder.encode(header ?? "");
  const expected = encoder.encode(`Bearer ${Redacted.value(token)}`);
  let difference = given.byteLength ^ expected.byteLength;
  for (const [index, byte] of expected.entries()) difference |= byte ^ (given[index] ?? 0);
  return difference === 0;
};

export default Cloudflare.Worker(
  "DebugWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const token = yield* yield* DebugToken;
    const jobs = yield* DebugJobs;
    const sender = yield* Cloudflare.Queues.WriteQueue(jobs);
    const pipelineQueues = new Map<string, Cloudflare.Queues.WriteQueueClient>([
      [queueNames.syncStars, yield* Cloudflare.Queues.WriteQueue(yield* SyncStars)],
      [queueNames.enrichRepo, yield* Cloudflare.Queues.WriteQueue(yield* EnrichRepos)],
    ]);
    yield* Cloudflare.KV.ReadWriteNamespace(DebugCache);
    yield* Cloudflare.R2.ReadWriteBucket(DebugBlobs);
    const database = yield* Cloudflare.Hyperdrive.Connect(Database);
    const counters = yield* Counter;
    const budgets = yield* Budget;
    const random = yield* SecureRandom.SecureRandom;

    yield* Cloudflare.Queues.consumeQueueMessages(jobs, { batchSize: 10, maxWaitTime: "1 second" }, (stream) =>
      Stream.runForEach(stream, (message) =>
        decodePing(message.body).pipe(
          Effect.flatMap(({ id }) => Effect.log("consumed job").pipe(Effect.annotateLogs({ id }))),
          Effect.catchTags({ SchemaError: (error) => Effect.logWarning("dropped malformed job", error.message) }),
        ),
      ),
    );

    yield* Cloudflare.Workers.cron("0 * * * *", () => Effect.log("hourly cron ran"));

    const sendPings = Effect.fn("DebugWorker.sendPings")(function* (count: number) {
      const ids = yield* Effect.forEach(Array.from({ length: count }), () => random.uuidV4());
      yield* sender.sendBatch(ids.map((id) => ({ body: { id } })));
      return ids;
    });

    const runTransaction = Effect.fn("DebugWorker.runTransaction")(function* () {
      return yield* withClient(Redacted.value(yield* database.connectionString), "transaction", (client) =>
        Effect.tryPromise(async () => {
          await client.query("begin");
          const { rows } = await client.query("select pg_backend_pid() as pid, $1::int + $2::int as sum", [20, 22]);
          await client.query("commit");
          return rows[0];
        }).pipe(Effect.flatMap(decodeTransactionRow)),
      );
    });

    // Runs pg_sleep through Hyperdrive, so a check can watch pg_stat_activity for what happens after the Worker gives up.
    const runSleep = Effect.fn("DebugWorker.runSleep")(function* (seconds: number) {
      return yield* withClient(Redacted.value(yield* database.connectionString), "sleep", (client) =>
        Effect.tryPromise(() => client.query("select pg_sleep($1)", [seconds])),
      );
    });

    const withinBudget = Effect.fn("DebugWorker.withinBudget")(function* <A, E, R>(
      units: number,
      work: Effect.Effect<A, E, R>,
    ) {
      const spent = yield* budgets.getByName("stage").spend(units);
      if (!spent.allowed) {
        return yield* HttpServerResponse.json({ error: "debug budget spent", budget: spent.budget }, { status: 429 });
      }
      return yield* work;
    });

    const route = Effect.fn("DebugWorker.route")(function* (method: string, url: URL) {
      if (method === "GET" && url.pathname === "/budget") {
        return yield* HttpServerResponse.json(yield* budgets.getByName("stage").read());
      }
      if (method === "POST" && url.pathname === "/queue") {
        const count = decodeCount(url.searchParams.get("count") ?? "1");
        if (Option.isNone(count)) return HttpServerResponse.empty({ status: 400 });
        return yield* withinBudget(
          count.value,
          sendPings(count.value).pipe(Effect.flatMap((sent) => HttpServerResponse.json({ sent }))),
        );
      }
      if (method === "POST" && url.pathname === "/transaction") {
        return yield* withinBudget(
          1,
          runTransaction().pipe(
            Effect.flatMap((row) => HttpServerResponse.json(row)),
            Effect.catchTags({
              PostgresFailed: (error) =>
                Effect.logError(error.message, error.cause).pipe(
                  Effect.andThen(HttpServerResponse.json({ error: error.message }, { status: 503 })),
                ),
            }),
          ),
        );
      }
      if (method === "POST" && url.pathname === "/sleep") {
        const seconds = decodeSeconds(url.searchParams.get("seconds") ?? "");
        if (Option.isNone(seconds)) return HttpServerResponse.empty({ status: 400 });
        return yield* withinBudget(
          1,
          runSleep(seconds.value).pipe(
            Effect.andThen(HttpServerResponse.json({ slept: seconds.value })),
            Effect.catchTags({
              PostgresFailed: (error) => HttpServerResponse.json({ error: error.message }, { status: 503 }),
            }),
          ),
        );
      }
      const pipelineQueue = pipelineQueues.get(url.pathname.replace(/^\/queue\//, ""));
      if (method === "POST" && pipelineQueue !== undefined) {
        const body = yield* (yield* HttpServerRequest).json;
        return yield* withinBudget(
          1,
          pipelineQueue.send(body).pipe(Effect.as(HttpServerResponse.empty({ status: 202 }))),
        );
      }
      const name = /^\/counter\/([\w-]{1,64})$/.exec(url.pathname)?.[1];
      if (name && method === "GET") {
        return yield* withinBudget(
          1,
          counters
            .getByName(name)
            .read()
            .pipe(Effect.flatMap((count) => HttpServerResponse.json({ count }))),
        );
      }
      if (name && method === "POST") {
        return yield* withinBudget(
          1,
          counters
            .getByName(name)
            .increment()
            .pipe(Effect.flatMap((count) => HttpServerResponse.json({ count }))),
        );
      }
      return HttpServerResponse.empty({ status: 404 });
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (!authorized(request.headers.authorization, yield* token)) return HttpServerResponse.empty({ status: 401 });
        return yield* route(request.method, new URL(request.url, "http://worker"));
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        SecureRandom.layerWebCrypto,
        Cloudflare.Queues.WriteQueueBinding,
        Cloudflare.Queues.EventSourceLive,
        Cloudflare.KV.ReadWriteNamespaceBinding,
        Cloudflare.R2.ReadWriteBucketBinding,
        Cloudflare.Hyperdrive.ConnectBinding,
        Cloudflare.Workers.CronEventSourceLive,
      ),
    ),
  ),
);
