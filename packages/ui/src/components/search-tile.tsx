import { Input } from "@base-ui/react/input";
import { type FormEvent, type KeyboardEvent, useEffect, useRef } from "react";
import { cn } from "../lib/cn.ts";
import { Badge } from "./badge.tsx";
import { Button } from "./button.tsx";
import { CloseIcon, SearchIcon } from "./icons.tsx";
import { Tile } from "./tile.tsx";

export type Filter = {
  readonly id: string;
  readonly label: string;
};

export function FilterChip({ filter, onRemove }: { filter: Filter; onRemove: (filter: Filter) => void }) {
  return (
    <Badge variant="chip">
      {filter.label}
      <Button
        variant="secondary"
        size="xs"
        className="bg-transparent text-accent-strong hover:bg-accent/25"
        aria-label={`Remove ${filter.label}`}
        onClick={() => onRemove(filter)}
      >
        <CloseIcon />
      </Button>
    </Badge>
  );
}

const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT");

export function SearchTile({
  query,
  onQueryChange,
  onSubmit,
  filters = [],
  onRemoveFilter,
  label = "Search your stars",
  className,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  onSubmit?: (query: string) => void;
  filters?: ReadonlyArray<Filter>;
  onRemoveFilter?: (filter: Filter) => void;
  label?: string;
  className?: string;
}) {
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const focusOnSlash = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey || typing(event.target)) return;
      event.preventDefault();
      input.current?.focus();
    };
    window.addEventListener("keydown", focusOnSlash);
    return () => window.removeEventListener("keydown", focusOnSlash);
  }, []);

  const removeLastOnBackspace = (event: KeyboardEvent<HTMLInputElement>) => {
    const last = filters.at(-1);
    if (event.key === "Backspace" && query === "" && last && onRemoveFilter) {
      event.preventDefault();
      onRemoveFilter(last);
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit?.(query);
  };

  return (
    <Tile className={cn("flex flex-col gap-[18px] pt-[26px] pb-6", className)}>
      <search>
        <form onSubmit={submit} className="flex items-center gap-4">
          <SearchIcon className="size-[26px] shrink-0" />
          <Input
            ref={input}
            type="search"
            aria-label={label}
            value={query}
            onValueChange={onQueryChange}
            onKeyDown={removeLastOnBackspace}
            className="min-w-0 flex-1 bg-transparent font-sans text-xl font-medium tracking-snug text-foreground placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:appearance-none"
          />
        </form>
      </search>
      {filters.length > 0 && (
        <ul aria-label="Filters" className="flex flex-wrap gap-2 pl-[42px]">
          {filters.map((filter) => (
            <li key={filter.id}>
              <FilterChip filter={filter} onRemove={(removed) => onRemoveFilter?.(removed)} />
            </li>
          ))}
        </ul>
      )}
    </Tile>
  );
}
