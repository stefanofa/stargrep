import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import Counter from "./counter.ts";
import { Database } from "./database.ts";
import { healthResponse } from "./health.ts";

const Jobs = Cloudflare.Queues.Queue("Jobs");
const Cache = Cloudflare.KV.Namespace("Cache");
const Blobs = Cloudflare.R2.Bucket("Blobs");

const Ping = Schema.Struct({ id: Schema.String });
const decodePing = Schema.decodeUnknownEffect(Ping);

const decodeDebugCount = Schema.decodeUnknownOption(
  Schema.NumberFromString.pipe(Schema.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 100 }))),
);

export default Cloudflare.Worker(
  "Worker",
  // Run next to the Neon project in infra/database.run.ts, so each query skips the trip from the caller's edge.
  { main: import.meta.url, placement: { region: "aws:eu-central-1" } },
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;
    const jobs = yield* Jobs;
    const sender = yield* Cloudflare.Queues.WriteQueue(jobs);
    yield* Cloudflare.KV.ReadWriteNamespace(Cache);
    yield* Cloudflare.R2.ReadWriteBucket(Blobs);
    const database = yield* Cloudflare.Hyperdrive.Connect(Database);
    const counters = yield* Counter;
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

    const sendPings = Effect.fn("Worker.sendPings")(function* (count: number) {
      const ids = yield* Effect.forEach(Array.from({ length: count }), () => random.uuidV4());
      yield* Effect.forEach(ids, (id) => sender.send({ id }), { discard: true });
      return ids;
    });

    const debug = Effect.fn("Worker.debug")(function* (method: string, url: URL) {
      if (method === "POST" && url.pathname === "/debug/queue") {
        const count = decodeDebugCount(url.searchParams.get("count") ?? "1");
        if (Option.isNone(count)) return HttpServerResponse.empty({ status: 400 });
        return yield* HttpServerResponse.json({ sent: yield* sendPings(count.value) });
      }
      const counter = /^\/debug\/counter\/([\w-]{1,64})$/.exec(url.pathname)?.[1];
      if (method === "POST" && counter) {
        return yield* HttpServerResponse.json({ count: yield* counters.getByName(counter).increment() });
      }
      return HttpServerResponse.empty({ status: 404 });
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        if (request.method === "GET" && url.pathname === "/health") {
          return yield* healthResponse(Redacted.value(yield* database.connectionString));
        }
        if (stage !== "prod" && url.pathname.startsWith("/debug/")) {
          return yield* debug(request.method, url);
        }
        return HttpServerResponse.empty({ status: 404 });
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
