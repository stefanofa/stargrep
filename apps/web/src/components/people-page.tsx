import { Button, ChevronIcon, Chip, cn, EmptyTile, RadioMenu } from "@stargrep/ui";
import { getRouteApi, Link, useLoaderData, useRouter } from "@tanstack/react-router";
import { type FormEvent, useId, useState } from "react";
import { useFollows } from "../lib/follows.ts";
import { type PeopleAsked, usePeoplePages } from "../lib/people.ts";
import type { People, PeopleSort } from "../lib/rpc.ts";
import { loginPage, typedLogin, typedLoginParam } from "../lib/stars-route.ts";
import { wallNow } from "../lib/wall-clock.ts";
import { formatCount } from "../lib/whose.ts";
import { DiscoverHead, discoverBody, fieldBox } from "./discover-head.tsx";
import { Page } from "./page.tsx";
import { PersonCard, PersonCardPlaceholder } from "./person-card.tsx";

export { firstPeople } from "../lib/people.ts";

const route = getRouteApi("/people");

const grid = "grid gap-3 sm:grid-cols-2 sm:gap-gap lg:grid-cols-4";
const pageSize = 24;
const chip = "h-[30px] shrink-0 px-[13px]";

// How many of the topics the most people are into get a chip of their own. The rest wait in the menu.
const quickTopics = 4;

// A login someone knows, straight to their stars. Before the page hydrates, the browser submits the form itself and /
// sends the login on to its page.
function GoToSomeone() {
  const navigate = route.useNavigate();
  const field = useId();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const login = typedLogin(String(new FormData(form).get(typedLoginParam) ?? ""));
    if (login === undefined) {
      form.reportValidity();
      return;
    }
    form.reset();
    navigate(loginPage(login));
  };
  return (
    <form action="/" method="get" onSubmit={submit} aria-label="Whose stars" className={cn(fieldBox, "pr-1.5")}>
      <label htmlFor={field} className="text-muted-foreground select-none">
        github.com/<span className="sr-only">username</span>
      </label>
      <input
        id={field}
        name={typedLoginParam}
        placeholder="anyone"
        required
        pattern={String.raw`\s*@?[A-Za-z\d][A-Za-z\d\-]{0,38}\s*`}
        title="a GitHub username, such as octocat"
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="go"
        className="h-full min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground/70"
      />
      <Button type="submit" variant="secondary">
        go
      </Button>
    </form>
  );
}

const sortLabels: ReadonlyArray<readonly [PeopleSort, string]> = [
  ["most-like-you", "most like you"],
  ["recently-active", "recently active"],
];

// A viewer whose stars have synced can put the people most like them first. Anyone else gets the latest star first,
// and the list says so.
function Sorts({ page }: { page: People }) {
  if (!page.people.some((person) => person.shared !== null))
    return <p className="font-sans text-meta text-muted-foreground">latest star first</p>;
  return (
    <nav aria-label="Sort people" className="flex gap-2">
      {sortLabels.map(([sort, label]) => (
        <Chip
          key={sort}
          className={chip}
          active={page.sort === sort}
          render={
            <Link
              to="."
              search={(previous) => ({ ...previous, sort })}
              aria-current={page.sort === sort ? "true" : undefined}
            />
          }
        >
          {label}
        </Chip>
      ))}
    </nav>
  );
}

// The topics the most people are into, each a chip, and every other in a menu. A chip that is on takes its topic back
// off. The menu names a topic only when no chip shows it.
function Into({ topics, topic }: { topics: People["topics"]; topic: string | undefined }) {
  const navigate = route.useNavigate();
  const quick = topics.slice(0, quickTopics).map((each) => each.topic);
  const other = topic !== undefined && !quick.includes(topic);
  if (topics.length === 0 && topic === undefined) return null;
  return (
    <nav
      aria-label="people into a topic"
      className="flex items-center gap-2 max-sm:-mx-4 max-sm:overflow-x-auto max-sm:px-4 max-sm:[mask-image:linear-gradient(to_left,transparent,#000_16px)] max-sm:[scrollbar-width:none]"
    >
      <span className="shrink-0 pr-1 font-sans text-meta text-muted-foreground">into</span>
      {quick.map((name) => (
        <Chip
          key={name}
          className={chip}
          active={topic === name}
          render={
            <Link
              to="."
              search={(previous) => ({ ...previous, topic: topic === name ? undefined : name })}
              activeOptions={{ explicitUndefined: true }}
              aria-current={topic === name ? "true" : undefined}
            />
          }
        >
          {name}
        </Chip>
      ))}
      <RadioMenu
        label="Pick a topic"
        trigger={<Chip className={cn(chip, "gap-1 pr-2.5")} active={other} />}
        choices={[
          { value: "", label: "any topic" },
          ...topics.map(({ topic: name, people }) => ({
            value: name,
            label: (
              <span className="flex flex-1 items-baseline justify-between gap-3">
                {name}
                <span className="font-normal text-muted-foreground tabular-nums">{formatCount(people)}</span>
              </span>
            ),
          })),
        ]}
        value={topic ?? ""}
        onValueChange={(next) =>
          navigate({ to: ".", search: (previous) => ({ ...previous, topic: next || undefined }) })
        }
      >
        {other ? topic : "any topic"}
        <ChevronIcon className="size-3.5 text-secondary-foreground" />
      </RadioMenu>
    </nav>
  );
}

