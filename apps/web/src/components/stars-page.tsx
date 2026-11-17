import { loginKey } from "@stargrep/github/login";
import { type PipPose, Skeleton } from "@stargrep/ui";
import { Suspense, useState } from "react";
import { HeaderControls, SignInProblem, Stars } from "../lib/engine.ts";
import type { PageData } from "../lib/page-data.ts";
import { GitHubStarLink, HeaderEnd } from "./github-star-link.tsx";
import { Page } from "./page.tsx";
import { Wordmark } from "./wordmark.tsx";

// The light part of every stars page. Everything that searches renders inside the engine boundaries, which the server
// fills and the browser keeps as server HTML until the engine chunk arrives.
export function StarsPage({ data, error }: { data: PageData; error?: string | undefined }) {
  const [pose, setPose] = useState<PipPose>("idle");
  const star = <GitHubStarLink stars={data.repoStars} />;
  return (
    <Page
      header={
        <>
          <Wordmark pose={error === undefined ? pose : "scared"} />
          {/* A visitor signs in from the butter tile in the hero, so the header doesn't ask twice. */}
          {data.audience.by === "anyone" ? (
            star
          ) : (
            <Suspense fallback={<HeaderEnd star={star} account={<Skeleton className="size-11 shrink-0" />} />}>
              <HeaderControls viewer={data.audience.viewer} star={star} />
            </Suspense>
          )}
        </>
      }
    >
      <Suspense fallback={null}>
        {error !== undefined && <SignInProblem error={error} />}
        <Stars key={loginKey(data.audience.owner.login)} data={data} onPose={setPose} />
      </Suspense>
    </Page>
  );
}
