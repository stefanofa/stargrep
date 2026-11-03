# Effect conventions

This doc sets Stargrep's Effect conventions. Each rule comes from T3 Code (github.com/pingdotgg/t3code, commit `e27e12d`, 2026-11-03), which runs Effect 4.1.2. That is the same version Stargrep pins. Every excerpt is T3 Code's code and is credited by its path in that repo. Each section ends with a verdict for Stargrep. Adopt means take it as is. Adapt says what to change. Skip says why not.

Excerpts from T3 Code are used under its MIT License, Copyright (c) 2026 T3 Tools Inc.

## Where T3 Code's Effect code lives

T3 Code is a pnpm monorepo. Its own Effect code is in these places.

- `apps/server` holds 1,313 TypeScript files on Node. It is the main body of services, layers, RPC handlers, persistence on SQLite, and observability.
- `infra/relay` is a Cloudflare Worker built with Effect, Alchemy, `drizzle-orm/effect-postgres`, `@effect/sql-pg`, and Hyperdrive in front of Postgres. It is the closest match to Stargrep's runtime, so this doc leans on it.
- `infra/task-cache` is a second, smaller Effect Worker.
- `packages/contracts` holds the Effect Schema contracts that cross the wire.
- `packages/source-control-*` and `packages/provider-*` are port packages (`*-core`) with one adapter package per vendor and a `*-testing` package of fakes.
- `apps/web` and `packages/client-runtime` run Effect in the browser through `ManagedRuntime` and `@effect/atom-react`.

Vendored code that is not T3 Code's own:

- `.repos/effect-smol` is the upstream Effect 4 source, kept as a read-only reference. AGENTS.md says "Never edit or import from them."
- `.repos/alchemy-effect` is the upstream Alchemy source, kept the same way.
- `infra/task-cache/vendor/` is a vendored remote-cache package.

The written conventions live in four places. `docs/internals/effect-services.md` is the main one. `.macroscope/check-run-agents/effect-service-conventions.md` is an AI review check that enforces the same rules on every PR. `docs/internals/testing.md` and the "Taste" section of `AGENTS.md` cover the rest. Lint backs them up in three layers: the `@effect/language-service` TypeScript plugin in `tsconfig.base.json`, custom oxlint rules in `oxlint-plugin-t3code/rules/`, and knip for unused exports.

## 1. Services and layers

### Rule: one service is a `Context.Service` class with its interface inline

Effect 4 has no `Effect.Service`. T3 Code defines every service with `Context.Service`, writes the interface inline, and refers to it as `Foo["Service"]`. A standalone `FooShape` interface is banned.

```ts
// infra/relay/src/t3chat/T3ChatAccounts.ts
export class T3ChatAccounts extends Context.Service<
  T3ChatAccounts,
  {
    readonly available: boolean;
    readonly getLink: (input: {
      readonly userId: string;
    }) => Effect.Effect<RelayT3ChatLink | null, T3ChatNotConfigured | T3ChatRequestFailed>;
    // ...
  }
>()("t3code-relay/t3chat/T3ChatAccounts") {}
```

**For Stargrep.** Adopt, with the key form that the `deterministicKeys` rule enforces: `<package name>/<file path without src/ and the extension>/<Service>`. `StarSync` in `packages/core/src/stars/star-sync.ts` has the key `@stargrep/core/stars/star-sync/StarSync`. When the class name matches the file name, ignoring case, the rule drops the last segment, so `Ai` in `packages/ai/src/ai.ts` is `@stargrep/ai/ai`. Typecheck fails on any other key and prints the expected one.

### Rule: `make` reads dependencies from the environment, and `layer` wraps it

`make` is an `Effect.gen` that yields its dependencies, builds the methods, and returns `Foo.of({...})`. `layer = Layer.effect(Foo, make)`. Dependencies never arrive as parameters to `make`, so the type of `layer` shows what it needs. Config values, immutable values, and deliberate callbacks may be parameters.

```ts
// infra/relay/src/t3chat/T3ChatAccounts.ts
export const make = Effect.gen(function* () {
  const config = yield* RelayConfiguration.RelayConfiguration;
  const client = yield* HttpClient.HttpClient;
  // ...
  return T3ChatAccounts.of({ available: settings !== undefined, createLinkUrl, getLink, unlink });
});

export const layer = Layer.effect(T3ChatAccounts, make);
```

`make` stays private unless another module imports it, because knip fails CI on an unused export. Do not write `make = Effect.succeed(...)` to force `Layer.effect`. Use `Layer.succeed` or `Layer.sync` when nothing is effectful (`docs/internals/effect-services.md`).

**For Stargrep.** Adopt as is.

### Rule: a port with platform implementations names each one `layer<Platform>`

A module named for its implementation exports plain `make` and `layer`. A port module that also holds platform implementations names them, like `layerCloudflareQueues`. The platform layer is thin. It turns a Cloudflare binding into the port's dependency and reuses the platform-free `layer`.

```ts
// infra/relay/src/agentActivity/ApnsDeliveryQueue.ts
export const layer = Layer.effect(ApnsDeliveryQueue, make);

export const layerCloudflareQueues = (
  sender: Cloudflare.Queues.WriteQueueClient,
  alchemyRuntimeContext: Alchemy.BaseRuntimeContext,
) =>
  layer.pipe(
    Layer.provide(
      Layer.succeed(
        ApnsDeliveryQueueSender,
        ApnsDeliveryQueueSender.of({
          send: Effect.fn("ApnsDeliveryQueueSender.send")(
            function* (body) {
              return yield* sender.send(body);
            },
            Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
          ),
        }),
      ),
    ),
  );
```

**For Stargrep.** Adopt. This is the "platforms are layers" principle from `docs/architecture.md` in practice. `Queue` in `packages/core` exports `layerMemory`. `apps/worker` builds `layerCloudflareQueues`. Keep Cloudflare types out of `packages/core` by putting the platform layer in the app or in a `*-cloudflare` package.

