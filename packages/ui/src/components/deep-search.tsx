import { Switch } from "@base-ui/react/switch";
import { useId } from "react";
import { cn } from "../lib/cn.ts";
import { switchThumb, switchTrack } from "./switch.tsx";

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
      <Switch.Root id={id} checked={checked} onCheckedChange={onCheckedChange} className={switchTrack}>
        <Switch.Thumb className={switchThumb} />
      </Switch.Root>
      <label htmlFor={id} className="font-sans text-meta font-medium text-foreground">
        Deep search
      </label>
    </div>
  );
}
