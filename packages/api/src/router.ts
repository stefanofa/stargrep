import "@orpc/effect/extensions/effect";
import { middlewareGen, type WithEffectContext } from "@orpc/effect";
import { implement } from "@orpc/server";
import { Search } from "@stargrep/core/search";
import { SyncRequests } from "@stargrep/core/stars";
import * as Db from "@stargrep/db";
import type { DbQueryFailed, DbRowInvalid, RepoNotFound } from "@stargrep/db/errors";
import type { Login } from "@stargrep/github/schemas";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { contract, type RepoInput, type SearchInput, type SyncInput } from "./contract.ts";
import { errorStatus, type WireCode, wireError } from "./errors.ts";
import { instrumentation, type ProcedureTime, type Transport } from "./middleware/instrumentation.ts";
import { SyncLimiter, type SyncLimiterUnavailable, type SyncRateLimited } from "./sync-limiter.ts";

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

export interface ApiContext extends WithEffectContext<never> {
  readonly transport: Transport;
  readonly procedureTime: ProcedureTime;
  readonly services: Effect.Effect<Context.Context<ApiServices>, ApiServicesUnavailable>;
}

type ApiFailure =
  | Search.SearchError
  | SyncRequests.SyncRequestError
  | RepoNotFound
  | DbQueryFailed
  | DbRowInvalid
  | SyncRateLimited
  | SyncLimiterUnavailable
  | ApiServicesUnavailable;

const wireCodes = {
  AccountNotSynced: "ACCOUNT_NOT_SYNCED",
  RepoNotFound: "REPO_NOT_FOUND",
  SearchScopeUnavailable: "SCOPE_UNAVAILABLE",
  SyncRateLimited: "TOO_MANY_REQUESTS",
  AiKeyMissing: "SERVICE_UNAVAILABLE",
  AiRequestFailed: "SERVICE_UNAVAILABLE",
  AiTimeout: "SERVICE_UNAVAILABLE",
  AiUnavailable: "SERVICE_UNAVAILABLE",
  ApiServicesUnavailable: "SERVICE_UNAVAILABLE",
  DbQueryFailed: "SERVICE_UNAVAILABLE",
  SyncLimiterUnavailable: "SERVICE_UNAVAILABLE",
  SyncQueueFailed: "SERVICE_UNAVAILABLE",
  AiModelNotFound: "INTERNAL_SERVER_ERROR",
  AiOutputInvalid: "INTERNAL_SERVER_ERROR",
  DbRowInvalid: "INTERNAL_SERVER_ERROR",
  EmbeddingModelMismatch: "INTERNAL_SERVER_ERROR",
} satisfies Record<ApiFailure["_tag"], WireCode>;

const toWire = (traceId: string) => (error: ApiFailure) => {
  const code = wireCodes[error._tag];
  const failure = Effect.fail(wireError(code, traceId));
  return errorStatus[code] < 500
    ? failure
    : Effect.logError("API call failed", { error: error._tag, detail: error.message, traceId }).pipe(
        Effect.andThen(failure),
      );
};

const handle = <I, O>(run: (input: I) => Effect.Effect<O, ApiFailure, ApiServices>) =>
  function* ({ input, context }: { readonly input: I; readonly context: { readonly traceId: string } }) {
    return yield* run(input).pipe(Effect.catch(toWire(context.traceId)));
  };

const provideServices = middlewareGen<ApiContext & { readonly traceId: string }, WithEffectContext<ApiServices>>(
  function* ({ context, next }) {
    const services = yield* context.services.pipe(Effect.catch(toWire(context.traceId)));
    // @effect-diagnostics-next-line anyUnknownInErrorContext:off - oRPC types every downstream failure as unknown.
    return yield* next({ context: { "effect/context": Context.merge(context["effect/context"], services) } });
  },
);

const iso = (time: DateTime.Utc | null) => (time === null ? null : DateTime.formatIso(time));

const repoFields = (repo: Db.Repo) => ({
  id: repo.id,
  owner: repo.owner,
  name: repo.name,
  url: `https://github.com/${repo.owner}/${repo.name}`,
  description: repo.description,
  summary: repo.summary,
  language: repo.language,
  topics: repo.topics,
  license: repo.license,
  kind: repo.kind,
  archived: repo.archived,
  pushedAt: iso(repo.pushedAt),
});

const syncStatus = (login: Login, status: SyncRequests.SyncStatus) => ({
  login,
  state: status.state,
  requestedAt: status.state === "queued" || status.state === "failed" ? iso(status.requestedAt) : null,
  syncedAt: status.state === "unknown" ? null : iso(status.syncedAt),
});

const implementer = implement(contract).$context<ApiContext>();
// Procedure-level middleware runs after input validation, so a bad request never builds the services.
const os = implementer.use(instrumentation);

export const router = implementer.router({
  search: os.search.use(provideServices).effect(
    handle((input: typeof SearchInput.Type) =>
      Effect.gen(function* () {
        const scope: Search.Scope =
          input.scope === "global" ? { _tag: "global" } : { _tag: input.scope, login: input.login };
        const outcome = yield* (yield* Search.Search).search({ scope, query: input.q, limit: input.limit });
        return {
          planSource: outcome.planSource,
          results: outcome.results.map((result) => ({
            ...repoFields(result.repo),
            reason: Search.reasonLine(result),
            metrics: result.metrics,
          })),
        };
      }),
    ),
  ),

  triggerSync: os.triggerSync.use(provideServices).effect(
    handle((input: typeof SyncInput.Type) =>
      Effect.gen(function* () {
        yield* (yield* SyncLimiter).acquire;
        return syncStatus(input.login, yield* (yield* SyncRequests.SyncRequests).request(input.login));
      }),
    ),
  ),

  syncStatus: os.syncStatus
    .use(provideServices)
    .effect(
      handle((input: typeof SyncInput.Type) =>
        SyncRequests.SyncRequests.use((requests) => requests.status(input.login)).pipe(
          Effect.map((status) => syncStatus(input.login, status)),
        ),
      ),
    ),

  getRepo: os.getRepo.use(provideServices).effect(
    handle((input: typeof RepoInput.Type) =>
      Db.Db.use((db) => db.repos.require(input.id)).pipe(
        Effect.map((repo) => ({
          ...repoFields(repo),
          keywords: repo.keywords,
          homepage: repo.homepage,
          createdAt: iso(repo.createdAt),
        })),
      ),
    ),
  ),
});
