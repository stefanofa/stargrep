import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { useState } from "react";
import { cn } from "../lib/cn.ts";
import { ListIcon, TilesIcon } from "./icons.tsx";

export type View = "tiles" | "list";

export const isView = (value: unknown): value is View => value === "tiles" || value === "list";

const views = [
  { value: "tiles", label: "Tiles view", Icon: TilesIcon },
  { value: "list", label: "List view", Icon: ListIcon },
] as const;

export function ViewToggle({
  value,
  defaultValue = "tiles",
  onValueChange,
  className,
}: {
  value?: View | undefined;
  defaultValue?: View;
  onValueChange?: (view: View) => void;
  className?: string;
}) {
  const [own, setOwn] = useState(defaultValue);
  const current = value ?? own;
  return (
    <ToggleGroup
      aria-label="View"
      value={[current]}
      onValueChange={(next) => {
        const [picked] = next;
        if (!isView(picked)) return;
        setOwn(picked);
        onValueChange?.(picked);
      }}
      className={cn("flex w-fit items-center gap-0.5 rounded-full bg-muted p-[3px] sm:p-1", className)}
    >
      {views.map(({ value: option, label, Icon }) => (
        <Toggle
          key={option}
          value={option}
          aria-label={label}
          className="relative flex h-[30px] w-10 items-center justify-center rounded-full text-muted-foreground transition-[color,background-color,scale] duration-120 motion-safe:active:scale-[0.96] after:absolute after:inset-x-0 after:-inset-y-[5px] hover:text-foreground data-pressed:bg-accent data-pressed:text-ink sm:h-8"
        >
          <Icon className="size-4" />
        </Toggle>
      ))}
    </ToggleGroup>
  );
}
