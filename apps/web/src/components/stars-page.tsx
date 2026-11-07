import { type PipPose, Skeleton, Tile } from "@stargrep/ui";
import { useLoaderData, useSearch } from "@tanstack/react-router";
import { Suspense, useState } from "react";
import { HeaderControls, Stars } from "../lib/engine.ts";
import type { PageData } from "../lib/page-data.ts";
import type { Params } from "../lib/search-params.ts";
import { Page } from "./page.tsx";
import { SignInButton } from "./sign-in-button.tsx";
import { Wordmark } from "./wordmark.tsx";

const problems: Record<string, { readonly heading: string; readonly detail: string }> = {
  access_denied: { heading: "you said no to github", detail: "stargrep saw nothing from your account" },
};

const failed = { heading: "sign-in didn't finish", detail: "github or stargrep hiccuped on the way back" };

function SignInProblem({ error }: { error: string }) {
  const problem = problems[error] ?? failed;
  return (
    <Tile
      role="alert"
      className="flex flex-col gap-4 py-6 pr-6 pl-tile-lg sm:flex-row sm:items-center sm:justify-between sm:rounded-md"
    >
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-2xl font-semibold tracking-snug">{problem.heading}</h2>
        <p className="font-sans text-base text-secondary-foreground">{problem.detail}</p>
      </div>
      <SignInButton variant="primary" size="lg" label="Try again" />
    </Tile>
  );
}

// The component of every stars route, with that route's page data.
export function StarsRoute() {
  const data = useLoaderData({ strict: false }) as PageData;
  const { error }: Params = useSearch({ strict: false });
  return <StarsPage data={data} error={error} />;
}

// The light part of every stars page. Everything that searches renders inside the engine boundaries, which the server
// fills and the browser keeps as server HTML until the engine chunk arrives.
export function StarsPage({ data, error }: { data: PageData; error?: string | undefined }) {
  const [pose, setPose] = useState<PipPose>("idle");
  return (
    <Page
      header={
        <>
          <Wordmark pose={error === undefined ? pose : "scared"} />
          {/* A visitor signs in from the butter tile in the hero, so the header doesn't ask twice. */}
          {data.viewer !== null && (
            <Suspense fallback={<Skeleton className="size-11 shrink-0" />}>
              <HeaderControls viewer={data.viewer} />
            </Suspense>
          )}
        </>
      }
    >
      {error !== undefined && <SignInProblem error={error} />}
      <Suspense fallback={null}>
        <Stars key={data.owner.toLowerCase()} data={data} onPose={setPose} />
      </Suspense>
    </Page>
  );
}
