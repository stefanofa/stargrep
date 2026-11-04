import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { readStageOutput } from "./stage-output.ts";

const [stage, ...alchemyArgs] = process.argv.slice(2);
if (!stage) throw new Error("usage: bun scripts/stage-smoke.ts <stage> [alchemy state read flags]");
const { debugUrl, debugToken } = await readStageOutput(stage, alchemyArgs);

const Budget = Schema.Struct({ minute: Schema.Int, used: Schema.Int, cap: Schema.Int });
const Count = Schema.Struct({ count: Schema.Int });
const Sent = Schema.Struct({ sent: Schema.Array(Schema.String) });
const Refused = Schema.Struct({ budget: Budget });
const Transaction = Schema.Struct({ pid: Schema.Int, sum: Schema.Int });

type Check = { readonly check: string; readonly ok: boolean; readonly detail: unknown };
const check = (name: string, ok: boolean, detail: unknown): Check => ({ check: name, ok, detail });

// A fresh stage settles within about a minute, so its waits retry once a second for up to that long.
const freshStageWait = Duration.seconds(60);
const freshStageSchedule = Schedule.max([Schedule.spaced("1 second"), Schedule.during(freshStageWait)]);
const requestTimeout = Duration.seconds(30);

// Until a new workers.dev URL reaches every edge machine, some requests get Cloudflare's own HTML 404 page instead of
// the Worker, for over a minute under this load. The Worker never answers with HTML, so those requests are sent again.
class NotRoutedYet extends Schema.TaggedError<NotRoutedYet>()("NotRoutedYet", {}) {}
let resent = 0;

const call = Effect.fn("StageSmoke.call")(function* (
  method: "GET" | "POST",
  path: string,
  authorization: string | null = `Bearer ${debugToken}`,
) {
  const url = new URL(path, debugUrl);
  const request = HttpClientRequest.make(method)(url);
  const send = Effect.gen(function* () {
    const response = yield* HttpClient.execute(
      authorization === null ? request : HttpClientRequest.setHeader(request, "authorization", authorization),
    );
    if (response.status === 404 && response.headers["content-type"]?.startsWith("text/html")) {
      resent++;
      return yield* new NotRoutedYet();
    }
    return { status: response.status, body: yield* response.text };
  }).pipe(
    Effect.timeoutOrElse({
      duration: requestTimeout,
      orElse: () =>
        Effect.die(new Error(`${method} ${url} sent no answer within ${Duration.toSeconds(requestTimeout)} s`)),
    }),
  );
  return yield* send.pipe(
    Effect.retry({ while: (error) => error._tag === "NotRoutedYet", schedule: freshStageSchedule }),
    Effect.catchTag("NotRoutedYet", () =>
      Effect.die(
        new Error(
          `${method} ${url} got Cloudflare's 404 page for ${Duration.toSeconds(freshStageWait)} s, not the Worker`,
        ),
      ),
    ),
  );
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

class NotReady extends Schema.TaggedError<NotReady>()("NotReady", { answer: Schema.String }) {}

// A fresh stage's Durable Objects can fail for a few seconds after the deploy, so the checks start once the budget and
// a counter both answer.
const answers = (path: string) =>
  call("GET", path).pipe(
    Effect.flatMap(({ status, body }) =>
      status === 200
        ? Effect.void
        : Effect.fail(new NotReady({ answer: `GET ${path} ${status} ${body.slice(0, 120)}` })),
    ),
  );

const ready = Effect.all([answers("/budget"), answers("/counter/ready")]).pipe(
  Effect.retry({ schedule: freshStageSchedule }),
  Effect.catchTag("NotReady", (error) =>
    Effect.die(
      new Error(
        `${debugUrl} was not ready within ${Duration.toSeconds(freshStageWait)} s, last answer: ${error.answer}`,
      ),
    ),
  ),
);

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
  return [
    check(
      "1000 unauthenticated calls answer 401",
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
    check("queue accepts 10 jobs", queued.sent.length === 10, { sent: queued.sent }),
    check("counter ends at 5 after 5 parallel increments", counted.count === 5, counted),
    check("30 parallel transactions commit", committed.length === 30, {
      failures: transactions.filter(({ status }) => status !== 200).map(({ status, body }) => `${status} ${body}`),
      preparedStatementErrors: transactions.filter(({ body }) => /prepared statement/i.test(body)).length,
      distinctBackendPids: new Set(committed.map(({ pid }) => pid)).size,
    }),
  ];
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
    ready.pipe(Effect.andThen(Effect.all([unauthenticated, traffic, flood])), Effect.provide(FetchHttpClient.layer)),
  )
).flat();
for (const result of checks) console.log(JSON.stringify(result));
console.log(JSON.stringify({ resentAfterCloudflare404: resent }));
if (checks.some(({ ok }) => !ok)) process.exit(1);
