import { loginKey } from "@stargrep/github/login";
import type { PipPose } from "@stargrep/ui";
import { Suspense, useState } from "react";
import { pageKindOf } from "../lib/audience.ts";
import { SignInProblem, Stars } from "../lib/engine.ts";
import type { PageData } from "../lib/page-data.ts";
import { Page } from "./page.tsx";

// The light part of every stars page. Everything that searches renders inside the engine boundaries, which the server
// fills and the browser keeps as server HTML until the engine chunk arrives. The landing and your own stars are home, the
// you place. Anyone else's stars are theirs, in no place.
export function StarsPage({ data, error }: { data: PageData; error?: string | undefined }) {
  const [pose, setPose] = useState<PipPose>("idle");
  const kind = pageKindOf(data.audience);
  return (
    <Page dock here={kind === "person" ? undefined : "you"} pose={error === undefined ? pose : "scared"}>
      <Suspense fallback={null}>
        {error !== undefined && <SignInProblem error={error} />}
        <Stars key={loginKey(data.audience.owner.login)} data={data} onPose={setPose} />
      </Suspense>
    </Page>
  );
}
