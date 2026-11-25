import { ChevronIcon, SortIcon } from "./icons.tsx";
import { RadioMenu } from "./radio-menu.tsx";

export const sorts = [
  { value: "best", label: "best match" },
  { value: "starred", label: "recently starred" },
  { value: "stars", label: "most stars" },
  { value: "pushed", label: "recently pushed" },
] as const;

export type Sort = (typeof sorts)[number]["value"];

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
    <RadioMenu
      label={`Sort by ${current?.label ?? ""}`}
      trigger={
        <button
          type="button"
          className="flex h-[30px] w-[34px] shrink-0 items-center justify-center gap-1.5 rounded-full bg-muted font-sans text-meta font-medium text-foreground transition-[color,background-color] duration-120 select-none hover:bg-border data-popup-open:bg-border sm:h-[34px] sm:w-auto sm:pr-3 sm:pl-3.5"
        />
      }
      choices={sorts.filter((sort) => options.includes(sort.value))}
      value={value}
      onValueChange={onValueChange}
    >
      <SortIcon className="size-4 sm:hidden" />
      <span className="max-sm:sr-only">{current?.label}</span>
      <ChevronIcon className="size-3.5 text-secondary-foreground max-sm:hidden" />
    </RadioMenu>
  );
}
