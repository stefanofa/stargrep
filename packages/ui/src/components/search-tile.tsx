import { Input } from "@base-ui/react/input";
import { type FormEvent, type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
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
      <Button variant="bare" size="xs" aria-label={`Remove ${filter.label}`} onClick={() => onRemove(filter)}>
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

function Rail({ progress, className }: { progress: number; className?: string }) {
  return (
    <div aria-hidden data-slot="rail" className={cn("h-[3px] overflow-hidden bg-accent-soft", className)}>
      <div
        className="h-full bg-accent transition-[width] duration-500 ease-out"
        style={{ width: `${Math.round(Math.min(1, Math.max(0, progress)) * 1000) / 10}%` }}
      />
    </div>
  );
}

export function SearchTile({
  query,
  defaultQuery = "",
  onQueryChange,
  onSubmit,
  filters = [],
  onRemoveFilter,
  label = "Search your stars",
  placeholder,
  status,
  controls,
  progress,
  className,
}: {
  query?: string | undefined;
  defaultQuery?: string;
  onQueryChange?: (query: string) => void;
  onSubmit?: (query: string) => void;
  filters?: ReadonlyArray<Filter>;
  onRemoveFilter?: (filter: Filter) => void;
  label?: string;
  placeholder?: string | undefined;
  status?: ReactNode;
  controls?: ReactNode;
  progress?: number | undefined;
  className?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [own, setOwn] = useState(defaultQuery);
  const current = query ?? own;
  const change = (next: string) => {
    setOwn(next);
    onQueryChange?.(next);
  };

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
    if (event.key === "Backspace" && current === "" && last && onRemoveFilter) {
      event.preventDefault();
      onRemoveFilter(last);
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit?.(current);
  };

  const strip = status !== undefined || controls !== undefined;

  return (
    <div className={cn("relative", className)}>
      {progress !== undefined && (
        <Rail progress={progress} className="absolute inset-x-0 -top-2.5 rounded-full sm:hidden" />
      )}
      <Tile className="flex flex-col overflow-clip p-0">
        <search className="flex flex-col gap-[18px] px-[22px] pt-4 pb-5 sm:px-8 sm:pt-7 sm:pb-6">
          <form onSubmit={submit} className="flex items-center gap-3 sm:gap-4">
            <SearchIcon className="size-[22px] shrink-0 sm:size-[26px]" />
            <Input
              ref={input}
              type="search"
              aria-label={label}
              placeholder={placeholder}
              value={current}
              onValueChange={change}
              onKeyDown={removeLastOnBackspace}
              className="min-w-0 flex-1 bg-transparent font-sans text-[16px] leading-6 font-medium text-foreground placeholder:text-muted-foreground sm:text-xl sm:tracking-snug [&::-webkit-search-cancel-button]:appearance-none"
            />
            <kbd className="flex h-[30px] shrink-0 items-center rounded-[8px] bg-muted px-2.5 font-sans text-sm font-semibold text-secondary-foreground max-sm:hidden">
              /
            </kbd>
          </form>
          {filters.length > 0 && (
            <ul aria-label="Filters" className="flex flex-wrap gap-2 sm:pl-[42px]">
              {filters.map((filter) => (
                <li key={filter.id}>
                  <FilterChip filter={filter} onRemove={(removed) => onRemoveFilter?.(removed)} />
                </li>
              ))}
            </ul>
          )}
        </search>
        {strip && (
          <div className="max-sm:order-first sm:pr-5 sm:pb-1.5 sm:pl-8">
            <div className="flex h-16 items-center justify-between gap-3 border-muted pr-3 pl-[22px] max-sm:pt-[3px] sm:gap-6 sm:border-t-[1.5px] sm:px-0">
              <div aria-live="polite" className="min-w-0">
                {status}
              </div>
              <div className="flex shrink-0 items-center gap-2.5">{controls}</div>
            </div>
            <div aria-hidden className="mx-[22px] h-[1.5px] bg-muted sm:hidden" />
          </div>
        )}
        {progress !== undefined && <Rail progress={progress} className="absolute inset-x-0 bottom-0 max-sm:hidden" />}
      </Tile>
    </div>
  );
}

export type StatusIcon = "busy" | "synced" | "found" | "done" | "failed";

function Glyph({ icon }: { icon: StatusIcon }) {
  const common = { viewBox: "0 0 16 16", fill: "none", className: "size-4" } as const;
  switch (icon) {
    case "busy":
      return (
        <svg aria-hidden {...common} className="size-4 animate-spin motion-reduce:animate-none">
          <circle cx="8" cy="8" r="6" stroke="var(--color-accent-soft)" strokeWidth="2.2" />
          <path d="M8 2a6 6 0 0 1 6 6" stroke="var(--color-accent-strong)" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
      );
    case "synced":
      return (
        <svg aria-hidden {...common}>
          <path
            d="M13 6.5A5.2 5.2 0 0 0 3.6 5M3 9.5A5.2 5.2 0 0 0 12.4 11M3.4 2.6V5.2H6M12.6 13.4V10.8H10"
            stroke="var(--color-success)"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "found":
      return (
        <svg aria-hidden {...common}>
          <path
            d="M8 2.3l1.7 3.5 3.9.6-2.8 2.7.7 3.8L8 11.1l-3.5 1.8.7-3.8-2.8-2.7 3.9-.6z"
            fill="var(--color-highlight)"
            stroke="var(--color-highlight-edge)"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "done":
      return (
        <svg aria-hidden {...common}>
          <circle cx="8" cy="8" r="6" stroke="var(--color-muted-foreground)" strokeWidth="1.5" />
          <path
            d="m5.5 8.2 1.7 1.7 3.3-3.4"
            stroke="var(--color-muted-foreground)"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "failed":
      return (
        <svg aria-hidden {...common}>
          <circle cx="8" cy="8" r="6" stroke="var(--color-destructive)" strokeWidth="1.5" />
          <path d="M8 5v3.5M8 11h.01" stroke="var(--color-destructive)" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      );
  }
}

export function StatusLine({
  icon,
  label,
  detail,
  action,
}: {
  icon: StatusIcon;
  label: string;
  detail?: string | undefined;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span className="flex size-[18px] shrink-0 items-center justify-center max-sm:hidden">
        <Glyph icon={icon} />
      </span>
      <p className="flex min-w-0 flex-col gap-0.5 font-sans font-medium sm:block sm:truncate sm:text-base sm:leading-5">
        <span className="text-meta font-semibold text-foreground sm:text-base">{label}</span>
        {detail && (
          <span className="text-sm text-muted-foreground sm:text-base">
            <span className="max-sm:hidden"> · </span>
            {detail}
          </span>
        )}
      </p>
      {action}
    </div>
  );
}