function List({ first, asked, signedIn }: { first: People; asked: PeopleAsked; signedIn: boolean }) {
  const { shown, showMore } = usePeoplePages(first, asked);
  const follows = useFollows(signedIn);
  const [at] = useState(wallNow);
  const left = first.total - shown.people.length;
  return (
    <>
      <ol aria-label="people" aria-busy={shown.more === "asking" || undefined} className={grid}>
        {shown.people.map((person) => (
          <li key={person.login} className="flex min-w-0 flex-col *:flex-1">
            <PersonCard person={person} following={follows.isFollowing(person.login)} at={at} />
          </li>
        ))}
        {shown.more === "asking" &&
          Array.from({ length: Math.max(1, Math.min(pageSize, left)) }, (_, index) => (
            <li key={index} className="flex flex-col *:flex-1">
              <PersonCardPlaceholder />
            </li>
          ))}
      </ol>
      {shown.next !== null && shown.more !== "asking" && (
        <div className="flex flex-col items-center gap-2">
          {shown.more === "failed" && (
            <p role="status" className="font-sans text-meta text-muted-foreground">
              couldn't load more people.
            </p>
          )}
          <Button variant="secondary" className="px-[18px]" onClick={showMore}>
            {shown.more === "failed" ? "try again" : "show more"}
          </Button>
        </div>
      )}
    </>
  );
}

// The list didn't load. Trying again runs this page's loader alone, since the root's runs only on the server.
function Unloaded() {
  const router = useRouter();
  const [retrying, setRetrying] = useState(false);
  return (
    <EmptyTile pose="scared" heading="couldn't load people" body="stargrep couldn't read the people list just now.">
      <Button
        variant="primary"
        size="lg"
        className="mt-2"
        disabled={retrying}
        onClick={() => {
          setRetrying(true);
          router.invalidate({ filter: (match) => match.routeId === "/people" }).finally(() => setRetrying(false));
        }}
      >
        try again
      </Button>
    </EmptyTile>
  );
}

function Found({ page, asked, signedIn }: { page: People; asked: PeopleAsked; signedIn: boolean }) {
  // The list fills in overnight, so a new stage starts with nobody on it.
  if (page.people.length === 0 && asked.topic === undefined)
    return (
      <EmptyTile
        pose="unsure"
        heading="nobody here yet"
        body="the people list fills in overnight. until then, type any GitHub username above."
      />
    );
  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:px-1">
        <Sorts page={page} />
        <Into topics={page.topics} topic={asked.topic} />
      </div>
      {page.people.length === 0 ? (
        <EmptyTile
          pose="unsure"
          heading={`nobody here is into ${asked.topic} yet`}
          body="pick another topic, or any."
        />
      ) : (
        <List first={page} asked={asked} signedIn={signedIn} />
      )}
    </>
  );
}

// Discover's people: everyone on the people list, a page at a time, in an order and into a topic the address names,
// under a field that goes straight to anyone's stars.
export function PeoplePage() {
  const { viewer } = useLoaderData({ from: "__root__" });
  const { first, asked } = route.useLoaderData();
  return (
    <Page here="discover">
      <div className={discoverBody}>
        <DiscoverHead segment="people">
          <GoToSomeone />
        </DiscoverHead>
        {first.kind === "failed" ? <Unloaded /> : <Found page={first.page} asked={asked} signedIn={viewer !== null} />}
      </div>
    </Page>
  );
}
