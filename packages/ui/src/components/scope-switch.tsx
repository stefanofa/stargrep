import { Tabs } from "@base-ui/react/tabs";
import { cn } from "../lib/cn.ts";

export type Scope = {
  readonly value: string;
  readonly label: string;
  readonly href: string;
};

export function ScopeSwitch({
  scopes,
  value,
  onValueChange,
  className,
}: {
  scopes: ReadonlyArray<Scope>;
  value: string;
  onValueChange?: (value: string) => void;
  className?: string;
}) {
  return (
    <Tabs.Root value={value} onValueChange={(next) => onValueChange?.(String(next))}>
      <Tabs.List
        aria-label="Scope"
        activateOnFocus={false}
        className={cn("flex w-fit items-center gap-1 rounded-full bg-card p-1", className)}
      >
        {scopes.map((scope) => (
          <Tabs.Tab
            key={scope.value}
            value={scope.value}
            nativeButton={false}
            render={<a href={scope.href} />}
            className="flex h-9 items-center rounded-full px-[18px] font-sans text-[14px] leading-sm font-medium text-muted-foreground transition-[color,background-color] duration-120 hover:text-foreground data-active:bg-accent data-active:font-semibold data-active:text-ink"
          >
            {scope.label}
          </Tabs.Tab>
        ))}
      </Tabs.List>
    </Tabs.Root>
  );
}
