import { Chip, cn, Pip, type PipPose, ProgressRing, Tile } from "@stargrep/ui";
import type { Butter, HeroCopy } from "../lib/search-state.ts";
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
      <h2
        className={cn(
          "min-w-0 flex-1 font-display text-[19px] leading-[22px] font-semibold text-ink lg:flex-none lg:text-2xl lg:leading-[34px] lg:tracking-snug",
          claim ? "lg:w-[190px]" : "lg:w-[170px]",
        )}
      >
        {claim ? "is this you? skip the wait" : "your stars, in a minute"}
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

export function Hero({ subtitle, butter, pose }: HeroCopy & { pose: PipPose }) {
  return (
    <section className="flex flex-col gap-3.5 pt-1.5 sm:pt-5 lg:flex-row lg:gap-gap">
      <div className="flex min-w-0 flex-1 flex-col justify-end gap-3.5 lg:pb-1.5">
        <h1 className="font-display text-3xl leading-10 font-semibold tracking-tight text-balance sm:text-[64px] sm:leading-[68px]">
          search anyone's starred github repos in plain words
        </h1>
        {/* Two lines whatever the state says, so the search below never moves when the state changes. */}
        <p className="line-clamp-2 h-[2lh] font-sans text-lg text-pretty text-secondary-foreground max-sm:hidden">
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
