import { Button, Chip, cn, Pip, type PipPose, ProgressRing, Tile } from "@stargrep/ui";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useId } from "react";
import type { Butter, HeroCopy } from "../lib/search-state.ts";
import { loginPage, typedLogin, typedLoginParam } from "../lib/stars-route.ts";
import { ExternalTextLink } from "./external-text-link.tsx";
import { SignInButton } from "./sign-in-button.tsx";

function ButterTile({ butter, pose }: { butter: Butter; pose: PipPose }) {
  const claim = butter.kind === "claim";
  return (
    <Tile
      variant="highlight"
      className="flex items-center gap-3.5 overflow-clip py-3.5 pr-3.5 pl-[18px] lg:w-[385px] lg:shrink-0 lg:flex-col lg:items-start lg:justify-between lg:gap-4 lg:px-[30px] lg:pt-[26px] lg:pb-6"
    >
      {/* Both tiles keep one box for Pip: the claim tile shrinks the plate and Pip with a transform and rings them, so
          the switch never moves anything. */}
      <div className="relative flex size-14 shrink-0 items-center justify-center lg:absolute lg:top-4 lg:right-[18px] lg:size-[150px]">
        <div
          className={cn(
            "absolute inset-0 rounded-full bg-plate transition-transform duration-300 ease-out motion-reduce:transition-none",
            claim && "lg:scale-[0.8267]",
          )}
        />
        {claim && <ProgressRing progress={butter.progress} on="butter" className="max-lg:hidden" />}
        <Pip
          pose={pose}
          size={112}
          className={cn(
            "relative rotate-[10deg] transition-[scale] duration-300 ease-out motion-reduce:transition-none max-lg:size-[42px]",
            claim && "lg:scale-[0.8214]",
          )}
        />
      </div>
      <h2 className="min-w-0 flex-1 font-display text-[19px] leading-[22px] font-semibold text-ink lg:w-[190px] lg:flex-none lg:text-2xl lg:leading-[34px] lg:tracking-snug">
        {claim ? "is this you? skip the wait" : "skip the line, stay synced"}
      </h2>
      <SignInButton
        variant="primary"
        size="lg"
        className="h-10 shrink-0 px-3.5 text-meta lg:h-11 lg:self-start lg:px-[18px]"
        markClassName="size-[18px] max-lg:hidden"
        label={
          <>
            <span className="lg:hidden">Sign in</span>
            <span className="max-lg:hidden">Sign in with GitHub</span>
          </>
        }
      />
    </Tile>
  );
}

// Before the page hydrates, the browser submits the form itself and / sends the login on to its page.
function LoginField() {
  const navigate = useNavigate();
  const field = useId();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const login = typedLogin(String(new FormData(form).get(typedLoginParam) ?? ""));
    if (login === undefined) {
      form.reportValidity();
      return;
    }
    form.reset();
    navigate(loginPage(login));
  };
  return (
    <form
      action="/"
      method="get"
      onSubmit={submit}
      aria-label="Whose stars"
      className="flex h-12 items-center rounded-full bg-card pr-1 pl-5 font-sans text-lg focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring sm:h-14 sm:pr-1.5"
    >
      <label htmlFor={field} className="text-muted-foreground select-none">
        github.com/
      </label>
      <input
        id={field}
        name={typedLoginParam}
        aria-label="GitHub username"
        placeholder="username"
        required
        pattern={String.raw`\s*@?[A-Za-z\d][A-Za-z\d\-]{0,38}\s*`}
        title="a github username, such as octocat"
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="go"
        className="h-full min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground/70"
      />
      <Button type="submit" size="lg" className="h-10 px-5 sm:h-11">
        go
      </Button>
    </form>
  );
}

export function Hero({ subtitle, butter, pose }: HeroCopy & { pose: PipPose }) {
  return (
    <section className="flex flex-col gap-3.5 pt-1.5 sm:pt-5 lg:flex-row lg:gap-gap">
      <div className="flex min-w-0 flex-1 flex-col justify-end gap-3.5 lg:pb-1.5">
        <h1 className="font-display text-3xl leading-10 font-semibold tracking-tight text-balance sm:text-[64px] sm:leading-[68px]">
          search anyone's starred github repos in plain words
        </h1>
        {/* Two lines whatever the state says, so the search below never moves when the state changes. */}
        <p className="line-clamp-2 h-[2lh] font-sans text-base text-pretty text-secondary-foreground sm:text-lg">
          {subtitle.map((segment) =>
            typeof segment === "string" ? (
              segment
            ) : (
              <ExternalTextLink key={segment.login} href={`https://github.com/${segment.login}`}>
                {`@${segment.login}`}
              </ExternalTextLink>
            ),
          )}
        </p>
        <LoginField />
      </div>
      <ButterTile butter={butter} pose={pose} />
    </section>
  );
}

export function TryChips({ examples, onPick }: { examples: ReadonlyArray<string>; onPick: (query: string) => void }) {
  if (examples.length === 0) return null;
  return (
    <div className="-mt-1.5 flex flex-wrap items-center gap-2 pl-6 max-sm:hidden">
      <span className="pr-1.5 font-sans text-label font-semibold text-accent-strong uppercase">try</span>
      <ul aria-label="Example searches" className="contents">
        {examples.map((example) => (
          <li key={example}>
            <Chip type="button" tone="card" onClick={() => onPick(example)}>
              {example}
            </Chip>
          </li>
        ))}
      </ul>
    </div>
  );
}
