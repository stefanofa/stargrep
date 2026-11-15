import * as Cloudflare from "@alchemy.run/cloudflare";
import { apiKeyName } from "@stargrep/ai/gateway";
import { demoLoginName } from "@stargrep/api/public-config";
import { bindings, githubSignIn, names } from "@stargrep/auth/config";
import { aiGatewayKey, aiProviderName } from "@stargrep/runtime/ai-key";
import { budgetShareName, serverTokenName, serverTokenPolicy } from "@stargrep/runtime/server-token";
import { webResourceId } from "@stargrep/runtime/stage";
import MainWorker from "@stargrep/worker";
import { betterAuthSecret } from "@stargrep/worker/auth";
import { Database, DatabaseMigrations } from "@stargrep/worker/database";
import { stageHosting } from "@stargrep/worker/domain";
import { Icons } from "@stargrep/worker/icons";
import { SyncStars } from "@stargrep/worker/queues";
import { previewHostBinding, settings } from "@stargrep/worker/stage";
import * as Alchemy from "alchemy";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Record from "effect/Record";

import { rateLimitPolicy } from "./rate-limit-policy.ts";

const SearchCache = Cloudflare.KV.Namespace("SearchCache");

const CallerKey = Alchemy.makeRandom("CallerKey");

const signInBindings = Effect.gen(function* () {
  const { stage, production } = yield* settings;
  const configured = yield* githubSignIn;
  const signIn = production
    ? Option.filter(configured, (config) => config._tag === "direct" && Option.isSome(config.proxySecret))
    : configured;
  if (Option.isNone(signIn)) {
    if (production) {
      return yield* Effect.die(
        `prod signs in directly and forwards previews' sign-ins, so it needs ${names.clientId}, ${names.proxySecret}, and no ${names.proxyOrigin}`,
      );
    }
    return {};
  }
  return { ...previewHostBinding, ...bindings(signIn.value), [names.secret]: yield* betterAuthSecret(stage) };
});

// Cloudflare counts a rate limit per namespace ID across the whole account, so each stage gets its own IDs.
const namespaceId = (stage: string, name: string) => {
  let hash = 2166136261;
  for (const char of `stargrep/${stage}/${name}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return (hash % 2147483646) + 1;
};

export class Website extends Cloudflare.Website.Vite<Website>()(
  webResourceId,
  Effect.gen(function* () {
    const { stage, placement } = yield* settings;
    const { kind, share } = yield* serverTokenPolicy(stage);
    const key = yield* aiGatewayKey;
    const aiProvider = yield* Config.option(Config.String(aiProviderName));
    const demoLogin = yield* Config.option(Config.String(demoLoginName));
    return {
      rootDir: new URL(".", import.meta.url).pathname,
      memo: { include: ["**/*", "../../packages/*/src/**", "../../packages/*/package.json"], lockfile: true },
      placement,
      dev: { port: 1340 },
      observability: { enabled: true, logs: { enabled: true, invocationLogs: true }, traces: { enabled: true } },
      ...stageHosting(stage).web,
      env: {
        DATABASE: Database,
        DATABASE_MIGRATIONS: yield* DatabaseMigrations,
        SEARCH_CACHE: SearchCache,
        SYNC_STARS: SyncStars,
        WORKER: MainWorker,
        CALLER_KEY: yield* CallerKey,
        [budgetShareName]: String(share),
        [serverTokenName]: kind,
        ICONS: yield* Icons,
        ...Record.map(rateLimitPolicy, (policy, name) =>
          Cloudflare.RateLimit(name, { namespaceId: namespaceId(stage, policy.namespace), simple: policy.simple }),
        ),
        ...Option.match(key, { onNone: () => ({}), onSome: (value) => ({ [apiKeyName]: value }) }),
        ...Option.match(aiProvider, { onNone: () => ({}), onSome: (value) => ({ [aiProviderName]: value }) }),
        ...Option.match(demoLogin, { onNone: () => ({}), onSome: (value) => ({ [demoLoginName]: value }) }),
        ...(yield* signInBindings),
      },
    };
  }).pipe(Effect.orDie),
) {}

export type WebsiteEnv = Cloudflare.InferEnv<typeof Website>;
