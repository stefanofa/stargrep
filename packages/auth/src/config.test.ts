import { describe, expect } from "bun:test";
import * as it from "@stargrep/testing";
import type * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { authConfig, bindings, names } from "./config.ts";

const read = <A>(config: Config.Config<A>, env: Record<string, string>) =>
  config.parse(ConfigProvider.fromUnknown(env));

const clientSecret = "client-secret-canary";

const unwrap = (value: unknown): unknown => {
  if (Redacted.isRedacted(value)) return Redacted.value(value);
  if (Option.isOption(value)) return Option.match(value, { onNone: () => null, onSome: unwrap });
  if (Array.isArray(value)) return value.map(unwrap);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, unwrap(inner)]));
  }
  return value;
};

const reveal = (value: unknown) => JSON.stringify(unwrap(value));

describe("auth config", () => {
  it.effect("reads nothing when the stage has no GitHub App", () =>
    Effect.gen(function* () {
      expect(yield* read(authConfig, { [names.secret]: "s" })).toEqual(Option.none());
      expect(yield* read(authConfig, { [names.clientId]: "", [names.secret]: "s" })).toEqual(Option.none());
    }),
  );

  it.effect("signs in directly with the client secret when no proxy origin is set", () =>
    Effect.gen(function* () {
      const config = Option.getOrThrow(
        yield* read(authConfig, {
          [names.clientId]: "Iv1.app",
          [names.clientSecret]: clientSecret,
          [names.proxySecret]: "proxy",
          [names.secret]: "auth",
        }),
      );
      expect(config.github._tag).toBe("direct");
      expect(reveal(bindings(config))).toContain(clientSecret);
      expect(Object.keys(bindings(config)).toSorted()).toEqual(
        [names.clientId, names.clientSecret, names.proxySecret, names.secret].toSorted(),
      );
    }),
  );

  it.effect("never holds the client secret once a proxy origin is set", () =>
    Effect.gen(function* () {
      const config = Option.getOrThrow(
        yield* read(authConfig, {
          [names.clientId]: "Iv1.app",
          [names.clientSecret]: clientSecret,
          [names.proxyOrigin]: "https://stargrep.com",
          [names.proxySecret]: "proxy",
          [names.secret]: "auth",
        }),
      );
      expect(config.github).toMatchObject({ _tag: "proxied", productionOrigin: "https://stargrep.com" });
      expect(reveal(config)).not.toContain(clientSecret);
      expect(reveal(bindings(config))).not.toContain(clientSecret);
      expect(Object.keys(bindings(config))).not.toContain(names.clientSecret);
    }),
  );

  it.effect("fails instead of guessing when a mode lacks its secret", () =>
    Effect.gen(function* () {
      const proxiedWithoutSecret = { [names.clientId]: "Iv1.app", [names.proxyOrigin]: "https://stargrep.com" };
      const directWithoutSecret = { [names.clientId]: "Iv1.app", [names.secret]: "auth" };
      expect((yield* Effect.flip(read(authConfig, proxiedWithoutSecret)))._tag).toBe("ConfigError");
      expect((yield* Effect.flip(read(authConfig, directWithoutSecret)))._tag).toBe("ConfigError");
    }),
  );

  it.effect("reads back the bindings it writes", () =>
    Effect.gen(function* () {
      for (const env of [
        { [names.clientId]: "Iv1.app", [names.clientSecret]: clientSecret, [names.secret]: "auth" },
        {
          [names.clientId]: "Iv1.app",
          [names.proxyOrigin]: "https://stargrep.com",
          [names.proxySecret]: "proxy",
          [names.secret]: "auth",
        },
      ]) {
        const config = Option.getOrThrow(yield* read(authConfig, env));
        const written = Object.fromEntries(
          Object.entries(bindings(config)).map(([name, value]) => [
            name,
            Redacted.isRedacted(value) ? Redacted.value(value) : value,
          ]),
        );
        expect(written).toEqual(env);
      }
    }),
  );
});
