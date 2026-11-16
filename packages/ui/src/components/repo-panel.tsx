import { Dialog } from "@base-ui/react/dialog";
import { formatStars } from "../lib/format-stars.ts";
import { Avatar, type Person } from "./avatar.tsx";
import { Button, buttonVariants } from "./button.tsx";
import { CloseIcon, ExternalIcon, StarIcon } from "./icons.tsx";
import { RepoIcon, type RepoVisual } from "./repo-icon.tsx";
import { type Activity, activityLabel } from "./results.tsx";

export type RepoDetail = {
  readonly owner: string;
  readonly name: string;
  readonly language?: string;
  readonly description: string;
  readonly summary?: string;
  readonly stars: number | null;
  readonly starred?: { readonly by: string; readonly on: string };
  readonly activity: Activity;
  readonly license?: string;
  readonly network: ReadonlyArray<Person>;
  readonly githubUrl: string;
  readonly visual: RepoVisual;
};

const heading = "font-display text-[20px] leading-6 font-semibold";
const fact = "flex min-w-0 basis-0 flex-col gap-1.5";
const factLabel = "font-sans text-label leading-3 font-semibold tracking-caps text-muted-foreground uppercase";
const factValue = "font-sans text-base leading-gap font-medium";

export function RepoPanel({
  repo,
  open,
  onOpenChange,
  returnFocus,
}: {
  repo: RepoDetail | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocus?: HTMLElement | null;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-scrim transition-opacity duration-160 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup
          finalFocus={returnFocus ? () => returnFocus : true}
          className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[520px] flex-col gap-[34px] overflow-y-auto squircle rounded-l-tile bg-card px-9 py-8 text-foreground shadow-panel transition-[translate,opacity] duration-220 ease-out data-ending-style:translate-x-full data-starting-style:translate-x-full max-sm:px-gap motion-reduce:transition-opacity motion-reduce:data-ending-style:translate-x-0 motion-reduce:data-ending-style:opacity-0 motion-reduce:data-starting-style:translate-x-0 motion-reduce:data-starting-style:opacity-0"
        >
          {repo && (
            <>
              <div className="flex flex-col gap-[14px]">
                <div className="flex items-start gap-4">
                  <RepoIcon visual={repo.visual} size="panel" />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <Dialog.Title className="font-display text-3xl leading-[40px] font-semibold tracking-snug break-words">
                      {repo.name}
                    </Dialog.Title>
                    <p className="font-sans text-base leading-gap font-medium text-muted-foreground">
                      {[repo.owner, repo.language].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                  <Dialog.Close render={<Button variant="muted" size="icon" />}>
                    <CloseIcon className="size-4" />
                    <span className="sr-only">Close</span>
                  </Dialog.Close>
                </div>
                <Dialog.Description className="font-sans text-lg">{repo.description}</Dialog.Description>
              </div>

              <div className="flex flex-col gap-[18px]">
                <div className="flex flex-wrap items-end justify-between gap-3">
                  {repo.stars !== null && (
                    <p className="flex items-center gap-2">
                      <svg viewBox="0 0 24 24" aria-hidden className="size-10">
                        <path
                          d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z"
                          fill="var(--color-highlight)"
                          stroke="var(--color-highlight-edge)"
                          strokeWidth="1.6"
                          strokeLinejoin="round"
                        />
                      </svg>
                      <span className="font-display text-[76px] leading-[76px] font-semibold tracking-[-0.03em]">
                        {formatStars(repo.stars)}
                      </span>
                      <span className="sr-only">stars</span>
                    </p>
                  )}
                  {repo.starred && (
                    <p className="mb-2 flex h-8 items-center gap-[7px] rounded-full bg-accent-soft pr-[13px] pl-[11px] font-sans text-sm font-semibold text-accent-strong">
                      <StarIcon className="size-[13px]" />
                      {repo.starred.by} starred it {repo.starred.on}
                    </p>
                  )}
                </div>
                <dl className="flex gap-4 squircle rounded-md bg-background px-gap py-4">
                  <div className={`${fact} grow-[1.4]`}>
                    <dt className={factLabel}>Alive</dt>
                    <dd className={`${factValue} flex items-center gap-[7px]`}>
                      <span
                        aria-hidden
                        className={`size-2 shrink-0 rounded-full ${repo.activity.state === "alive" ? "bg-success" : "bg-muted-foreground"}`}
                      />
                      {activityLabel(repo.activity)}
                    </dd>
                  </div>
                  {repo.license && (
                    <div className={`${fact} grow-[0.7]`}>
                      <dt className={factLabel}>License</dt>
                      <dd className={factValue}>{repo.license}</dd>
                    </div>
                  )}
                </dl>
              </div>

              {repo.summary !== undefined && (
                <section className="flex flex-col gap-2">
                  <h3 className={heading}>in short</h3>
                  <p className="font-sans text-base text-secondary-foreground">{repo.summary}</p>
                </section>
              )}

              {repo.network.length > 0 && (
                <section className="flex items-center gap-3">
                  <div className="flex -space-x-2" aria-hidden>
                    {repo.network.slice(0, 4).map((person, index) => (
                      <Avatar
                        key={person.login}
                        person={person}
                        index={index}
                        className="size-9 border-[2.5px] [&_span]:text-sm"
                      />
                    ))}
                  </div>
                  <div className="flex flex-col gap-px">
                    <h3 className={heading}>starred by {repo.network.length} you follow</h3>
                    <p className="font-sans text-sm font-medium text-muted-foreground">
                      {repo.network.map((person) => `@${person.login}`).join(", ")}
                    </p>
                  </div>
                </section>
              )}

              <a
                href={repo.githubUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={buttonVariants({ size: "lg", className: "mt-auto" })}
              >
                Open on GitHub
                <ExternalIcon />
              </a>
            </>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