### Rule: compose layers once per entry point, bottom up with `Layer.provideMerge`

Each entry point builds one root layer. The Worker stacks service layers with `Layer.empty.pipe(Layer.provideMerge(...))`, from the top consumer down to the database and config, and passes the same `layerRuntime` to its HTTP handler, its queue consumers, and its cron.

```ts
// infra/relay/src/worker.ts
const layerRuntime = Layer.empty.pipe(
  Layer.provideMerge(MobileRegistrations.layer),
  Layer.provideMerge(AgentActivityPublisher.layer),
  // ...
  Layer.provideMerge(RelayTokens.layer),
  Layer.provideMerge(
    RelayDb.RelayTransactions.layer.pipe(
      Layer.provideMerge(Layer.succeed(RelayDb.RelayDb, db)),
    ),
  ),
  Layer.provideMerge(Layer.effect(RelayConfiguration.RelayConfiguration, loadSettings)),
  Layer.provideMerge(layerWebcrypto),
);

yield* Cloudflare.Queues.consumeQueueMessages<unknown>(fcmDeliveryQueue, { batchSize: 10, maxRetries: 5, /* ... */ },
  (stream) =>
    stream.pipe(
      Stream.withSpan("relay.fcm_delivery_queue.process_batch"),
      Stream.runForEach(FcmDeliveryQueueConsumer.processMessage),
      Effect.provide(layerRuntime),
    ),
);
```

The Node server does the same in `apps/server/src/server.ts` and ends with `export const runServer = Layer.launch(layerMakeServer)`.

**For Stargrep.** Adapt. Keep one `layerRuntime` per Worker in `apps/web` and `apps/worker`. Note the per-request cost. `worker.ts` provides `layerRuntime` inside each handler, and its own comment says "`fetch` rebuilds its layers per request; the source map cache must outlive one." Anything that must outlive a request, such as a cache, gets built once in the Worker's init effect and passed in as a value, as the relay does with `mobileSourceMapLookups`.

### Rule: import Effect modules as namespaces from subpaths

```ts
// docs/internals/effect-services.md
import * as Effect from "effect/Effect"   // never: import { Effect } from "effect"
import * as Foo from "./Foo.ts"          // then: yield* Foo.Foo, Foo.layer
```

Never `import { layer as fooLayer }`. A barrel exposes a whole service as `export * as TokenStore from "./tokenStore.ts"`. The language service enforces the subpath form with `"namespaceImportPackages": ["@effect/platform-node", "effect"]`.

**For Stargrep.** Adopt as is. Namespace imports keep `make` and `layer` readable at every call site.

## 2. Layout and naming

### Rule: one module per service, in a fixed order, inside a domain folder

The order inside a module is imports, errors and schemas, the `Context.Service` tag, `make`, then `layer`. Each domain folder holds its services, their tests beside them, and plain helper files for pure work.

```
infra/relay/src/
  worker.ts             entry point, root layer, queue consumers, cron
  Config.ts             RelayConfiguration service
  db.ts                 RelayDb and RelayTransactions services
  persistence/schema.ts Drizzle tables
  http/Api.ts           HTTP handlers and auth middleware
  environments/         EnvironmentLinks.ts, ManagedTunnelLimits.ts, *.test.ts, endpointFailure.ts
  agentActivity/        ApnsDeliveries.ts, ApnsDeliveryQueue.ts, apnsJwt.ts, fcmPayloads.ts
  auth/                 RelayTokens.ts, DpopProofs.ts
```

File names follow the export. Service modules are PascalCase (`ManagedTunnelLimits.ts`). Pure helper modules are camelCase (`fcmPayloads.ts`, `apnsJwt.ts`). Tests sit next to the file as `Foo.test.ts`. Moving a service deletes the old file and updates every consumer, with no re-export shims.

**For Stargrep.** Adapt. `docs/architecture.md` sets kebab-case files named after their export, so `StarSync` lives in `star-sync.ts` and is imported as `import * as StarSync from "./star-sync.ts"`. Keep T3 Code's module order, one service per module, tests beside the file, and no re-export shims. The service key follows the file path, as section 1 says, so moving or renaming a service file changes its key.

### Rule: name things by role

| Thing | T3 Code name | Example |
|---|---|---|
| Service tag | Noun, PascalCase | `ManagedTunnelLimits`, `T3ChatAccounts` |
| Production layer | `layer`, or `layer<Platform>` in a port module | `layerCloudflareQueues` |
| Test layer in a test file | `layerTest` | `apps/server/src/workspace/WorkspacePaths.test.ts` |
| Error | `<Thing><What happened>` with an `Error` suffix in the server and often without it in the relay | `WorkspaceRootNotExistsError`, `ManagedTunnelLimitExceeded` |
| Error union | `<Service>Error` as a `Schema.Union` | `WorkspacePathsError` |
| Schema and its type | Same name for the value and the type | `export const ThreadId = ...; export type ThreadId = typeof ThreadId.Type` |
| Config value | `<name>Config` | `managedEndpointCleanupModeConfig` |
| Predicate | `is<Thing>` | `export const isFoo = Schema.is(Foo)` |

**For Stargrep.** Adopt, with one fix. Pick one error suffix rule, since T3 Code mixes both. Use a past-tense or state name without the `Error` suffix (`RepoNotFound`, `StarSyncFailed`, `TokenBudgetExhausted`), because `_tag` already marks it as an error.

## 3. Errors

### Rule: failures are `Schema.TaggedError` classes with structured fields and a fixed message

Fields carry the operation, the entity id, and a category. The message is built from those fields, never from `cause`. A wrapping error keeps the underlying failure as `cause: Schema.Defect()`.

