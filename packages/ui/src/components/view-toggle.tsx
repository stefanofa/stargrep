import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { useCallback, useState } from "react";
import { cn } from "../lib/cn.ts";
import { ListIcon, TilesIcon } from "./icons.tsx";

export type View = "tiles" | "list";

const storageKey = "stargrep:view";

const isView = (value: unknown): value is View => value === "tiles" || value === "list";

const readStoredView = (): View | undefined => {
  try {
    const stored = localStorage.getItem(storageKey);
    return isView(stored) ? stored : undefined;
  } catch {
    return undefined;
  }
};

export function useStoredView(fallback: View = "tiles") {
  const [view, setView] = useState<View>(() => readStoredView() ?? fallback);
  const update = useCallback((next: View) => {
    setView(next);
    try {
      localStorage.setItem(storageKey, next);
    } catch {}
  }, []);
  return [view, update] as const;
}

const views = [
  { value: "tiles", label: "Tiles view", Icon: TilesIcon },
  { value: "list", label: "List view", Icon: ListIcon },
] as const;

export function ViewToggle({
  value,
  onValueChange,
  className,
}: {
  value: View;
  onValueChange: (view: View) => void;
  className?: string;
}) {
  return (
    <ToggleGroup
      aria-label="View"
      value={[value]}
      onValueChange={(next) => {
        const [picked] = next;
        if (isView(picked)) onValueChange(picked);
      }}
      className={cn(
        "flex w-fit items-center gap-0.5 rounded-full border-[1.5px] border-border bg-card p-[3px] list:h-[42px] list:border-0 list:px-1.5",
        className,
      )}
    >
      {views.map(({ value: option, label, Icon }) => (
        <Toggle
          key={option}
          value={option}
          aria-label={label}
          className="flex h-[30px] w-10 items-center justify-center rounded-full text-muted-foreground transition-colors duration-120 hover:text-foreground data-pressed:bg-accent data-pressed:text-ink"
        >
          <Icon className="size-4" />
        </Toggle>
      ))}
    </ToggleGroup>
  );
}
