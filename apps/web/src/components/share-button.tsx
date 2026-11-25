import { buttonVariants, CheckIcon, cn } from "@stargrep/ui";
import { useEffect, useState } from "react";
import { capture } from "../lib/analytics.ts";
import { after } from "../lib/wall-clock.ts";

// The address a person's page shares: /@login, which every login answers at, with the search on screen.
export const shareUrl = (origin: string, login: string, query: string | undefined) => {
  const url = new URL(`/@${login}`, origin);
  if (query) url.searchParams.set("q", query);
  return url.href;
};

// The icon lives with its one button, since every icon in the UI kit's module ships with the landing page.
function ShareIcon({ className }: { className: string }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" fill="none" className={className}>
      <path
        d="M12 3v12M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Shares a person's page. A touch screen with a share sheet opens it. Anywhere else the link goes to the clipboard, and
// the button says so for a moment. Phones show the icon alone.
export function ShareButton({
  login,
  query,
  className,
}: {
  login: string;
  query: string | undefined;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => (copied ? after(2_000, () => setCopied(false)) : undefined), [copied]);
  const share = async () => {
    const url = shareUrl(location.origin, login, query);
    if (navigator.share !== undefined && matchMedia("(pointer: coarse)").matches) {
      // Closing the sheet is an answer too. Only a sheet that failed falls back to the clipboard.
      const outcome = await navigator.share({ title: `@${login}'s stars on stargrep`, url }).then(
        () => "shared" as const,
        (error: unknown) => (error instanceof DOMException && error.name === "AbortError" ? "closed" : "failed"),
      );
      if (outcome === "shared") capture("person_shared", { via: "sheet" });
      if (outcome !== "failed") return;
    }
    await navigator.clipboard.writeText(url).then(
      () => {
        setCopied(true);
        capture("person_shared", { via: "link" });
      },
      () => undefined,
    );
  };
  return (
    <>
      <button
        type="button"
        onClick={() => void share()}
        className={cn(
          buttonVariants({ variant: "secondary", size: "lg" }),
          "text-meta max-sm:px-0 sm:px-[18px]",
          className,
        )}
      >
        {copied ? <CheckIcon className="size-[18px]" /> : <ShareIcon className="size-[18px]" />}
        <span className="max-sm:sr-only">{copied ? "link copied" : "share"}</span>
      </button>
      <span role="status" className="sr-only">
        {copied ? "link copied" : ""}
      </span>
    </>
  );
}