```ts
// infra/relay/src/environments/ManagedTunnelLimits.ts
export class ManagedTunnelLimitPersistenceError extends Schema.TaggedError<ManagedTunnelLimitPersistenceError>()(
  "ManagedTunnelLimitPersistenceError",
  {
    operation: Schema.Literals(["transaction", "lock-user", "load-limit", "count-tunnels"]),
    userId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Managed tunnel limit '${this.operation}' failed for user '${this.userId}'`;
  }
}
```

Three more rules from `docs/internals/effect-services.md`:

- Fields and log annotations stay bounded. No raw payloads, tokens, signed URLs, or query strings. The exact value lives only in `cause`.
- Split one error into two classes when callers branch on the difference. A field that only helps diagnosis stays a field. Never encode one distinction twice, as a tag and a one-value `reason` literal.
- No helper that only does `(...args) => new SomeError({...args})`. A real mapper becomes a static factory on the error class.

**For Stargrep.** Adopt as is. GitHub tokens, model prompts, and README text must never land in an error field.

### Rule: an error from a credentialed request keeps a bounded `reason` and no `cause`

This rule is Stargrep's own. An `HttpClientError` holds the request, with its `Authorization` header, and the response, with its body. Printing redacts the header, but plain property access returns the token, and a tracer exports a failure's stack as `exception.stacktrace`. So T3 Code's "the exact value lives only in `cause`" leaks a token when the request carried one.

An error raised by a request that sends a token or another credential keeps only bounded fields: the operation, the method, the URL path without the query, the status, and a `reason` literal such as `transport`, `timeout`, or `status`. It has no `cause`. Map the failure to that error inside the span that sent the request, so the span records only the bounded error, and turn off `HttpClient`'s own client span with `HttpClient.TracerDisabledWhen`. `packages/github` does this in `TokenGate`.

**For Stargrep.** Adopt. A test walks every reachable property of such an error, and the traces it exports, and finds no token and no body text.

### Rule: catch known tags with `Effect.catchTags`, even for one tag

```ts
// apps/server/src/pullRequest/PullRequestReadCache.ts
backing.get("revisions").pipe(
  Effect.flatMap((raw) => Schema.decodeEffect(revisionCodec)(raw ?? "{}")),
  Effect.catchTags({
    SchemaError: Effect.fn("PullRequestReadCache.recoverRevisions")(function* () {
      yield* backing.clear;
      yield* Effect.logWarning("PR cache reset after invalid scope revisions");
      return yield* Schema.decodeEffect(revisionCodec)("{}");
    }),
  }),
),
```

`Effect.catch` handles the whole channel. `catchIf` is for structural checks such as a platform error code. Lint rule `t3code/prefer-catch-tags` bans `catchTag`.

**For Stargrep.** Adopt. Biome cannot load a JS rule like `prefer-catch-tags`, so enforce it in review or with a Biome GritQL plugin.

### Rule: map domain errors to wire errors only in the transport, with a code and a trace id

Services fail with domain errors. The HTTP handler maps each tag to a wire error defined in `packages/contracts`. The wire error carries a stable `code`, a `traceId`, and an HTTP status. TypeScript checks that the map covers only tags the effect can raise.

```ts
// infra/relay/src/http/Api.ts
mapErrorTags({
  ManagedTunnelLimitExceeded: (limitError, traceId) =>
    new RelayEnvironmentLinkLimitExceededError({
      code: "environment_link_limit_exceeded",
      maxTunnels: limitError.maxTunnels,
      traceId,
    }),
  EnvironmentLinkUpsertPersistenceError: (_error, traceId) =>
    new RelayEnvironmentLinkFailedError({
      code: "environment_link_failed",
      reason: "link_persistence_failed",
      traceId,
    }),
  // ...
}),
```

```ts
// packages/contracts/src/relay.ts
export class RelayEnvironmentLinkLimitExceededError extends Schema.TaggedError<RelayEnvironmentLinkLimitExceededError>()(
  "RelayEnvironmentLinkLimitExceededError",
  {
    code: Schema.Literal("environment_link_limit_exceeded"),
    maxTunnels: Schema.Number,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 403 },
) { /* message from fields */ }
```

A handler "decodes input, calls one service method, and maps errors. Nothing else" (`AGENTS.md`). The reason given is reach. The same capability is called from WebSocket, MCP, scheduled tasks, and the CLI, so logic in one handler is missing from the others.

**For Stargrep.** Adapt. Stargrep's transport is oRPC, not Effect `HttpApi`. Define wire errors once in `packages/api` as oRPC typed errors with a `code` and a `traceId`. Map domain tags to them in the router with an exhaustive `catchTags`. This matters more for Stargrep, because one oRPC router serves the web client, REST, and MCP. Note that T3 Code's own `apps/server/src/ws.ts` still has handlers that copy `cause.message` into the wire error. The docs call those legacy, so don't copy them.

## 4. Schemas

### Rule: brand every entity id with one helper

```ts
// packages/contracts/src/baseSchemas.ts
const makeEntityId = <Brand extends string>(brand: Parameters<typeof Schema.brand<Brand>>[0]) => {
  return TrimmedNonEmptyString.pipe(Schema.brand<Brand>(brand));
};

