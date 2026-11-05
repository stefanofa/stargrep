import * as Context from "effect/Context";

export const iconsPath = "/icons/";

export class IconHost extends Context.Service<IconHost, { readonly origin: string }>()(
  "@stargrep/api/icon-host/IconHost",
) {}

export const iconUrl = (host: IconHost["Service"], key: string) => `${host.origin}${iconsPath}${key}`;
