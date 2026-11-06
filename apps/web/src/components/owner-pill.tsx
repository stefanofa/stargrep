import { Popover } from "@base-ui/react/popover";
import { Avatar } from "@stargrep/ui";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useId, useState } from "react";
import type { PublicConfig } from "../lib/planned.ts";
import type { Viewer } from "../lib/rpc.ts";
import { githubLogin } from "../lib/search-params.ts";

const avatarOf = (login: string) => `https://github.com/${login}.png?size=64`;

function Chevron() {
  return (
    <svg aria-hidden viewBox="0 0 14 14" fill="none" className="size-3 shrink-0 text-secondary-foreground sm:size-3.5">
      <path
        d="m3.5 5.5 3.5 3.5 3.5-3.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function OwnerPill({ owner, viewer, config }: { owner: string; viewer: Viewer | null; config: PublicConfig }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const field = useId();
  const login = typed.trim().replace(/^@/, "");
  const valid = githubLogin.test(login);
  const people = [...(viewer === null ? [] : [viewer.login]), ...config.featured].filter(
    (person, index, all) => all.findIndex((other) => same(other, person)) === index,
  );

  const go = (next: string) => {
    setOpen(false);
    setTyped("");
    const home = viewer === null ? same(next, config.demoLogin) : same(next, viewer.login);
    if (home) navigate({ to: "/" });
    else navigate({ to: "/$login", params: { login: next } });
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (valid) go(login);
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        aria-label={`Whose stars: @${owner}. Change`}
        className="relative flex h-9 max-w-[150px] sm:max-w-[45%] shrink-0 items-center gap-1.5 rounded-full bg-accent-soft pr-2.5 pl-1 font-sans text-meta font-semibold text-foreground transition-[background-color,scale] duration-120 select-none after:absolute after:inset-x-0 after:-inset-y-1 hover:bg-accent/30 motion-safe:active:scale-[0.96] sm:h-11 sm:gap-2 sm:pr-3 sm:pl-1.5 sm:text-base sm:after:hidden"
      >
        <Avatar
          person={{ login: owner, avatarUrl: avatarOf(owner) }}
          index={0}
          className="size-7 border-0 bg-highlight sm:size-8"
        />
        <span className="truncate">@{owner}</span>
        <Chevron />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={8} align="start" className="z-50 outline-none">
          <Popover.Popup className="flex w-72 flex-col gap-1 rounded-md border-[1.5px] border-border bg-card p-1.5 font-sans text-meta font-medium text-foreground transition-opacity duration-120 outline-none data-ending-style:opacity-0 data-starting-style:opacity-0">
            <form onSubmit={submit} className="flex flex-col gap-1.5 p-1.5">
              <label htmlFor={field} className="text-sm text-muted-foreground">
                search anyone's stars
              </label>
              <div className="flex items-center gap-2 rounded-full bg-muted pr-1 pl-3.5 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent">
                <span aria-hidden className="text-muted-foreground">
                  @
                </span>
                <input
                  id={field}
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                  placeholder="github username"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  className="h-10 min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
                />
                <button
                  type="submit"
                  disabled={!valid}
                  className="h-8 rounded-full bg-accent px-3 font-semibold text-ink transition-[opacity,scale] duration-120 disabled:opacity-40 motion-safe:active:scale-[0.96]"
                >
                  go
                </button>
              </div>
            </form>
            <ul aria-label="Synced accounts" className="flex flex-col">
              {people.map((person) => (
                <li key={person}>
                  <button
                    type="button"
                    onClick={() => go(person)}
                    aria-current={same(person, owner) || undefined}
                    className="flex h-11 w-full items-center gap-2.5 rounded-[12.5px] px-2 text-left hover:bg-accent-soft aria-[current]:bg-accent-soft"
                  >
                    <Avatar
                      person={{ login: person, avatarUrl: avatarOf(person) }}
                      index={0}
                      className="size-7 border-0"
                    />
                    <span className="flex-1 truncate">@{person}</span>
                    {viewer !== null && same(person, viewer.login) && (
                      <span className="text-sm text-muted-foreground">you</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