export const ThreadId = makeEntityId("ThreadId");
export type ThreadId = typeof ThreadId.Type;
export const ProjectId = makeEntityId("ProjectId");
export type ProjectId = typeof ProjectId.Type;
```

**For Stargrep.** Adapt. Stargrep keys accounts and repos by GitHub numeric ids, so the base is a positive integer. Something like `const makeGitHubId = (brand) => Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)), Schema.brand(brand))` gives `GitHubAccountId` and `RepoId`. Logins and repo names get their own brands so they never pass for ids.

### Rule: wire contracts live in one package that every side imports

`packages/contracts` holds every schema that crosses a process or network boundary. `AGENTS.md` says "Change the schema and the server, web, mobile, and desktop all follow." The package is limited to "Effect/Schema contracts plus small derived helpers. No heavy runtime logic."

**For Stargrep.** Adopt. `packages/api` plays this role for oRPC. Domain types that never cross the wire stay in their `packages/core` feature folder.

### Rule: decode external data at the boundary with a hoisted decoder

Decoders compile once at module scope. The lint rule `t3code/no-inline-schema-compile` reports `Schema.decode*` calls inside function bodies, because each call rebuilds the compiled function.

```ts
// infra/relay/src/t3chat/T3ChatAccounts.ts
const decodeLinkResponse = Schema.decodeUnknownEffect(
  Schema.Struct({ link: Schema.NullOr(RelayT3ChatLink) }),
);
// ...
getLink: Effect.fn("relay.t3chat.get_link")(function* (input) {
  const body = yield* post("get-link", "/api/t3code/link", input.userId);
  const decoded = yield* decodeLinkResponse(body).pipe(
    Effect.mapError((cause) => new T3ChatRequestFailed({ operation: "get-link", cause })),
  );
  return decoded.link;
}),
```

Queue messages are `unknown` until decoded. `ApnsDeliveries.processSignedJob(body: unknown)` decodes first and fails with `ApnsDeliveryJobQueuePayloadInvalid`, which records only the received type, never the payload (`infra/relay/src/agentActivity/ApnsDeliveries.ts`). For HTTP responses the server also uses `HttpClientResponse.schemaBodyJson(Schema)` (`apps/server/src/cloud/CliTokenManager.ts`).

**For Stargrep.** Adopt as is. It applies to GitHub responses, GH Archive rows, queue bodies, model output, and the `QueryPlan`. Biome has no rule for hoisting, so cover it in review.

### Rule: SQL rows decode through a schema too

The Node server wraps raw SQL in `SqlSchema` so rows decode on the way out.

```ts
// apps/server/src/persistence/AuthSessions.ts
const getSessionRowById = SqlSchema.findOneOption({
  Request: GetAuthSessionByIdInput,
  Result: AuthSessionRawDbRow,
  execute: ({ sessionId }) =>
    sql`
      SELECT session_id AS "sessionId", subject AS "subject", /* ... */
      FROM auth_sessions
      WHERE session_id = ${sessionId}
    `,
});
```

The relay, which uses Drizzle, does not decode rows. It trusts Drizzle's column types and casts JSON columns with `.$type<T>()` (`infra/relay/src/persistence/schema.ts`).

**For Stargrep.** Adapt. Use `drizzle-orm/effect-schema`, as `docs/architecture.md` already plans, to derive row schemas from tables. Decode `jsonb` columns with a schema rather than `.$type<T>()`, since a cast hides drift between old rows and new code.

## 5. Config and secrets

### Rule: read config with `effect/Config` once at the entry point, then hand a typed service to the rest

Secrets use `Config.Redacted`. Enums and numbers parse with `Config.schema`. Optional values use `Config.option` or `Config.withDefault`. The Worker reads everything in its init effect and builds one `RelayConfiguration` service. Services read that service, never the environment.

```ts
// infra/relay/src/worker.ts
const apnsEnabled = yield* Config.Boolean("APNS_ENABLED").pipe(Config.withDefault(true));
const apnsCredentials = apnsEnabled
  ? {
      environment: yield* Config.schema(RelayConfiguration.ApnsEnvironment, "APNS_ENVIRONMENT"),
      teamId: yield* Config.String("APNS_TEAM_ID"),
      privateKey: yield* Config.Redacted("APNS_PRIVATE_KEY"),
      // ...
    }
  : null;
const clerkSecretKey = yield* Config.Redacted("CLERK_SECRET_KEY");
```

```ts
// infra/relay/src/Config.ts
export const legacyTunnelGraceMinutesConfig = Config.option(
  Config.schema(
    Schema.NumberFromString.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThan(0))),
    RELAY_LEGACY_TUNNEL_GRACE_MINUTES,
  ),
);

export class RelayConfiguration extends Context.Service<RelayConfiguration, {
  readonly clerkSecretKey: Redacted.Redacted<string>;
  // ...
}>()("t3code-relay/Config/RelayConfiguration") {}

export const layer = (configuration: RelayConfiguration["Service"]) =>
  Layer.succeed(RelayConfiguration, RelayConfiguration.of(configuration));
