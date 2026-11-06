import * as Cloudflare from "@alchemy.run/cloudflare";
import { apiKeyName } from "@stargrep/ai/gateway";
import { demoLoginName } from "@stargrep/api/public-config";
import { bindings, githubSignIn, names, optionalSecret, required } from "@stargrep/auth/config";
import { aiGatewayKey } from "@stargrep/runtime/config";
import MainWorker from "@stargrep/worker";
import { Database, DatabaseMigrations } from "@stargrep/worker/database";
import { prodWebHosting } from "@stargrep/worker/domain";
import { Icons } from "@stargrep/worker/icons";
import { SyncStars } from "@stargrep/worker/queues";
import * as Alchemy from "alchemy";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

const SearchCache = Cloudflare.KV.Namespace("SearchCache");

const BetterAuthSecret = Alchemy.makeRandom("BetterAuthSecret");

const CallerKey = Alchemy.makeRandom("CallerKey");

const signInBindings = Effect.gen(function* () {
  const { stage } = yield* Alchemy.Stack;
  const signIn = yield* githubSignIn;
  if (stage === "prod") {
    const github = Option.filter(signIn, (config) => config._tag === "direct" && Option.isSome(config.proxySecret));
    if (Option.isNone(github)) {
      return yield* Effect.die(
        `prod signs in directly and forwards previews' sign-ins, so it needs ${names.clientId}, ${names.proxySecret}, and no ${names.proxyOrigin}`,
      );
    }
    return { ...bindings(github.value), [names.secret]: yield* required(names.secret) };
  }
  if (Option.isNone(signIn)) return {};
  const secret = yield* optionalSecret(names.secret);
  return {
    ...bindings(signIn.value),
    [names.secret]: Option.isSome(secret) ? secret.value : yield* BetterAuthSecret,
  };
});

// Cloudflare counts a rate limit per namespace ID across the whole account, so each stage gets its own IDs.
const namespaceId = (stage: string, name: string) => {
  let hash = 2166136261;
  for (const char of `stargrep/${stage}/${name}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return (hash % 2147483646) + 1;
};

export class Website extends Cloudflare.Website.Vite<Website>()(
  "Web",
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;
    const key = yield* aiGatewayKey;
    const demoLogin = yield* Config.option(Config.String(demoLoginName));
    return {
      rootDir: new URL(".", import.meta.url).pathname,
      memo: { include: ["**/*", "../../packages/*/src/**", "../../packages/*/package.json"], lockfile: true },
      placement: { region: "aws:us-east-1" },
      dev: { port: 1340 },
      observability: { enabled: true, logs: { enabled: true, invocationLogs: true }, traces: { enabled: true } },
      ...(stage === "prod" ? prodWebHosting : {}),
      env: {
        DATABASE: Database,
        DATABASE_MIGRATIONS: yield* DatabaseMigrations,
        SEARCH_CACHE: SearchCache,
        SYNC_STARS: SyncStars,
        WORKER: MainWorker,
        CALLER_KEY: yield* CallerKey,
        ICONS: yield* Icons,
        SYNC_PER_CALLER: Cloudflare.RateLimit("SYNC_PER_CALLER", {
          namespaceId: namespaceId(stage, "sync-per-caller"),
          simple: { limit: 5, period: 60 },
        }),
        SYNC_OVERALL: Cloudflare.RateLimit("SYNC_OVERALL", {
          namespaceId: namespaceId(stage, "sync-overall"),
          simple: { limit: 60, period: 60 },
        }),
        SEARCH_PER_CALLER: Cloudflare.RateLimit("SEARCH_PER_CALLER", {
          namespaceId: namespaceId(stage, "search-per-caller"),
          simple: { limit: 120, period: 60 },
        }),
        STARS_PER_CALLER: Cloudflare.RateLimit("STARS_PER_CALLER", {
          namespaceId: namespaceId(stage, "stars-per-caller"),
          simple: { limit: 60, period: 60 },
        }),
        PLANNER_PER_CALLER: Cloudflare.RateLimit("PLANNER_PER_CALLER", {
          namespaceId: namespaceId(stage, "planner-per-caller"),
          simple: { limit: 20, period: 60 },
        }),
        PLANNER_OVERALL: Cloudflare.RateLimit("PLANNER_OVERALL", {
          namespaceId: namespaceId(stage, "planner-overall"),
          simple: { limit: 300, period: 60 },
        }),
        ...Option.match(key, { onNone: () => ({}), onSome: (value) => ({ [apiKeyName]: value }) }),
        ...Option.match(demoLogin, { onNone: () => ({}), onSome: (value) => ({ [demoLoginName]: value }) }),
        ...(yield* signInBindings),
      },
    };
  }).pipe(Effect.orDie),
) {}

export type WebsiteEnv = Cloudflare.InferEnv<typeof Website>;
