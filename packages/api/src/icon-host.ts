import * as Context from "effect/Context";

export const iconsPath = "/icons/";
// Topic logos live under /icons/logos/, beside the repo icons, and each name carries a hash of its bytes.
export const logoPrefix = "logos/";

export class IconHost extends Context.Service<IconHost, { readonly origin: string }>()(
  "@stargrep/api/icon-host/IconHost",
) {}

export const iconUrl = (host: IconHost["Service"], key: string) => `${host.origin}${iconsPath}${key}`;
