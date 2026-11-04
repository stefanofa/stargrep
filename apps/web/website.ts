import * as Cloudflare from "@alchemy.run/cloudflare";
import { aiGatewayKey, aiGatewayKeyName } from "@stargrep/runtime/ai";
import { Database, DatabaseMigrations } from "@stargrep/worker/database";
import { SyncStars } from "@stargrep/worker/queues";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

const SearchCache = Cloudflare.KV.Namespace("SearchCache");
const SyncRequests = Cloudflare.KV.Namespace("SyncRequests");

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
    return {
      rootDir: new URL(".", import.meta.url).pathname,
      memo: { include: ["**/*", "../../packages/*/src/**", "../../packages/*/package.json"], lockfile: true },
      placement: { region: "aws:us-east-1" },
      dev: { port: 1340 },
      observability: { enabled: true, logs: { enabled: true, invocationLogs: true }, traces: { enabled: true } },
      env: {
        DATABASE: Database,
        DATABASE_MIGRATIONS: yield* DatabaseMigrations,
        SEARCH_CACHE: SearchCache,
        SYNC_REQUESTS: SyncRequests,
        SYNC_STARS: SyncStars,
        SYNC_PER_CALLER: Cloudflare.RateLimit("SYNC_PER_CALLER", {
          namespaceId: namespaceId(stage, "sync-per-caller"),
          simple: { limit: 5, period: 60 },
        }),
        SYNC_OVERALL: Cloudflare.RateLimit("SYNC_OVERALL", {
          namespaceId: namespaceId(stage, "sync-overall"),
          simple: { limit: 60, period: 60 },
        }),
        ...Option.match(key, { onNone: () => ({}), onSome: (value) => ({ [aiGatewayKeyName]: value }) }),
      },
    };
  }).pipe(Effect.orDie),
) {}

export type WebsiteEnv = Cloudflare.InferEnv<typeof Website>;