```

`Redacted.value(secret)` is called only at the point of use, such as `HttpClientRequest.bearerToken(Redacted.value(linkSecret))`. The `Layer.succeed` form also gives tests a one-line config layer (`RelayConfiguration.layer(config)` in `ApnsDeliveryQueue.test.ts`). The Node CLI groups its env config with `Config.all({...})` in `apps/server/src/cli/config.ts`.

**For Stargrep.** Adopt. On Workers, env vars and secrets come from the `env` bindings object, not `process.env`. In the relay, Alchemy's runtime supplies a `ConfigProvider` backed by that object (`.repos/alchemy-effect/packages/alchemy/src/Runtime.ts`), so `Config.String` just works. Without Alchemy at runtime, provide `ConfigProvider.fromUnknown(env)` at the entry point. Stargrep's "validated at startup" means validated in each Worker's init effect. That runs on isolate start, not once per deploy.

## 6. Concurrency and resources

### Rule: name a retry schedule as a constant and bound it

```ts
// apps/server/src/cloud/managedTunnelStartup.ts
// Retries must rerun the operation: HttpClient.retryTransient would reuse proofs that
// expire after 60 s or single-use link challenges.
const relayRetrySchedule = Schedule.exponential("1 second").pipe(
  Schedule.jittered,
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, RELAY_RETRY_MAX_DELAY)),
  ),
  Schedule.modifyDelay(({ duration, input }) => {
    const retryAfterMillis = relayRetryAfterMillis(input);
    return Effect.succeed(
      retryAfterMillis === undefined ? duration : Duration.max(duration, Duration.millis(retryAfterMillis)),
    );
  }),
);
```

Inline retries state their count, such as `Effect.retry({ times: 2, schedule: Schedule.exponential("2 seconds") })` in `apps/server/src/orchestration-v2/ThreadTitleRegenerationService.ts`. Then a `catchCause` keeps interrupts as interrupts and logs the rest.

**For Stargrep.** Adopt. Stargrep's GitHub client honors `Retry-After` and `x-ratelimit-reset` the same way. Use queue retries for step-level failure and keep in-process `Effect.retry` for short transient calls.

### Rule: put a timeout on every external call, covering the body read

```ts
// infra/relay/src/t3chat/T3ChatAccounts.ts
// The timeout covers the body read so a stalled response still fails fast.
return yield* HttpClientRequest.post(new URL(path, baseUrl).toString()).pipe(
  HttpClientRequest.bearerToken(Redacted.value(linkSecret)),
  HttpClientRequest.bodyJsonUnsafe({ clerkUserId: userId }),
  client.execute,
  Effect.flatMap(HttpClientResponse.filterStatusOk),
  Effect.flatMap((response) => response.json),
  Effect.timeout(T3CHAT_REQUEST_TIMEOUT),
  Effect.mapError((cause) => new T3ChatRequestFailed({ operation, cause })),
);
```

**For Stargrep.** Adopt as is. Workers bill wall time against a request, so a hung GitHub or model call is a real cost.

### Rule: acquire resources with `acquireRelease` inside `Effect.scoped`

```ts
// infra/task-cache/src/Cache.ts
Effect.scoped(
  Effect.gen(function* () {
    const controller = yield* Effect.acquireRelease(
      Effect.sync(() => new AbortController()),
      (value) => Effect.sync(() => value.abort()),
    );
    // ...
    yield* Effect.addFinalizer(() => Effect.annotateCurrentSpan(/* stats */));
  }),
),
```

**For Stargrep.** Adopt as is.

### Rule: background fibers are scoped to a layer, never detached by default

Long-running work starts in `Layer.effectDiscard` with `Effect.forkScoped`, so it stops when the layer's scope closes.

```ts
// apps/server/src/orchestration-v2/EffectOutbox.ts
export const layerPruneWorker = Layer.effectDiscard(
  Effect.gen(function* () {
    const outbox = yield* EffectOutboxV2;
    yield* forkParked(
      outbox.pruneSettled.pipe(
        Effect.catch((cause) => Effect.logWarning("Failed to prune settled effects", { cause })),
        Effect.repeat(Schedule.spaced(Duration.hours(1))),
      ),
    );
  }),
);
```

**For Stargrep.** Skip the pattern and keep the idea. A Worker has no long-lived process for a repeating fiber. Stargrep's equivalent is a cron trigger. The relay's cron is the model to copy. It runs prune jobs with `Effect.all([...], { concurrency: 3, discard: true })`, each with its own `Effect.timeout` and a `catchCause` that logs and keeps interrupts (`infra/relay/src/worker.ts`).

### Rule: serialize shared state in the database, not in memory, when more than one process runs

The Node server guards local writes with `Semaphore.make(1)` (`apps/server/src/serverSettings.ts`). The relay runs across many Worker isolates, so it locks in Postgres instead.

```ts
// infra/relay/src/environments/ManagedTunnelLimits.ts
// Held until commit, so the count below sees every reservation that took the lock first.
yield* db
  .execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`managed-tunnel-limit:${input.userId}`}, 0))`,
  )
  .pipe(Effect.mapError((cause) => new ManagedTunnelLimitPersistenceError({ operation: "lock-user", userId: input.userId, cause })));
// ...
return yield* db.$client.withTransaction(checkAndReserve).pipe(/* map transaction SqlError */);
```

**For Stargrep.** Adopt. `docs/architecture.md` wants GitHub requests sent one after another per token. An in-memory `Semaphore` does not do that across isolates. Stargrep uses a Durable Object per token, as `docs/architecture.md` describes. T3 Code does not cover this case.

### Rule: Postgres behind Hyperdrive runs with `prepare: false`

```ts
// infra/relay/src/worker.ts
const hyperdrive = yield* Cloudflare.Hyperdrive.Connect(yield* RelayDb.RelayHyperdrive);
// Named statements collide behind Hyperdrive transaction pooling (Effect-TS/effect#8320); use unnamed statements.
const db = yield* Drizzle.Postgres(hyperdrive.connectionString, {
  client: { prepare: false },
});
```

Alchemy's `Drizzle.Postgres` helper builds `@effect/sql-pg`'s `PgClient.layer` and wraps it with `drizzle-orm/effect-postgres` (`.repos/alchemy-effect/packages/alchemy/src/Drizzle/Postgres.ts`). The relay Worker sets the `nodejs_compat` flag, pins `drizzle-orm` `1.0.0-rc.5-ab785fc`, and talks to PlanetScale Postgres through Hyperdrive.

**For Stargrep.** Adopt for any `@effect/sql-pg` client. `docs/architecture.md` leaves open whether `drizzle-orm/effect-postgres` works through Hyperdrive on Workers, and names its default named prepared statements as a risk. T3 Code runs that exact stack in production with `prepare: false`, which is evidence the phase 0 prototype should pass. Neon is not PlanetScale, so the prototype still has to run.

## 7. Testing

### Rule: test through the service with real layers, faking only external systems

```ts
// apps/server/src/workspace/WorkspacePaths.test.ts
const layerTest = Layer.empty.pipe(
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(layerTest)("WorkspacePathsLive", (it) => {
  it.effect("rejects paths that escape the workspace root", () =>
    Effect.gen(function* () {
      const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
      const cwd = yield* makeTempDir();
      const error = yield* workspacePaths
        .resolveRelativePathWithinRoot({ workspaceRoot: cwd, relativePath: "../escape.md" })
        .pipe(Effect.flip);
      expect(error.message).toContain("Workspace file path must be relative to the project root: ../escape.md");
    }),
  );
});
```

Fakes are layers. `Layer.mock` stubs only the methods a test touches. `HttpClient.make` fakes an HTTP server.

