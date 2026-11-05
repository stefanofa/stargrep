import { useState } from "react";
import { cn } from "../lib/cn.ts";

export type Plate = "none" | "light" | "dark";

export type RepoVisual = { readonly letters: string } & (
  | { readonly kind: "icon"; readonly url: string; readonly plate: Plate }
  | { readonly kind: "avatar"; readonly url: string }
  | { readonly kind: "monogram" }
);

const plates: Record<Plate, string> = {
  none: "bg-card",
  light: "bg-[#ffffff]",
  dark: "bg-ink",
};

const smallest = 64;

const slot = "flex shrink-0 items-center justify-center overflow-clip squircle rounded-sm";

const slotSize = "size-11 list:size-9";

export function Monogram({ letters }: { letters: string }) {
  return (
    <span
      aria-hidden
      skullet-block=""
      className={cn(
        slot,
        slotSize,
        "bg-avatar-2 font-display text-[17px] leading-[20px] font-semibold text-ink list:text-[15px] list:leading-[18px]",
      )}
    >
      {letters}
    </span>
  );
}

export function RepoIcon({ visual }: { visual: RepoVisual }) {
  const [failed, setFailed] = useState(false);
  const [small, setSmall] = useState<number>();
  if (visual.kind === "monogram" || failed) {
    return <Monogram letters={visual.letters} />;
  }
  const plate = visual.kind === "icon" ? visual.plate : "none";
  return (
    <span
      aria-hidden
      skullet-block=""
      data-slot="repo-icon"
      className={cn(slot, slotSize, "border-[1.5px] border-border", small === undefined ? plates[plate] : "bg-muted")}
    >
      <img
        src={visual.url}
        alt=""
        width={small ?? 44}
        height={small ?? 44}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
        onLoad={({ currentTarget }) => {
          if (currentTarget.naturalWidth < smallest) setSmall(Math.min(24, currentTarget.naturalWidth));
        }}
        className={cn("object-cover", small === undefined ? "size-full" : "shrink-0")}
        style={small === undefined ? undefined : { width: small, height: small }}
      />
    </span>
  );
}
