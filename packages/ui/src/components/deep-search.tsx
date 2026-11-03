import { Switch } from "@base-ui/react/switch";
import { useId } from "react";
import { cn } from "../lib/cn.ts";

export function DeepSearch({
  checked,
  onCheckedChange,
  className,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  className?: string;
}) {
  const id = useId();
  return (
    <div
      className={cn(
        "flex items-center gap-[10px] list:h-[42px] list:rounded-full list:bg-card list:pr-4 list:pl-[9px]",
        className,
      )}
    >
      <Switch.Root
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        className="flex h-[26px] w-11 shrink-0 items-center rounded-full bg-border p-[3px] transition-[color,background-color] duration-120 data-checked:bg-accent"
      >
        <Switch.Thumb className="size-5 rounded-full bg-[light-dark(var(--color-card),var(--color-muted-foreground))] shadow-[0_1px_2px_#1e1b2e33] transition-transform duration-120 data-checked:translate-x-[18px] motion-reduce:transition-none" />
      </Switch.Root>
      <label htmlFor={id} className="font-sans text-meta font-medium text-foreground">
        Deep search
      </label>
    </div>
  );
}
