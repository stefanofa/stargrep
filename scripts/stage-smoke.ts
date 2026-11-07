import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schema from "effect/Schema";
import { NotSettled, untilRouted, waitUntilReady } from "./fresh-stage.ts";
import { publicSmoke } from "./public-smoke.ts";
import { readStageOutput } from "./stage-output.ts";

const [stage, ...alchemyArgs] = process.argv.slice(2);
if (stage === "--public") {
  const origin = alchemyArgs[0];
  if (!origin) throw new Error("usage: bun scripts/stage-smoke.ts --public <origin>");
  const checks = await Effect.runPromise(publicSmoke(origin).pipe(Effect.provide(FetchHttpClient.layer)));
  for (const result of checks) console.log(JSON.stringify(result));
  process.exit(checks.every(({ ok }) => ok) ? 0 : 1);
}
if (!stage) throw new Error("usage: bun scripts/stage-smoke.ts <stage> [alchemy state read flags]");
const { url: workerUrl, debugUrl, debugToken, webUrl } = await readStageOutput(stage, alchemyArgs);

const Budget = Schema.Struct({ minute: Schema.Int, used: Schema.Int, cap: Schema.Int });
const Count = Schema.Struct({ count: Schema.Int });
const Sent = Schema.Struct({ sent: Schema.Array(Schema.String) });
const Consumed = Schema.Struct({ consumed: Schema.Boolean });
const Refused = Schema.Struct({ budget: Budget });
const Transaction = Schema.Struct({ pid: Schema.Int, sum: Schema.Int });

type Check = { readonly check: string; readonly ok: boolean; readonly detail: unknown };
const check = (name: string, ok: boolean, detail: unknown): Check => ({ check: name, ok, detail });

const resends = { cloudflare404: 0, dropped: 0 };

const send = Effect.fn("StageSmoke.send")(function* (request: HttpClientRequest.HttpClientRequest) {
  const attempt = Effect.gen(function* () {
    const response = yield* HttpClient.execute(request);
    return {
      status: response.status,
      contentType: response.headers["content-type"] ?? "",
      body: yield* response.text,
    };
  });
  return yield* untilRouted(`${request.method} ${request.url}`, attempt, resends);
});

const call = (method: "GET" | "POST", path: string, authorization: string | null = `Bearer ${debugToken}`) => {
  const request = HttpClientRequest.make(method)(new URL(path, debugUrl));
  return send(authorization === null ? request : HttpClientRequest.setHeader(request, "authorization", authorization));
};

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

// A fresh stage's Durable Objects can fail for a few seconds after the deploy, so the checks start once the budget and
// a counter both answer.
const answers = (path: string) =>
  call("GET", path).pipe(
    Effect.catch((error) => Effect.succeed({ status: 0, body: String(error) })),
    Effect.flatMap(({ status, body }) =>
      status === 200
        ? Effect.void
        : Effect.fail(new NotSettled({ answer: `GET ${path} ${status} ${body.slice(0, 120)}` })),
    ),
  );

const ready = waitUntilReady(debugUrl, Effect.all([answers("/budget"), answers("/counter/ready")]).pipe(Effect.asVoid));

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
  // One call without a token and one with a wrong token per route reach every branch of the gate. A single call that
  // got through fails the 401, counter, or budget check below, so a bigger burst proves nothing more. The flood proves
  // the cap, and the traffic checks prove the queue.
  const results = yield* Effect.all(
    routes.flatMap(([method, path]) => [call(method, path, null), call(method, path, "Bearer wrong-token")]),
    { concurrency: "unbounded" },
  );
  const budgetAfter = yield* read(Budget, "GET", "/budget");
  const counterAfter = yield* read(Count, "GET", `/counter/${probe}`);
  const statuses = Object.groupBy(results, ({ status }) => status);
  return [
    check(
      "every route answers 401 without a token and with a wrong one",
      results.every(({ status }) => status === 401),
      {
        statuses: Object.fromEntries(Object.entries(statuses).map(([status, calls]) => [status, calls?.length])),
        unexpected: results
          .filter(({ status }) => status !== 401)
          .slice(0, 3)
          .map(({ status, body }) => `${status} ${/<title>([^<]*)<\/title>/i.exec(body)?.[1] ?? body.slice(0, 120)}`),
      },
    ),
    check("unauthenticated calls change no counter", counterAfter.count === counterBefore.count, {
      before: counterBefore.count,
      after: counterAfter.count,
    }),
    check(
      "unauthenticated calls spend no budget",
      budgetAfter.minute !== budgetBefore.minute || budgetAfter.used === budgetBefore.used,
      { before: budgetBefore, after: budgetAfter },
    ),
  ];
});

