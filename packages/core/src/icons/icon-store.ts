import { RepoIcon } from "@stargrep/db";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export class IconStoreFailed extends Schema.TaggedError<IconStoreFailed, { readonly brand: unique symbol }>()(
  "IconStoreFailed",
  {
    operation: Schema.Literals(["head", "put"]),
    key: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Icon store '${this.operation}' failed for '${this.key}'`;
  }
}

export const cacheControl = "public, max-age=31536000, immutable";

export const Stored = Schema.Struct({ plate: RepoIcon.fields.plate, size: RepoIcon.fields.size });
export type Stored = typeof Stored.Type;

// R2 custom metadata holds only strings.
const Metadata = Schema.Struct({
  plate: RepoIcon.fields.plate,
  size: Schema.NumberFromString.pipe(Schema.decodeTo(RepoIcon.fields.size)),
});
export const decodeMetadata = Schema.decodeUnknownOption(Metadata);
export const encodeMetadata = Schema.encodeSync(Metadata);

export class IconStore extends Context.Service<
  IconStore,
  {
    readonly head: (key: string) => Effect.Effect<Option.Option<Stored>, IconStoreFailed>;
    readonly put: (key: string, webp: Uint8Array, stored: Stored) => Effect.Effect<void, IconStoreFailed>;
  }
>()("@stargrep/core/icons/icon-store/IconStore") {}

export const layerMemory = () => {
  const objects = new Map<string, { readonly webp: Uint8Array; readonly stored: Stored }>();
  const layer = Layer.succeed(
    IconStore,
    IconStore.of({
      head: Effect.fn("IconStore.head")((key: string) =>
        Effect.sync(() => Option.map(Option.fromUndefinedOr(objects.get(key)), (object) => object.stored)),
      ),
      put: Effect.fn("IconStore.put")((key: string, webp: Uint8Array, stored: Stored) =>
        Effect.sync(() => void objects.set(key, { webp, stored })),
      ),
    }),
  );
  return { objects, layer };
};
