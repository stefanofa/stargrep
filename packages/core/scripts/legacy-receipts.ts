import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Models from "@stargrep/ai/models";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Command from "effect/cli/Command";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as LegacyReceipts from "../src/knowledge/legacy-receipts.ts";
import * as Runtime from "./runtime.ts";

const keep = Command.make(
  "legacy-receipts",
  {},
  Effect.fn("legacyReceipts")(
    function* () {
      const started = yield* Clock.currentTimeMillis;
      const { pages, read, inserted, pointed } = yield* LegacyReceipts.keepLegacySummaries();
      const elapsed = (yield* Clock.currentTimeMillis) - started;
      yield* Console.log(
        `pages ${pages}, repos read ${read}, receipts inserted ${inserted}, repos pointed ${pointed}, ${elapsed} ms`,
      );
    },
    Effect.provide(Layer.merge(Runtime.layerDb(Models.embeddingModel.id), Digest.layerWebCrypto)),
  ),
).pipe(
  Command.withDescription(
    "Give every repo summarized before receipts a legacy receipt from its summary, keywords, and kind, with no model call",
  ),
);

keep.pipe(Command.run({ version: "0.0.0" }), Effect.provide(BunServices.layer), BunRuntime.runMain);
