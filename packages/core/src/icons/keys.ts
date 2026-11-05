// Icons are served as immutable, so a change to the normalized output must also change every key. Bump this when it does.
export const outputVersion = "v1";

export const gitKey = (oid: string) => `${outputVersion}/git/${oid}.webp`;
export const contentKey = (sha256: string) => `${outputVersion}/sha256/${sha256}.webp`;

const keyPattern = new RegExp(`^${outputVersion}/(?:git/[0-9a-f]{40}(?:[0-9a-f]{24})?|sha256/[0-9a-f]{64})\\.webp$`);

export const isIconKey = (key: string) => keyPattern.test(key);
