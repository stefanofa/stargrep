import { Menu } from "@base-ui/react/menu";
import { buttonVariants } from "./button.tsx";
import { CheckIcon, ChevronIcon } from "./icons.tsx";

export const sorts = [
  { value: "starred", label: "Recently starred" },
  { value: "stars", label: "Most stars" },
  { value: "pushed", label: "Recently pushed" },
] as const;

export type Sort = (typeof sorts)[number]["value"];

const isSort = (value: unknown): value is Sort => sorts.some((sort) => sort.value === value);

export function SortMenu({ value, onValueChange }: { value: Sort; onValueChange: (sort: Sort) => void }) {
  const current = sorts.find((sort) => sort.value === value);
  return (
    <Menu.Root>
      <Menu.Trigger className={buttonVariants({ variant: "ghost" })}>
        <span className="sr-only">Sort by</span>
        {current?.label}
        <ChevronIcon />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={6} align="end" className="z-50 outline-none">
          <Menu.Popup className="min-w-52 rounded-md border-[1.5px] border-border bg-card p-1.5 font-sans text-meta font-medium text-foreground transition-opacity duration-120 outline-none data-ending-style:opacity-0 data-starting-style:opacity-0">
            <Menu.RadioGroup
              value={value}
              onValueChange={(next) => {
                if (isSort(next)) onValueChange(next);
              }}
            >
              {sorts.map((sort) => (
                <Menu.RadioItem
                  key={sort.value}
                  value={sort.value}
                  closeOnClick
                  className="flex h-9 cursor-default items-center justify-between gap-3 rounded-sm px-3 select-none data-highlighted:bg-accent-soft"
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
