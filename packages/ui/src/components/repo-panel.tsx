import { Dialog } from "@base-ui/react/dialog";
import { Avatar, type Person } from "./avatar.tsx";
import { Button, buttonVariants } from "./button.tsx";
import { CloseIcon, ExternalIcon, PlusIcon, StarIcon } from "./icons.tsx";
import { type Activity, activityLabel, formatStars } from "./results.tsx";

export type RelatedRepo = {
  readonly owner: string;
  readonly name: string;
  readonly href: string;
  readonly stars: number;
};

export type RepoDetail = {
  readonly owner: string;
  readonly name: string;
  readonly language?: string;
  readonly description: string;
  readonly summary: string;
  readonly stars: number | null;
  readonly starred?: string;
  readonly activity: Activity;
  readonly release?: string;
  readonly license?: string;
  readonly network: ReadonlyArray<Person>;
  readonly alsoStarred: ReadonlyArray<RelatedRepo>;
  readonly githubUrl: string;
};

const heading = "font-display text-[20px] leading-6 font-semibold";
const fact = "flex min-w-0 basis-0 flex-col gap-1.5";
const factLabel = "font-sans text-label leading-3 font-semibold tracking-caps text-muted-foreground uppercase";
const factValue = "font-sans text-base leading-gap font-medium";

export function RepoPanel({
  repo,
  open,
  onOpenChange,
  onAddToCollection,
  returnFocus,
}: {
  repo: RepoDetail | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAddToCollection?: (repo: RepoDetail) => void;
  returnFocus?: HTMLElement | null;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-scrim transition-opacity duration-160 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup
          finalFocus={returnFocus ? () => returnFocus : true}
          className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[520px] flex-col gap-[34px] overflow-y-auto rounded-l-tile bg-card px-9 py-8 text-foreground shadow-panel transition-[translate,opacity] duration-220 ease-out data-ending-style:translate-x-full data-starting-style:translate-x-full max-sm:px-gap motion-reduce:transition-opacity motion-reduce:data-ending-style:translate-x-0 motion-reduce:data-ending-style:opacity-0 motion-reduce:data-starting-style:translate-x-0 motion-reduce:data-starting-style:opacity-0"
        >
          {repo && (
            <>
              <div className="flex flex-col gap-[14px]">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex flex-col gap-0.5">
                    <Dialog.Title className="font-display text-3xl leading-[40px] font-semibold tracking-snug">
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
                      you starred it {repo.starred}
                    </p>
                  )}
                </div>
                <dl className="flex gap-4 rounded-md bg-background px-gap py-4">
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
                  {repo.release && (
                    <div className={`${fact} grow`}>
                      <dt className={factLabel}>Release</dt>
                      <dd className={factValue}>{repo.release}</dd>
                    </div>
                  )}
                  {repo.license && (
                    <div className={`${fact} grow-[0.7]`}>
                      <dt className={factLabel}>License</dt>
                      <dd className={factValue}>{repo.license}</dd>
                    </div>
                  )}
                </dl>
              </div>

              <section className="flex flex-col gap-2">
                <h3 className={heading}>in short</h3>
                <p className="font-sans text-base text-secondary-foreground">{repo.summary}</p>
              </section>

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

              {repo.alsoStarred.length > 0 && (
                <section className="flex flex-col gap-3">
                  <h3 className={heading}>people who star this also star</h3>
                  <ul className="grid grid-cols-3 gap-3 max-sm:grid-cols-1">
                    {repo.alsoStarred.slice(0, 3).map((related) => (
                      <li
                        key={`${related.owner}/${related.name}`}
                        className="relative flex flex-col gap-[14px] rounded-md bg-background px-4 py-[14px]"
                      >
                        <div className="flex flex-col gap-px">
                          <a
                            href={related.href}
                            className="font-display text-[19px] leading-base font-semibold after:absolute after:inset-0 after:rounded-[inherit]"
                          >
                            {related.name}
                          </a>
                          <span className="font-sans text-sm font-medium text-muted-foreground">{related.owner}</span>
                        </div>
                        <span className="flex items-center gap-1 font-display text-lg leading-gap font-semibold">
                          <StarIcon className="size-3.5" />
                          {formatStars(related.stars)}
                          <span className="sr-only">stars</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <div className="mt-auto flex gap-[10px]">
                <a href={repo.githubUrl} className={buttonVariants({ size: "lg", className: "flex-1" })}>
                  Open on GitHub
                  <ExternalIcon />
                </a>
                {onAddToCollection && (
                  <Button variant="secondary" size="lg" className="flex-1" onClick={() => onAddToCollection(repo)}>
                    <PlusIcon />
                    Add to collection
                  </Button>
                )}
              </div>
            </>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