```ts
// infra/relay/src/environments/ManagedTunnelLimits.test.ts
const t3ChatLayer = (plan: RelayT3ChatPlan | "lookup-fails", lookups?: Array<string>) =>
  Layer.mock(T3ChatAccounts.T3ChatAccounts, {
    available: true,
    getLink: ({ userId }) => {
      lookups?.push(userId);
      return plan === "lookup-fails"
        ? Effect.fail(new T3ChatAccounts.T3ChatRequestFailed({ operation: "get-link", cause: new Error("down") }))
        : Effect.succeed({ email: "theo@example.com", plan });
    },
  });
```

**For Stargrep.** Adopt `Layer.mock` and `HttpClient.make`. Both are plain Effect and work under any runner. Skip one relay habit. Several relay tests hand-build a fake Drizzle object and cast it with `as unknown as RelayDb.RelayDb["Service"]` (`EnvironmentLinks.test.ts`, `ManagedTunnelLimits.test.ts`). Those tests break on any query refactor. For SQL behavior, run real SQL. T3 Code already does this in one `ManagedTunnelLimits.test.ts` case with PGlite (`drizzle({ client: pg })`). For `packages/core`, give `Db`-backed services an in-memory repository layer instead of a fake Drizzle object.

### Rule: time is virtual in tests, and nothing waits on wall clock

`it.effect` runs on `TestClock`, so `Effect.sleep` and `Effect.timeout` advance only through `TestClock.adjust`. Tests wait on a `Deferred`, a `Queue`, or a drained worker, never on sleeps or polling. No per-test timeout and no retries. `vite.config.ts` sets `retry: 0` with the comment "Flaky tests are fixed, not retried."

```ts
// infra/relay/src/t3chat/T3ChatAccounts.test.ts
it.effect("times out when T3 Chat stalls while sending the body", () => {
  // client returns a body stream that never ends
  return Effect.gen(function* () {
    const accounts = yield* T3ChatAccounts.T3ChatAccounts;
    const fiber = yield* Effect.forkChild(Effect.flip(accounts.getLink({ userId: "user_1" })));
    yield* TestClock.adjust("5 seconds");
    const error = yield* Fiber.join(fiber);
    expect(error._tag).toBe("T3ChatRequestFailed");
  }).pipe(provide(client));
});
```

Lint rules `t3code/no-wall-clock-in-tests`, `no-real-time-wait-in-tests`, `no-polling-loop-in-tests`, and `no-test-timeout-or-unreasoned-skip` enforce this. A skipped test needs `// quarantine: #1234 <why>` above it.

**For Stargrep.** Adopt. `TestClock` is part of `effect`, so it works under `bun test`.

### What changes with `bun test` instead of `@effect/vitest`

T3 Code runs every test with `@effect/vitest` 4.1.2 through Vite+. Its lint rule `t3code/no-manual-effect-runtime-in-tests` bans `Effect.runPromise` in tests and says "Use @effect/vitest with it.effect(...) and test layers instead." Stargrep has to invert that. The upstream source shows what `it.effect` does (`.repos/effect-smol/packages/vitest/src/internal/internal.ts`). It wraps the test in `Effect.scoped`, provides `Layer.mergeAll(TestConsole.layer, TestClock.layer())`, and calls `Effect.runPromise` with the test's abort signal. `it.live` does the same without the test services. `it.layer(L)` builds `L` once in `beforeAll` and closes its scope in `afterAll`.

[`packages/testing`](../packages/testing/src/index.ts) gives Stargrep the same behavior on `bun test`. It exports `effect` and `live`, each with `only`, `skip`, and `failing`, and `layer`, which builds a layer once for a block of tests. Its tests check virtual time, finalizers on success, failure, and timeout, one layer build per block, and `Layer.mock`.

```ts
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as it from "@stargrep/testing";

it.effect("wakes after an hour of virtual time", () =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(Effect.sleep("1 hour"));
    yield* TestClock.adjust("1 hour");
    expect(fiber.pollUnsafe()).toBeDefined();
  }),
);

it.layer(Layer.mock(GitHub, { getRepo: () => Effect.succeed({ stars: 42 }) }))("GitHub", (it) => {
  it.effect("reads the stubbed repo", () =>
    Effect.gen(function* () {
      expect((yield* (yield* GitHub).getRepo("effect")).stars).toBe(42);
    }),
  );
});
```

Limits of `bun test` that the helper cannot remove:

- Bun passes no abort signal to a test. The helper makes one from `onTestFinished`, which Bun refuses inside concurrent tests, so every helper test fails under `--concurrent`. Run tests with `--parallel`.
- The helper takes no per-test timeout. Set one for the run with `bun test --timeout <ms>`.
- Ctrl-C ends the run without running finalizers.
- Tests in one `layer` block share one `TestClock` on purpose.
- Stock `tsc` does not load the `@effect/language-service` plugin. With TypeScript 7, run `effect-tsgo tsc` from `@effect/tsgo`. With TypeScript 6, run `effect-language-service patch` once, then `tsc`.

Other differences:

- `vi.mock` becomes `mock.module` from `bun:test`. T3 Code uses `vi.mock` once in the relay tests, to stub `@clerk/backend`. Prefer wrapping a promise SDK in a service and faking the service, which needs no module mocking.
- Vitest's `fakeTimers` config does nothing under Bun. It doesn't matter when tests use `TestClock`.
- `@effect/vitest` adds `it.prop` for property tests. Under Bun, call `FastCheck` from `effect/testing` yourself if needed.
- `bun test` runs on Bun, not workerd. `docs/architecture.md` already flags that Worker-level tests need another runner. T3 Code's relay tests also skip workerd and run on Node with `@effect/platform-node`.

**For Stargrep.** Adapt. Write the helper once, and allow `runPromise` only in that file.

## 8. Observability

### Rule: every reusable Effect function is `Effect.fn("Name.operation")`

A named `Effect.fn` creates a span. `Effect.gen` stays for inline programs and layer construction. `Effect.fnUntraced` is for hot paths such as per-chunk or per-message work, with the reason in a comment nearby. Combinators go after the generator body.

