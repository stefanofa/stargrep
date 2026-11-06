import { useState } from "react";
import { cn } from "../lib/cn.ts";

export type Plate = "none" | "light" | "dark";

export type RepoVisual = { readonly letters: string } & (
  | { readonly kind: "icon"; readonly url: string; readonly plate: Plate; readonly size: number }
  | { readonly kind: "avatar"; readonly url: string }
  | { readonly kind: "monogram" }
);

const plates: Record<Plate, string> = {
  none: "bg-card",
  // A logo drawn for light pages needs pure white behind it in both themes, so this plate skips --color-plate.
  light: "bg-[#ffffff]",
  dark: "bg-ink",
};

const nativeSizeBelow = 64;

const smallSide = 24;

const shownSide = (visual: RepoVisual) =>
  visual.kind === "icon" && visual.size < nativeSizeBelow ? Math.min(visual.size, smallSide) : undefined;

const slot = "flex shrink-0 items-center justify-center overflow-clip squircle rounded-sm";

export type RepoIconSize = "card" | "panel";

const sizes: Record<RepoIconSize, { slot: string; letters: string; side: number }> = {
  card: {
    slot: "size-11 list:size-9",
    letters: "text-[17px] leading-[20px] list:text-[15px] list:leading-[18px]",
    side: 44,
  },
  panel: { slot: "size-14", letters: "text-[22px] leading-[26px]", side: 56 },
};

export function Monogram({ letters, size = "card" }: { letters: string; size?: RepoIconSize }) {
  return (
    <span
      aria-hidden
      data-slot="repo-icon"
      className={cn(slot, sizes[size].slot, sizes[size].letters, "bg-avatar-2 font-display font-semibold text-ink")}
    >
      {letters}
    </span>
  );
}

export function RepoIcon({ visual, size = "card" }: { visual: RepoVisual; size?: RepoIconSize }) {
  const [failedUrl, setFailedUrl] = useState<string>();
  if (visual.kind === "monogram" || failedUrl === visual.url) {
    return <Monogram letters={visual.letters} size={size} />;
  }
  const plate = visual.kind === "icon" ? visual.plate : "none";
  const small = shownSide(visual);
  return (
    <span
      aria-hidden
      data-slot="repo-icon"
      className={cn(
        slot,
        sizes[size].slot,
        "outline-1 -outline-offset-1 outline-image-edge",
        small === undefined ? plates[plate] : "bg-muted",
      )}
    >
      <img
        src={visual.url}
        alt=""
        width={small ?? sizes[size].side}
        height={small ?? sizes[size].side}
        loading="lazy"
        decoding="async"
        onError={() => setFailedUrl(visual.url)}
        className={cn("object-cover", small === undefined ? "size-full" : "shrink-0")}
        style={small === undefined ? undefined : { width: small, height: small }}
      />
    </span>
  );
}
