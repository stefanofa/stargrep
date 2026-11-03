import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schema from "effect/Schema";

const [debugUrl] = process.argv.slice(2);
const token = process.env.DEBUG_TOKEN;
if (!debugUrl || !token) throw new Error("usage: DEBUG_TOKEN=<token> bun scripts/stage-smoke.ts <debug worker url>");

const Budget = Schema.Struct({ allowed: Schema.Boolean, minute: Schema.Int, used: Schema.Int, cap: Schema.Int });
const Count = Schema.Struct({ count: Schema.Int });
const Sent = Schema.Struct({ sent: Schema.Array(Schema.String) });
const Refused = Schema.Struct({ budget: Budget });
const Transaction = Schema.Struct({ pid: Schema.Int, sum: Schema.Int });

const call = Effect.fn("StageSmoke.call")(function* (
  method: "GET" | "POST",
  path: string,
  authorization: string | null = `Bearer ${token}`,
) {
  const request = HttpClientRequest.make(method)(new URL(path, debugUrl));
  const response = yield* HttpClient.execute(
    authorization === null ? request : HttpClientRequest.setHeader(request, "authorization", authorization),
  );
  return { status: response.status, body: yield* response.text };
});

const decode = <S extends Schema.Top>(schema: S, body: string) =>
  Schema.decodeEffect(Schema.fromJsonString(schema))(body);

const read = Effect.fn("StageSmoke.read")(function* <S extends Schema.Top>(
  schema: S,
  method: "GET" | "POST",
  path: string,
) {
  const { status, body } = yield* call(method, path);
  if (status !== 200)
    return yield* Effect.die(new Error(`${method} ${path} returned ${status}: ${body.slice(0, 200)}`));
  return yield* decode(schema, body);
});

let failed = false;
const check = (name: string, ok: boolean, detail: unknown) => {
  console.log(JSON.stringify({ check: name, ok, detail }));
  if (!ok) failed = true;
};

const unauthenticated = Effect.gen(function* () {
  const probe = `smoke-${yield* Clock.currentTimeMillis}`;
  const counterBefore = yield* read(Count, "GET", `/counter/${probe}`);
  const budgetBefore = yield* read(Budget, "GET", "/budget");
  const routes = [
    ["POST", "/queue?count=100"],
    ["POST", `/counter/${probe}`],
    ["POST", "/transaction"],
    ["GET", "/budget"],
  ] as const;
  const results = yield* Effect.forEach(
    Array.from({ length: 1000 }, (_, i) => i),
    (i) => {
      const [method, path] = routes[i % routes.length] ?? routes[0];
      return call(method, path, i % 2 === 0 ? null : "Bearer wrong-token");
    },
    { concurrency: 50 },
  );
  const budgetAfter = yield* read(Budget, "GET", "/budget");
  const counterAfter = yield* read(Count, "GET", `/counter/${probe}`);
  const statuses = Object.groupBy(results, ({ status }) => status);
  check(
    "1000 unauthenticated calls answer 401",
    results.every(({ status }) => status === 401),
    {
      statuses: Object.fromEntries(Object.entries(statuses).map(([status, calls]) => [status, calls?.length])),
    },
  );
  check("unauthenticated calls change no counter", counterAfter.count === counterBefore.count, {
    before: counterBefore.count,
    after: counterAfter.count,
  });
  check(
    "unauthenticated calls spend no budget",
    budgetAfter.minute !== budgetBefore.minute || budgetAfter.used === budgetBefore.used,
    { before: budgetBefore, after: budgetAfter },
  );
});

const lanes = Effect.gen(function* () {
  const queued = yield* read(Sent, "POST", "/queue?count=10");
  check("lane 3 queues 10 jobs", queued.sent.length === 10, { sent: queued.sent });

  const counter = `lane5-${yield* Clock.currentTimeMillis}`;
  yield* Effect.forEach(Array.from({ length: 5 }), () => read(Count, "POST", `/counter/${counter}`), {
    concurrency: 5,
  });
  const counted = yield* read(Count, "GET", `/counter/${counter}`);
  check("lane 5 counter ends at 5 after 5 parallel increments", counted.count === 5, counted);

  const transactions = yield* Effect.forEach(Array.from({ length: 30 }), () => call("POST", "/transaction"), {
    concurrency: 30,
  });
  const committed = yield* Effect.forEach(
    transactions.filter(({ status }) => status === 200),
    ({ body }) => decode(Transaction, body),
  );
  check("lane 7 runs 30 parallel transactions", committed.length === 30, {
    failures: transactions.filter(({ status }) => status !== 200).map(({ status, body }) => `${status} ${body}`),
    preparedStatementErrors: transactions.filter(({ body }) => /prepared statement/i.test(body)).length,
    distinctBackendPids: new Set(committed.map(({ pid }) => pid)).size,
  });
});

const flood = Effect.gen(function* () {
  const now = yield* Clock.currentTimeMillis;
  yield* Effect.sleep(60_000 - (now % 60_000) + 1_000);
  let accepted = 0;
  let refused: typeof Budget.Type | undefined;
  for (let request = 0; request < 10 && refused === undefined; request++) {
    const { status, body } = yield* call("POST", "/queue?count=100");
    if (status === 200) accepted += (yield* decode(Sent, body)).sent.length;
    else if (status === 429) refused = (yield* decode(Refused, body)).budget;
    else return yield* Effect.die(new Error(`flood got ${status}: ${body.slice(0, 200)}`));
  }
  const budget = yield* read(Budget, "GET", "/budget");
  check("authenticated flood stops at the per-minute cap", refused !== undefined && accepted === budget.cap, {
    accepted,
    refused,
    budget,
  });
});

await Effect.runPromise(
  Effect.all([unauthenticated, lanes, flood], { discard: true }).pipe(Effect.provide(FetchHttpClient.layer)),
);
if (failed) process.exit(1);