```ts
// infra/relay/src/agentActivity/FcmDeliveryQueueConsumer.ts
export const processMessage = Effect.fn("relay.fcm_delivery_queue.process_message")(function* (
  message: Cloudflare.Queues.Message<unknown>,
) {
  const deliveries = yield* FcmDeliveries.FcmDeliveries;
  yield* deliveries.process(message.body).pipe(
    Effect.matchEffect({
      // The enclosing operation owns the span for this inline handler.
      onFailure: Effect.fnUntraced(function* (error) {
        message.retry();
        yield* Effect.logWarning("FCM queue delivery failed; retrying message", {
          messageId: message.id,
          errorTag: error._tag,
        });
      }),
      onSuccess: () => Effect.sync(() => message.ack()),
    }),
  );
});
```

Lint rule `t3code/prefer-effect-fn` reports functions that return `Effect.gen`. The language service adds `effectFnOpportunity: "error"`.

**For Stargrep.** Adopt, with one fix. T3 Code uses two span name styles, `WorkspacePaths.normalizeWorkspaceRoot` in the server and `relay.t3chat.get_link` in the relay. Stargrep picks `Service.operation` everywhere, since it matches the code and is searchable.

### Rule: transports instrument in middleware, and handlers add only per-call attributes

RPC spans and metrics come from one middleware. Handlers call `Effect.annotateCurrentSpan` for context such as an id.

```ts
// apps/server/src/observability/RpcInstrumentation.ts
export const rpcInstrumentationLayer = Layer.succeed(RpcInstrumentation)((effect, { rpc }) => {
  const method = rpc._tag;
  const measured = effect.pipe(
    withMetrics({ counter: rpcRequestsTotal, timer: rpcRequestDuration, attributes: { method } }),
  );
  // ...
  return measured.pipe(
    Effect.withSpan(`${RPC_SPAN_PREFIX}.${method}`, {
      attributes: { ...DEFAULT_RPC_SPAN_ATTRIBUTES, "rpc.method": method },
    }),
  );
});
```

**For Stargrep.** Adapt. Write one oRPC middleware that opens the span and records metrics for every procedure, so REST, MCP, and the web client get the same traces.

### Rule: metrics are module-level constants with a prefix and a description

```ts
// apps/server/src/observability/Metrics.ts
export const rpcRequestsTotal = Metric.counter("t3_rpc_requests_total", {
  description: "Total RPC requests handled by the websocket RPC server.",
});
export const rpcRequestDuration = Metric.timer("t3_rpc_request_duration", {
  description: "RPC request handling duration.",
});
```

**For Stargrep.** Adopt, with a `stargrep_` prefix. Useful early ones are GitHub requests by source and status, `304` hits, queue step outcomes, and model tokens.

### Rule: logs are structured, with bounded fields

Logs use `Effect.logInfo` and `Effect.logWarning` with a fixed message and an object of fields: `Effect.logWarning("Rate limiter unavailable", { error: error.message })` in `infra/relay/src/worker.ts`. The language service bans `console` (`globalConsole: "error"`). The relay exports traces to Axiom through `Axiom.Telemetry(...)` provided at the Worker root.

**For Stargrep.** Adopt. Export to whichever OTLP backend Stargrep picks, provided at each Worker's root layer.

## 9. Interop with non-Effect code

### Rule: `runPromise` and `ManagedRuntime` live only at framework boundaries

`ManagedRuntime.make`, `runPromise`, and `runPromiseExit` belong to React, native callbacks, the CLI, and HTTP adapters. Never in a domain service, repository, or service constructor. A shared resource is composed once in an app-owned layer, never in a per-feature runtime (`docs/internals/effect-services.md`).

**For Stargrep.** Adopt. The boundaries are the oRPC router (through `@orpc/effect`), the queue consumer, the cron handler, and TanStack Start server functions. `packages/core` never calls `runPromise`.

### Rule: wrap promise SDKs in a service with `Effect.tryPromise` and a timeout

```ts
// infra/relay/src/t3chat/T3ChatAccounts.ts
return yield* Effect.tryPromise({
  try: async () => {
    const user = await createClerkClient({
      secretKey: Redacted.value(config.clerkSecretKey),
      publishableKey: config.clerkPublishableKey,
    }).users.getUser(userId);
    const email = user.primaryEmailAddress?.emailAddress;
    if (!email) throw new Error("Clerk user has no primary email address.");
    return email;
  },
  catch: (cause) => new ClerkUserLookupFailed({ cause }),
}).pipe(
  Effect.timeoutOrElse({
    duration: T3CHAT_REQUEST_TIMEOUT,
    orElse: () => Effect.fail(new ClerkUserLookupFailed({ cause: "timed out" })),
  }),
);
```

**For Stargrep.** Adopt. Vercel AI SDK goes behind `Ai` and Better Auth behind its own service this way. Pass an `AbortSignal` from `Effect.tryPromise`'s `try: (signal) => ...` where the SDK accepts one, so interrupts cancel the request.

### Rule: Drizzle runs as Effects through `drizzle-orm/effect-postgres`, behind a `Db` service

```ts
// infra/relay/src/db.ts
export class RelayDb extends Context.Service<
  RelayDb,
  EffectPgDatabase & {
    readonly $client: PgClient;
  }
>()("t3code-relay/db/RelayDb") {}

export class RelayTransactions extends Context.Service<
  RelayTransactions,
  { readonly withTransaction: RelayDb["Service"]["$client"]["withTransaction"] }
>()("t3code-relay/db/RelayTransactions") {
  static readonly layer = Layer.effect(RelayTransactions, Effect.gen(function* () {
    const db = yield* RelayDb;
    return RelayTransactions.of({ withTransaction: db.$client.withTransaction });
  }));
}
```

Queries return Effects, so they pipe straight into `Effect.map` and `Effect.mapError`. Each statement maps its own `SqlError` to a domain error with the operation name. Errors left at the transaction edge come from open or commit (`ManagedTunnelLimits.ts`).

