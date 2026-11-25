import { loginKey } from "@stargrep/github/login";
import type { PipPose } from "@stargrep/ui";
import { Suspense, useState } from "react";
import { Landing, SignInProblem, Stars } from "../lib/engine.ts";
import type { StarsRouteData } from "../lib/page-data.ts";
import { Page } from "./page.tsx";

// The light part of / and every stars page. The landing and everything that searches render inside the engine
// boundaries, which the server fills and the browser keeps as server HTML until the engine chunk arrives. The landing and your own stars
// are home, the you place. Anyone else's stars are theirs, in no place.
export function StarsPage({ data, error }: { data: StarsRouteData; error?: string | undefined }) {
  const [pose, setPose] = useState<PipPose>("idle");
  const home = data.kind === "landing" || data.audience.by === "owner";
  return (
    <Page dock={data.kind === "stars"} here={home ? "you" : undefined} pose={error === undefined ? pose : "scared"}>
      <Suspense fallback={null}>
        {error !== undefined && <SignInProblem error={error} />}
        {data.kind === "landing" ? (
          <Landing example={data.example} />
        ) : (
          <Stars key={loginKey(data.audience.owner.login)} data={data} onPose={setPose} />
        )}
      </Suspense>
    </Page>
  );
}
