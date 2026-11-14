import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";

// The object ID git gives a blob, the SHA-1 of a header that names its size followed by its bytes.
export const blobOid = Effect.fnUntraced(function* (bytes: Uint8Array) {
  const digest = yield* Digest.Digest;
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const blob = new Uint8Array(header.byteLength + bytes.byteLength);
  blob.set(header);
  blob.set(bytes, header.byteLength);
  return yield* digest.digestHex(Digest.sha1, blob);
});