**For Stargrep.** Adapt. `docs/architecture.md` starts `Db` on `drizzle-orm/node-postgres` and `pg`, because Better Auth's Drizzle adapter awaits queries, and moves core to `effect-postgres` only if phase 0 passes. That makes the shape of the `Db` service matter more than the driver. If `Db` exposes the whole Drizzle database the way `RelayDb` does, core imports Drizzle types, ties itself to one driver, and loses its in-memory test layer. Make `Db`'s methods the query functions from `packages/db`, each returning an Effect with a typed error. On `pg`, each method wraps the promise with `Effect.tryPromise` and maps the failure to a domain error with the operation name, as `ManagedTunnelLimits.ts` does for `SqlError`. Keep `withTransaction` as its own service like `RelayTransactions`. A later move to `effect-postgres` then changes only `packages/db`.

### Rule: Effect runs in the browser through atoms

`apps/web` builds a `ManagedRuntime` and an `Atom.runtime` from layers, and React reads state with `useAtomValue` from `@effect/atom-react` (`apps/web/src/lib/runtime.ts`, `apps/web/src/connection/runtime.ts`).

**For Stargrep.** Adapt. Skip atoms and `ManagedRuntime` state, because TanStack DB owns client state and a second store would split ownership. Use Effect in the browser only in code-split routes where it does real work, such as the search box's `Stream` pipeline. Public pages load no Effect code. A probe bundle measured about 25 KB gzipped for Schema alone, 34 KB for the runtime with `Stream` and Schema, and 49 KB with atoms added.

## 10. What they avoid, and the lint that enforces it

The language service config in `tsconfig.base.json` sets these to `error`. They are the cheapest rules to copy, because the plugin is a TypeScript plugin and works with any linter.

- `globalDate`, `globalRandom`, `globalTimers`, `globalFetch`, `globalConsole`, `cryptoRandomUUID`, plus their `*InEffect` forms. Use `Clock` or `DateTime.now`, `Random`, `Effect.sleep`, `HttpClient`, `Effect.log*`, and `SecureRandom`. These are what make `TestClock` and fake layers work.
- `runEffectInsideEffect`, `tryCatchInEffectGen`, `abortControllerInEffect`. No nested runtimes, no `try/catch` inside generators.
- `missingEffectServiceDependency`, `leakingRequirements`. A service's requirements show up in its type.
- `globalErrorInEffectFailure`, `globalErrorInEffectCatch`, `unknownInEffectCatch`, `anyUnknownInErrorContext`. Failures are tagged errors, not `Error` or `unknown`.
- `preferSchemaOverJson`, `schemaSyncInEffect`, `preferTypedSchemaDecoder`, `instanceOfSchema`. Use Schema to parse JSON, and decode with Effects.
- `nodeBuiltinImport`. No `node:` imports in Effect code. T3 Code turns it off per file with a stated reason, for example `// @effect-diagnostics nodeBuiltinImport:off` in `apps/server/src/entrypoint.ts`.
- `unstableApiUsage` and `experimentalApiUsage` are off, with the comment "We use Effect's unstable modules (http, sql) on purpose."

Custom oxlint rules in `oxlint-plugin-t3code/rules/` that touch Effect: `prefer-effect-fn`, `prefer-catch-tags`, `no-inline-schema-compile`, `no-manual-effect-runtime-in-tests`, `no-global-process-runtime`, the test timing rules above, and `require-suppression-reason`, which makes every disable directive state why.

Other things the docs argue against:

- A transport handler that does more than decode, call one method, and map errors.
- Hiding a dependency in a module global, a closure over a singleton, or a `Layer.succeed` that calls an imperative API.
- A service constructor that calls `runPromise`.
- Re-export shims after a move.
- Tests that mock the logic under test, use sleeps or polling, set per-test timeouts, or retry.
- Comments that restate code. `AGENTS.md` says "Default to no comment", with one to four lines allowed for a constraint, an external quirk, or an invariant.

**For Stargrep.** Adopt the language service config close to whole, including the test overrides. Biome cannot run the custom JS rules, so `prefer-effect-fn`, `prefer-catch-tags`, and `no-inline-schema-compile` need Biome GritQL plugins or a review check. T3 Code's `.macroscope` check is a model for the review check. It reviews only changed lines and posts a specific fix.

## The ten rules that matter most

1. **Services are `Context.Service` classes with the interface inline.** `make` yields its dependencies from the environment, `layer = Layer.effect(Foo, make)`, and a platform implementation is `layer<Platform>`.
2. **Transports stay thin.** An oRPC procedure, queue consumer, or cron handler decodes input, calls one service method, and maps errors. Logic in a handler is invisible to MCP and to the other transports.
3. **Errors are `Schema.TaggedError` classes with bounded, structured fields.** The message comes from the fields, the original failure stays in `cause`, and no secret or payload goes in a field.
4. **Map domain errors to wire errors only at the transport, with a stable `code` and a `traceId`.** Catch known tags with an exhaustive `Effect.catchTags`.
5. **Decode every external input at the boundary with a decoder hoisted to module scope.** That covers GitHub, GH Archive, queue bodies, model output, and `jsonb` columns. Inside, trust the types.
6. **Brand every id.** GitHub numeric ids get `GitHubAccountId` and `RepoId`. Logins and repo names get their own brands.
7. **Read config with `effect/Config` once per Worker entry, secrets as `Redacted`, into one typed config service.** Services never read the environment.
8. **Every reusable Effect function is `Effect.fn("Service.operation")`.** Untraced only for hot paths, with a comment saying why.
9. **No globals inside Effect code.** Use `Clock`, `Random`, `HttpClient`, and `Effect.log*`, enforced by `@effect/language-service`. This is what lets tests run on `TestClock` and fake layers.
10. **Tests go through the service, with fake layers only for external systems, on `TestClock`, with no sleeps, timeouts, or retries.** Under `bun test`, one helper file replaces `it.effect` and `it.layer` and is the only place allowed to call `runPromise`.
