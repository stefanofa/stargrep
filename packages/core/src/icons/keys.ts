// Icons are served as immutable, so a change to the normalized output must also change every key. A stored key is
// also reused without normalizing again, so a change to what the normalizer rejects must change every key too.
// Bump this when either changes.
export const outputVersion = "v2";

export const gitKey = (oid: string) => `${outputVersion}/git/${oid}.webp`;
export const contentKey = (sha256: string) => `${outputVersion}/sha256/${sha256}.webp`;

// Rows keep an older version's key until their next check, so every version stays servable.
const keyPattern = /^v\d+\/(?:git\/[0-9a-f]{40}(?:[0-9a-f]{24})?|sha256\/[0-9a-f]{64})\.webp$/;

export const isIconKey = (key: string) => keyPattern.test(key);
