import { Button, buttonVariants, EmptyTile, type PipPose } from "@stargrep/ui";
import { type ErrorComponentProps, Link } from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";
import { Page } from "./page.tsx";
import { Wordmark } from "./wordmark.tsx";

function ProblemPage({
  pose,
  heading,
  body,
  action,
}: {
  pose: PipPose;
  heading: string;
  body: string;
  action: ReactNode;
}) {
  return (
    <Page header={<Wordmark pose={pose} />}>
      <EmptyTile pose={pose} heading={heading} body={body}>
        <div className="pt-2">{action}</div>
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
      action={
        <Link to="/" className={buttonVariants({ variant: "primary", size: "lg" })}>
          Go home
        </Link>
      }
    />
  );
}

// The error's message is for us, not the visitor, so the page logs it and never shows it.
export function Failure({ error }: ErrorComponentProps) {
  // @effect-diagnostics-next-line globalConsole:off - public pages load no Effect, so the browser's console logs it.
  useEffect(() => console.error(error), [error]);
  return (
    <ProblemPage
      pose="scared"
      heading="stargrep tripped"
      body="something broke on our side. a reload usually fixes it."
      action={
        <Button variant="primary" size="lg" onClick={() => location.reload()}>
          Reload
        </Button>
      }
    />
  );
}
