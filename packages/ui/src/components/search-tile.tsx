import { Input } from "@base-ui/react/input";
import { type FormEvent, type ReactNode, useEffect, useLayoutEffect, useRef } from "react";
import { cn } from "../lib/cn.ts";
import { Button } from "./button.tsx";
import { CloseIcon, SearchIcon } from "./icons.tsx";
import { Tile } from "./tile.tsx";

const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT");

export interface TileProgress {
  readonly value: number;
  readonly max: number;
  readonly label: string;
  readonly text: string;
}

function Rail({ progress, className }: { progress: TileProgress; className?: string }) {
  const fraction = Math.min(1, Math.max(0, progress.value / Math.max(1, progress.max)));
  return (
    <div
      role="progressbar"
      aria-label={progress.label}
      aria-valuemin={0}
      aria-valuemax={progress.max}
      aria-valuenow={progress.value}
      aria-valuetext={progress.text}
      data-slot="rail"
      className={cn("h-[3px] overflow-hidden bg-accent-soft", className)}
    >
      <div
        className="h-full origin-left bg-accent transition-transform duration-500 ease-out motion-reduce:transition-none"
        style={{ transform: `scaleX(${Math.round(fraction * 1000) / 1000})` }}
      />
    </div>
  );
}

// The page's search. On desktop it is one tile: the input over a strip with the answer, the filters, and the controls.
// On phones the input docks just above the tab bar as one slim field, and the strip stays in the page above the results,
// so the tile itself lays out nothing there.
export function SearchTile({
  query,
  onQueryChange,
  label = "Search your stars",
  placeholder,
  status,
  filters,
  controls,
  progress,
  className,
}: {
  query: string;
  onQueryChange?: (query: string) => void;
  label?: string;
  placeholder?: string | undefined;
  status?: ReactNode;
  // The chips that filter the answer, which scroll sideways on phones.
  filters?: ReactNode;
  controls?: ReactNode;
  progress?: TileProgress | undefined;
  className?: string;
}) {
  const input = useRef<HTMLInputElement>(null);

  // A server-rendered tile takes typing before its script arrives, so it adopts what the input holds when it hydrates.
  const typedEarly = useRef({ query, onQueryChange });
  useLayoutEffect(() => {
    const typed = input.current?.value;
    if (typed !== undefined && typed !== typedEarly.current.query) typedEarly.current.onQueryChange?.(typed);
  }, []);

  useEffect(() => {
    const focusOnSlash = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey || typing(event.target)) return;
      event.preventDefault();
      input.current?.focus();
    };
    window.addEventListener("keydown", focusOnSlash);
    return () => window.removeEventListener("keydown", focusOnSlash);
  }, []);

  // Results land as you type, so a phone keyboard's search key only has to get out of their way.
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (matchMedia("(pointer: coarse)").matches) input.current?.blur();
  };

  const clear = () => {
    onQueryChange?.("");
    input.current?.focus();
  };

  return (
    <div className={cn("relative", className)}>
      <Tile className="flex flex-col overflow-clip px-7 pt-[22px] pb-2.5 max-sm:contents sm:has-[input:focus-visible]:outline-2 sm:has-[input:focus-visible]:outline-offset-2 sm:has-[input:focus-visible]:outline-ring">
        <search className="max-sm:fixed max-sm:inset-x-0 max-sm:bottom-[calc(var(--dock-bottom)-8px)] max-sm:z-30 max-sm:bg-linear-to-b max-sm:from-background/0 max-sm:to-background/95 max-sm:to-40% max-sm:px-3 max-sm:pt-2.5 max-sm:pb-2">
          <form
            onSubmit={submit}
            className="flex items-center gap-2.5 max-sm:relative max-sm:h-12 max-sm:rounded-full max-sm:bg-card max-sm:pr-2 max-sm:pl-4 max-sm:shadow-dock max-sm:has-[input:focus-visible]:outline-2 max-sm:has-[input:focus-visible]:outline-offset-2 max-sm:has-[input:focus-visible]:outline-ring sm:gap-3.5 sm:border-b-[1.5px] sm:border-muted sm:pb-[18px]"
          >
            <SearchIcon className="size-[18px] shrink-0 text-muted-foreground sm:size-[22px]" />
            <Input
              ref={input}
              type="search"
              aria-label={label}
              placeholder={placeholder}
              value={query}
              onValueChange={(next) => onQueryChange?.(next)}
              enterKeyHint="search"
              className="min-w-0 flex-1 bg-transparent font-sans text-[16px] leading-5 text-ellipsis text-foreground outline-none placeholder:text-muted-foreground sm:text-xl sm:leading-8 [&::-webkit-search-cancel-button]:appearance-none"
            />
            {query === "" ? (
              <kbd className="flex h-7 shrink-0 items-center rounded-xs bg-muted px-2.5 font-sans text-sm font-semibold text-secondary-foreground max-sm:hidden">
                /
              </kbd>
            ) : (
              <Button
                variant="muted"
                size="xs"
                aria-label="Clear search"
                onClick={clear}
                className="size-[30px] text-muted-foreground sm:size-7 [&_svg]:size-[13px]"
              >
                <CloseIcon />
              </Button>
            )}
            {progress !== undefined && (
              <Rail
                progress={progress}
                className="absolute inset-x-6 top-0 rounded-full sm:inset-x-0 sm:top-auto sm:bottom-0 sm:rounded-none"
              />
            )}
          </form>
        </search>
        {(status !== undefined || filters !== undefined || controls !== undefined) && (
          <div className="flex items-center gap-1 max-sm:-mt-1 max-sm:-mb-2 sm:h-16 sm:justify-between sm:gap-6">
            {/* Phones scroll the answer and its chips under the controls, which stay put, and fade them out as they go. */}
            <div className="flex min-w-0 items-center gap-2 max-sm:-my-1 max-sm:-ml-4 max-sm:overflow-x-auto max-sm:py-1 max-sm:pr-3 max-sm:pl-4 max-sm:[mask-image:linear-gradient(to_left,transparent,#000_12px)] max-sm:[scrollbar-width:none]">
              {status}
              {filters}
            </div>
            <div className="flex shrink-0 items-center gap-2 sm:gap-2.5">{controls}</div>
          </div>
        )}
      </Tile>
    </div>
  );
}

// What the strip says about the answer on screen: found 6!, searching…, or what went wrong, with a way to try again.
// The label is the one live region, and it stays in the page while it is empty, so screen readers hear each new answer.
export function StatusLine({
  label = "",
  phoneLabel,
  action,
}: {
  label?: string | undefined;
  // A shorter label for the phone's strip, which shares its one line with the filters.
  phoneLabel?: string | undefined;
  action?: ReactNode;
}) {
  return (
    <>
      <span
        role="status"
        className="shrink-0 font-display text-lg leading-[22px] font-semibold whitespace-nowrap not-empty:pr-1 empty:-me-2 sm:text-xl sm:leading-6 sm:not-empty:pr-2"
      >
        {phoneLabel === undefined ? (
          label
        ) : (
          <>
            <span className="sm:hidden">{phoneLabel}</span>
            <span className="max-sm:hidden">{label}</span>
          </>
        )}
      </span>
      {action}
    </>
  );
}
