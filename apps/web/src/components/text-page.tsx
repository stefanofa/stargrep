import { Tile } from "@stargrep/ui";
import { useLoaderData } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { GitHubStarLink } from "./github-star-link.tsx";
import { Page } from "./page.tsx";
import { Wordmark } from "./wordmark.tsx";

// A page of reading, such as the privacy page, in one tile at the narrow measure.
export function TextPage({ heading, children }: { heading: string; children: ReactNode }) {
  const { repoStars } = useLoaderData({ from: "__root__" });
  return (
    <Page
      header={
        <>
          <Wordmark />
          <GitHubStarLink stars={repoStars} />
        </>
      }
    >
      <Tile className="mx-auto flex w-full max-w-narrow flex-col gap-8 px-6 pt-tile-top pb-8 sm:px-tile-lg sm:pb-10">
        <h1 className="font-display text-3xl leading-none font-semibold tracking-snug">{heading}</h1>
        {children}
      </Tile>
    </Page>
  );
}

export function Section({ id, heading, children }: { id?: string; heading: string; children: ReactNode }) {
  return (
    <section id={id} className="flex scroll-mt-6 flex-col gap-3 font-sans text-lg text-secondary-foreground">
      <h2 className="font-display text-title font-semibold tracking-snug text-foreground">{heading}</h2>
      {children}
    </section>
  );
}

export function Bullets({ children }: { children: ReactNode }) {
  return <ul className="flex list-disc flex-col gap-2 pl-5 marker:text-muted-foreground">{children}</ul>;
}

export function Code({ children }: { children: ReactNode }) {
  return <code className="rounded-xs bg-muted px-1.5 py-0.5 font-mono text-sm text-foreground">{children}</code>;
}

export function CodeBlock({ label, children }: { label: string; children: string }) {
  return (
    <figure className="flex flex-col gap-1.5">
      <figcaption className="text-sm font-medium text-muted-foreground">{label}</figcaption>
      <pre className="squircle overflow-x-auto rounded-md bg-muted px-4 py-3 font-mono text-sm text-foreground">
        <code>{children}</code>
      </pre>
    </figure>
  );
}