const traffic = Effect.gen(function* () {
  const queued = yield* read(Sent, "POST", "/queue?count=10");
  yield* waitUntilReady(
    `${debugUrl}/queue`,
    Effect.forEach(queued.sent, (id) => read(Consumed, "GET", `/queue/${id}`), { concurrency: 10 }).pipe(
      Effect.orDie,
      Effect.flatMap((receipts) =>
        receipts.every((receipt) => receipt.consumed)
          ? Effect.void
          : Effect.fail(
              new NotSettled({ answer: `${receipts.filter((receipt) => receipt.consumed).length}/10 consumed` }),
            ),
      ),
    ),
  );

  const counter = `parallel-${yield* Clock.currentTimeMillis}`;
  yield* Effect.forEach(Array.from({ length: 5 }), () => read(Count, "POST", `/counter/${counter}`), {
    concurrency: 5,
  });
  const counted = yield* read(Count, "GET", `/counter/${counter}`);

  const transactions = yield* Effect.forEach(Array.from({ length: 30 }), () => call("POST", "/transaction"), {
    concurrency: 30,
  });
  const committed = yield* Effect.forEach(
    transactions.filter(({ status }) => status === 200),
    ({ body }) => decode(Transaction, body),
  );
  return [
    check("queue consumes 10 jobs", queued.sent.length === 10, { consumed: queued.sent }),
    check("counter ends at 5 after 5 parallel increments", counted.count === 5, counted),
    check("30 parallel transactions commit", committed.length === 30, {
      failures: transactions.filter(({ status }) => status !== 200).map(({ status, body }) => `${status} ${body}`),
      preparedStatementErrors: transactions.filter(({ body }) => /prepared statement/i.test(body)).length,
      distinctBackendPids: new Set(committed.map(({ pid }) => pid)).size,
    }),
  ];
});

const Spec = Schema.Struct({ paths: Schema.Record(Schema.String, Schema.Unknown) });
const SyncState = Schema.Struct({ state: Schema.String });
const WireError = Schema.Struct({
  code: Schema.String,
  data: Schema.optional(Schema.Struct({ traceId: Schema.optional(Schema.String) })),
});

const web = Effect.gen(function* () {
  const get = (path: string) => send(HttpClientRequest.get(new URL(path, webUrl)));
  const post = (path: string, body: object) =>
    send(
      HttpClientRequest.post(new URL(path, webUrl)).pipe(
        HttpClientRequest.setHeader("accept", "application/json, text/event-stream"),
        HttpClientRequest.bodyJsonUnsafe(body),
      ),
    );
  const spec = yield* get("/openapi.json");
  const paths = Object.keys((yield* decode(Spec, spec.body)).paths).sort();
  const emptyQuery = yield* post("/api/search", { scope: { kind: "stars", login: "octocat" }, q: "" });
  const emptyQueryBody = yield* decode(WireError, emptyQuery.body);
  const stranger = `smoke-${yield* Clock.currentTimeMillis}`;
  const status = yield* get(`/api/sync/${stranger}`);
  const statusBody = yield* decode(SyncState, status.body);
  const unsynced = yield* post("/api/search", { scope: { kind: "stars", login: stranger }, q: "terminal dashboards" });
  const unsyncedBody = yield* decode(WireError, unsynced.body);
  const tools = yield* post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  const toolList = tools.body;
  return [
    check(
      "the OpenAPI document lists every route",
      paths.join(" ") === "/config /repos/{id} /search /stars/{login} /sync/{login}",
      {
        status: spec.status,
        paths,
      },
    ),
    check(
      "an empty search query answers 400 with a trace ID",
      emptyQuery.status === 400 && emptyQueryBody.data?.traceId !== undefined,
      { status: emptyQuery.status, code: emptyQueryBody.code },
    ),
    check("a login never seen reads as unknown through Postgres", statusBody.state === "unknown", {
      status: status.status,
      state: statusBody.state,
    }),
    check(
      "a search of that login answers ACCOUNT_NOT_SYNCED with every service built",
      unsynced.status === 404 && unsyncedBody.code === "ACCOUNT_NOT_SYNCED",
      { status: unsynced.status, code: unsyncedBody.code },
    ),
    check(
      "MCP lists the six tools",
      ["search", "triggerSync", "syncStatus", "getRepo", "stars", "config"].every((name) =>
        toolList.includes(`"name":"${name}"`),
      ),
      { status: tools.status },
    ),
  ];
});

// The main Worker starts its runtime on every request, so a startup failure answers 500 here before any queue message.
const worker = Effect.gen(function* () {
  const health = yield* send(HttpClientRequest.get(new URL("/health", workerUrl)));
  return [check("the main Worker starts and reads its database", health.status === 200, { status: health.status })];
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
  return [
    check("authenticated flood stops at the per-minute cap", refused !== undefined && accepted === budget.cap, {
      accepted,
      refused,
      budget,
    }),
  ];
});

const checks = (
  await Effect.runPromise(
    ready.pipe(
      Effect.andThen(Effect.all([publicSmoke(webUrl), web, worker, unauthenticated, traffic, flood])),
      Effect.provide(FetchHttpClient.layer),
    ),
  )
).flat();
for (const result of checks) console.log(JSON.stringify(result));
console.log(JSON.stringify({ resentAfterCloudflare404: resends.cloudflare404, resentAfterDrop: resends.dropped }));
if (checks.some(({ ok }) => !ok)) process.exit(1);
