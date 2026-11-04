import "@orpc/effect/extensions/effect";
import { middlewareGen, type WithEffectContext } from "@orpc/effect";
import type { ToStandardErrorMap } from "@orpc/effect/extensions/schema";
import { implement, ORPCError, type ORPCErrorConstructorMap } from "@orpc/server";
import { Search } from "@stargrep/core/search";
import { SyncRequests } from "@stargrep/core/stars";
import * as Db from "@stargrep/db";
import type { Login } from "@stargrep/github/schemas";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { contract } from "./contract.ts";
import { errorStatus, type WireCode, errors as wireErrors } from "./errors.ts";
import { instrumentation, type Transport } from "./middleware/instrumentation.ts";
import { SyncLimiter } from "./sync-limiter.ts";

export type ApiServices = Db.Db | Search.Search | SyncRequests.SyncRequests | SyncLimiter;

export class ApiServicesUnavailable extends Schema.TaggedError<
  ApiServicesUnavailable,
  { readonly brand: unique symbol }
>()("ApiServicesUnavailable", {
  failure: Schema.String,
}) {
  override get message(): string {
    return `The API services failed to start with ${this.failure}`;
  }
}

// The services are built only once a procedure has validated its input, so a database outage
// fails a search with a wire error and leaves validation, the MCP tool list, and the spec working.
export interface ApiContext extends WithEffectContext<never> {
  readonly transport: Transport;
  readonly services: Effect.Effect<Context.Context<ApiServices>, ApiServicesUnavailable>;
}

type ServiceError = Search.SearchError | SyncRequests.SyncRequestError;

const wireCodes: Record<ServiceError["_tag"], WireCode> = {
  SearchScopeUnavailable: "SCOPE_UNAVAILABLE",
  AiKeyMissing: "SERVICE_UNAVAILABLE",
  AiRequestFailed: "SERVICE_UNAVAILABLE",
  AiTimeout: "SERVICE_UNAVAILABLE",
  AiUnavailable: "SERVICE_UNAVAILABLE",
  DbQueryFailed: "SERVICE_UNAVAILABLE",
  SyncQueueFailed: "SERVICE_UNAVAILABLE",
  AiModelNotFound: "INTERNAL_SERVER_ERROR",
  AiOutputInvalid: "INTERNAL_SERVER_ERROR",
  DbRowInvalid: "INTERNAL_SERVER_ERROR",
  EmbeddingModelMismatch: "INTERNAL_SERVER_ERROR",
};

const toWire =
  (errors: ORPCErrorConstructorMap<ToStandardErrorMap<typeof wireErrors>>, traceId: string) =>
  (error: ServiceError) => {
    const code = wireCodes[error._tag];
    const failure = Effect.fail(errors[code]({ data: { traceId } }));
    return errorStatus[code] < 500
      ? failure
      : Effect.logError("API call failed", { error: error._tag, detail: error.message, traceId }).pipe(
          Effect.andThen(failure),
        );
  };

const iso = (time: DateTime.Utc | null) => (time === null ? null : DateTime.formatIso(time));

const githubUrl = (repo: { readonly owner: string; readonly name: string }) =>
  `https://github.com/${repo.owner}/${repo.name}`;

const syncStatus = (login: Login, status: SyncRequests.SyncStatus) => ({
  login,
  state: status.state,
  requestedAt: status.state === "queued" ? iso(status.requestedAt) : null,
  syncedAt: status.state === "unknown" ? null : iso(status.syncedAt),
});

const provideServices = middlewareGen<ApiContext & { readonly traceId: string }, WithEffectContext<ApiServices>>(
  function* ({ context, next }) {
    const services = yield* context.services.pipe(
      Effect.catchTags({
        ApiServicesUnavailable: (error) =>
          Effect.logError("API services failed to start", { failure: error.failure, traceId: context.traceId }).pipe(
            Effect.andThen(
              Effect.fail(
                new ORPCError("SERVICE_UNAVAILABLE", {
                  message: wireErrors.SERVICE_UNAVAILABLE.message,
                  data: { traceId: context.traceId },
                }),
              ),
            ),
          ),
      }),
    );
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off - oRPC types every downstream failure as unknown.
    return yield* next({ context: { "effect/context": Context.merge(context["effect/context"], services) } });
  },
);

const implementer = implement(contract).$context<ApiContext>();
const os = implementer.use(instrumentation);

export const router = implementer.router({
  search: os.search.use(provideServices).effect(function* ({ input, context, errors }) {
    const wire = toWire(errors, context.traceId);
    const accountId = Db.Db.use((db) => db.accounts.byLogin(input.login)).pipe(
      Effect.catch(wire),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(errors.ACCOUNT_NOT_SYNCED({ data: { traceId: context.traceId } })),
          onSome: (account) => Effect.succeed(account.id),
        }),
      ),
    );
    const scope: Search.Scope =
      input.scope === "global" ? { _tag: "global" } : { _tag: input.scope, accountId: yield* accountId };
    const outcome = yield* (yield* Search.Search)
      .search({ scope, query: input.q, limit: input.limit })
      .pipe(Effect.catch(wire));
    return {
      planSource: outcome.planSource,
      results: outcome.results.map((result) => ({
        id: result.repo.id,
        owner: result.repo.owner,
        name: result.repo.name,
        url: githubUrl(result.repo),
        description: result.repo.description,
        summary: result.repo.summary,
        language: result.repo.language,
        topics: result.repo.topics,
        license: result.repo.license,
        kind: result.repo.kind,
        archived: result.repo.archived,
        pushedAt: iso(result.repo.pushedAt),
        reason: Search.reasonLine(result),
        metrics: result.metrics,
      })),
    };
  }),

  triggerSync: os.triggerSync.use(provideServices).effect(function* ({ input, context, errors }) {
    if (!(yield* (yield* SyncLimiter).allow)) {
      return yield* Effect.fail(errors.TOO_MANY_REQUESTS({ data: { traceId: context.traceId } }));
    }
    const requests = yield* SyncRequests.SyncRequests;
    const status = yield* requests.request(input.login).pipe(Effect.catch(toWire(errors, context.traceId)));
    return syncStatus(input.login, status);
  }),

  syncStatus: os.syncStatus.use(provideServices).effect(function* ({ input, context, errors }) {
    const requests = yield* SyncRequests.SyncRequests;
    const status = yield* requests.status(input.login).pipe(Effect.catch(toWire(errors, context.traceId)));
    return syncStatus(input.login, status);
  }),

  getRepo: os.getRepo.use(provideServices).effect(function* ({ input, context, errors }) {
    const repo = yield* (yield* Db.Db).repos.get(input.id).pipe(Effect.catch(toWire(errors, context.traceId)));
    if (Option.isNone(repo)) {
      return yield* Effect.fail(errors.REPO_NOT_FOUND({ data: { traceId: context.traceId } }));
    }
    const { value } = repo;
    return {
      id: value.id,
      owner: value.owner,
      name: value.name,
      url: githubUrl(value),
      description: value.description,
      summary: value.summary,
      keywords: value.keywords,
      language: value.language,
      topics: value.topics,
      license: value.license,
      homepage: value.homepage,
      kind: value.kind,
      archived: value.archived,
      createdAt: iso(value.createdAt),
      pushedAt: iso(value.pushedAt),
    };
  }),
});
