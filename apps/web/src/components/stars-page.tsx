import { loginKey } from "@stargrep/github/login";
import type { PipPose } from "@stargrep/ui";
import { Suspense, useState } from "react";
import { SignInProblem, Stars } from "../lib/engine.ts";
import type { PageData } from "../lib/page-data.ts";
import { Page } from "./page.tsx";
import { SiteHeader } from "./site-header.tsx";

// The light part of every stars page. Everything that searches renders inside the engine boundaries, which the server
// fills and the browser keeps as server HTML until the engine chunk arrives.
export function StarsPage({ data, error }: { data: PageData; error?: string | undefined }) {
  const [pose, setPose] = useState<PipPose>("idle");
  return (
    <Page
      dock
      header={
        <SiteHeader
          viewer={data.audience.by === "anyone" ? null : data.audience.viewer}
          repoStars={data.repoStars}
          pose={error === undefined ? pose : "scared"}
        />
      }
    >
      <Suspense fallback={null}>
        {error !== undefined && <SignInProblem error={error} />}
        <Stars key={loginKey(data.audience.owner.login)} data={data} onPose={setPose} />
      </Suspense>
    </Page>
  );
}
