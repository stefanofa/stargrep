import { buttonVariants, EmptyTile, type PipPose } from "@stargrep/ui";
import { type ErrorComponentProps, Link } from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";
import { reportError } from "../lib/analytics.ts";
import { Page } from "./page.tsx";
import { Wordmark } from "./wordmark.tsx";

// The error and not-found pages ship in the landing chunk, so a page whose loader fails while the visitor is offline
// still has something to show. The landing never loads Base UI, so their buttons take the shared classes.
const action = buttonVariants({ variant: "primary", size: "lg" });

function ProblemPage({
  pose,
  heading,
  body,
  children,
}: {
  pose: PipPose;
  heading: string;
  body: string;
  children: ReactNode;
}) {
  return (
    <Page header={<Wordmark pose={pose} />}>
      <EmptyTile pose={pose} heading={heading} body={body}>
        <div className="pt-2">{children}</div>
      </EmptyTile>
    </Page>
  );
}

export function NotFound() {
  return (
    <ProblemPage
      pose="sad"
      heading="no page here"
      body="nothing lives at this address. search anyone's stars from the home page."
    >
      <Link to="/{-$login}" params={{ login: undefined }} className={action}>
        go home
      </Link>
    </ProblemPage>
  );
}

const problems = {
  offline: {
    pose: "unsure",
    heading: "you're offline",
    body: "this page needs the internet. reconnect, then try again.",
    retry: "try again",
  },
  limited: {
    pose: "unsure",
    heading: "lots of requests from your network",
    body: "give it a minute, then try again.",
    retry: "try again",
  },
  broken: {
    pose: "scared",
    heading: "stargrep tripped",
    body: "something broke on our side. a reload usually fixes it.",
    retry: "reload",
  },
} as const;

// The landing loads no oRPC, so the page reads a rate limit by its shape: the API's TOO_MANY_REQUESTS, or the 429 page
// Cloudflare's zone limit answers before the API sees the request, as rpc.ts's wireCode does.
const problemOf = (error: unknown): keyof typeof problems => {
  if (globalThis.navigator?.onLine === false) return "offline";
  const { code, response } = (error ?? {}) as { code?: unknown; response?: { status?: unknown } };
  return code === "TOO_MANY_REQUESTS" || response?.status === 429 ? "limited" : "broken";
};

// The error's message is for us, not the visitor, so the page logs it and never shows it.
export function Failure({ error }: ErrorComponentProps) {
  useEffect(() => {
    // @effect-diagnostics-next-line globalConsole:off - public pages load no Effect, so the browser's console logs it.
    console.error(error);
    reportError(error);
  }, [error]);
  const { retry, ...problem } = problems[problemOf(error)];
  return (
    <ProblemPage {...problem}>
      <button type="button" className={action} onClick={() => location.reload()}>
        {retry}
      </button>
    </ProblemPage>
  );
}
