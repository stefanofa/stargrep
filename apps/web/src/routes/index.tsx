import { buttonVariants, Mascot, Tile } from "@stargrep/ui";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Page } from "../components/page.tsx";
import { SignInButton } from "../components/sign-in-button.tsx";
import { Wordmark } from "../components/wordmark.tsx";
import { signedIn } from "../lib/auth-client.ts";

const errors: Record<string, { readonly heading: string; readonly detail: string }> = {
  access_denied: { heading: "you said no to github", detail: "stargrep saw nothing from your account" },
};

const failed = { heading: "sign-in didn't finish", detail: "github or stargrep hiccuped on the way back" };

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>): { error?: string } =>
    typeof search.error === "string" && search.error !== "" ? { error: search.error } : {},
  component: Landing,
});

function useSignedIn() {
  const [state, setState] = useState<boolean>();
  useEffect(() => {
    signedIn().then(setState, () => setState(false));
  }, []);
  return state;
}

function Landing() {
  const { error } = Route.useSearch();
  const session = useSignedIn();
  const problem = error === undefined ? undefined : (errors[error] ?? failed);
  const toStars = (
    <Link to="/search" className={buttonVariants({ size: "lg" })}>
      Search your stars
    </Link>
  );
  return (
    <Page
      header={
        <>
          <Wordmark />
          {session === true ? (
            <Link to="/search" className={buttonVariants({ variant: "ghost" })}>
              Your stars
            </Link>
          ) : (
            <SignInButton />
          )}
        </>
      }
    >
      <section className="grid gap-gap pt-6 sm:pt-[46px] lg:grid-cols-[1fr_285px]">
        <div className="flex min-w-0 flex-col gap-10">
          <h1 className="font-display text-[44px] leading-[50px] font-semibold tracking-tight sm:text-[64px] sm:leading-[76px]">
            search your github stars in plain words
          </h1>
          {problem === undefined ? (
            <Tile className="flex flex-col gap-4 py-6 pr-6 pl-tile-lg sm:flex-row sm:items-center sm:justify-between">
              <p className="font-sans text-xl font-medium tracking-snug text-muted-foreground">
                the rust library for terminal dashboards I starred last year
              </p>
              {session === true ? toStars : <SignInButton variant="primary" size="lg" />}
            </Tile>
          ) : (
            <Tile
              role="alert"
              className="flex flex-col gap-4 py-6 pr-6 pl-tile-lg sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex flex-col gap-1">
                <h2 className="font-display text-2xl font-semibold tracking-snug">{problem.heading}</h2>
                <p className="font-sans text-base text-secondary-foreground">{problem.detail}</p>
              </div>
              <SignInButton variant="primary" size="lg" label="Try again" />
            </Tile>
          )}
        </div>
        <Tile className="relative flex min-h-[240px] items-center justify-center max-lg:hidden">
          <Mascot mood={problem === undefined ? "searching" : "surprised"} size={200} className="rotate-[10deg]" />
        </Tile>
      </section>
    </Page>
  );
}
