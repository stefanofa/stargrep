import { Menu } from "@base-ui/react/menu";
import { cn } from "../lib/cn.ts";
import { CheckIcon, ChevronIcon, SortIcon } from "./icons.tsx";
import { popupSurface } from "./popup.ts";

export const sorts = [
  { value: "best", label: "best match" },
  { value: "starred", label: "recently starred" },
  { value: "stars", label: "most stars" },
  { value: "pushed", label: "recently pushed" },
] as const;

export type Sort = (typeof sorts)[number]["value"];

const isSort = (value: unknown): value is Sort => sorts.some((sort) => sort.value === value);

export function SortMenu({
  value,
  onValueChange,
  options = sorts.filter((sort) => sort.value !== "best").map((sort) => sort.value),
}: {
  value: Sort;
  onValueChange: (sort: Sort) => void;
  options?: ReadonlyArray<Sort>;
}) {
  const current = sorts.find((sort) => sort.value === value);
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label={`Sort by ${current?.label ?? ""}`}
        className="flex h-10 shrink-0 items-center gap-2 rounded-full bg-muted px-3 font-sans text-meta font-medium text-foreground transition-[color,background-color] duration-120 select-none hover:bg-border sm:w-[184px] sm:pr-3.5 sm:pl-4"
      >
        <SortIcon className="size-4 text-secondary-foreground" />
        <span className="flex-1 text-left max-sm:sr-only">{current?.label}</span>
        <ChevronIcon className="size-3.5 text-secondary-foreground max-sm:hidden" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={6} align="end" className="z-50 outline-none">
          <Menu.Popup className={cn(popupSurface, "min-w-52")}>
            <Menu.RadioGroup
              value={value}
              onValueChange={(next) => {
                if (isSort(next)) onValueChange(next);
              }}
            >
              {sorts
                .filter((sort) => options.includes(sort.value))
                .map((sort) => (
                  <Menu.RadioItem
                    key={sort.value}
                    value={sort.value}
                    closeOnClick
                    className="flex h-9 cursor-default items-center justify-between gap-3 rounded-item px-3 select-none data-highlighted:bg-accent-soft"
                  >
                    {sort.label}
                    <Menu.RadioItemIndicator>
                      <CheckIcon className="size-3.5 text-accent-strong" />
                    </Menu.RadioItemIndicator>
                  </Menu.RadioItem>
                ))}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
