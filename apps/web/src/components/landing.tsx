import { highlight, Pip, RepoIcon, Tile } from "@stargrep/ui";
import { Link } from "@tanstack/react-router";
import { avatarOf } from "../lib/avatar.ts";
import { type Example, type ExampleRepo, exampleOf } from "../lib/example.ts";
import type { LandingData, Session } from "../lib/page-data.ts";
import { api } from "../lib/rpc.ts";
import { loginPage } from "../lib/stars-route.ts";
import { formatCount } from "../lib/whose.ts";
import { LoginField } from "./login-field.tsx";
import { SignInButton } from "./sign-in-button.tsx";

// The demo account's answer to its question is the one search the landing asks for, so the model work a visit can cause
// is bounded to it, and the API's answer cache keeps it for every visitor.
export const landingFor = async ({ config, site }: Session): Promise<LandingData> => {
  const client = api();
  const { demoLogin: login, demoQuery: query } = config;
  const [results, sync] = await Promise.all([
    client.search({ scope: { kind: "stars", login }, q: query }).then(
      (answer) => answer.results,
      () => null,
    ),
    client.syncStatus({ login }).catch(() => null),
  ]);
  return { kind: "landing", site, example: exampleOf({ login, query, starred: sync?.starredTotal ?? null }, results) };
};

// People a visitor can look at first, each with one of the three topics most of their stars carry, as stargrep counted
// them on 2026-11-25, short enough to sit beside the handle in a phone's half-width chip. Phones show the first four.
const faces = [
  { login: "karpathy", topic: "llm" },
  { login: "simonw", topic: "python" },
  { login: "t3dotgg", topic: "react" },
  { login: "antfu", topic: "vue" },
  { login: "steipete", topic: "swift" },
  { login: "sindresorhus", topic: "nodejs" },
] as const;

const phoneFaces = 4;

function Face({ login, topic, phone }: { login: string; topic: string; phone: boolean }) {
  return (
    <li className={phone ? "min-w-0" : "min-w-0 max-sm:hidden"}>
      <Link
        {...loginPage(login)}
        className="flex min-w-0 items-center gap-2 rounded-full bg-card py-[5px] pr-2.5 pl-[5px] font-sans transition-colors duration-120 hover:bg-accent-soft sm:pr-3.5"
      >
        <img
          src={avatarOf(login, 30)}
          alt=""
          width={30}
          height={30}
          className="size-[30px] shrink-0 rounded-full bg-accent-soft outline-1 -outline-offset-1 outline-image-edge"
        />
        <span className="truncate text-meta font-semibold text-foreground sm:text-[15px]">{`@${login}`}</span>
        <span className="min-w-0 truncate text-sm text-muted-foreground sm:text-meta">{topic}</span>
      </Link>
    </li>
  );
}

function Faces() {
  return (
    <nav aria-label="Look at someone" className="flex flex-col gap-4 pt-1 sm:gap-3 sm:pt-0">
      <h2 className="font-sans text-label font-semibold text-muted-foreground uppercase">or look at someone</h2>
      <ul className="grid grid-cols-2 gap-2 sm:flex sm:max-w-[740px] sm:flex-wrap">
        {faces.map((face, index) => (
          <Face key={face.login} {...face} phone={index < phoneFaces} />
        ))}
        <li className="max-sm:hidden">
          <Link
            to="/people"
            className="flex h-full items-center rounded-full px-2.5 font-sans text-[15px] font-medium text-accent-strong hover:underline hover:decoration-1 hover:underline-offset-4"
          >
            more in discover →
          </Link>
        </li>
      </ul>
    </nav>
  );
}

// What signing in gets you, said once. Every other ask to sign in leads to the same GitHub round trip.
function JoinTile() {
  return (
    <Tile
      variant="highlight"
      className="flex items-center justify-between gap-3 py-[18px] pr-[18px] pl-[22px] lg:w-[400px] lg:shrink-0 lg:flex-col lg:items-start lg:gap-7 lg:px-[30px] lg:py-7"
    >
      <div
        aria-hidden
        className="absolute top-[26px] right-[26px] flex size-[104px] items-center justify-center rounded-full bg-plate max-lg:hidden"
      >
        <Pip size={78} />
      </div>
      <div className="flex min-w-0 flex-col gap-[3px] lg:contents">
        <h2 className="font-display text-[22px] leading-[26px] font-semibold text-foreground text-wrap lg:w-[240px] lg:text-[34px] lg:leading-[38px] lg:tracking-snug">
          get your own page
        </h2>
        <p className="font-sans text-sm leading-[17px] text-secondary-foreground lg:hidden">
          your stars, your taste, people you follow
        </p>
        <ul className="flex flex-col gap-2 font-sans text-[16px] leading-[22px] text-secondary-foreground max-lg:hidden">
          <li>search your own stars</li>
          <li>see your taste over the years</li>
          <li>follow people and see what they star</li>
        </ul>
      </div>
      <SignInButton
        variant="primary"
        size="lg"
        className="h-10 px-4 text-meta lg:h-12 lg:px-[22px] lg:text-[16px]"
        markClassName="size-[18px] max-lg:hidden"
        label={
          <>
            <span className="lg:hidden">sign in</span>
            <span className="max-lg:hidden">sign in with GitHub</span>
          </>
        }
      />
    </Tile>
  );
}

function ExampleRepoTile({ repo }: { repo: ExampleRepo }) {
  return (
    <li className="flex min-w-0 flex-col gap-2.5 squircle rounded-md bg-background px-5 pt-5 pb-[18px]">
      <div className="flex min-w-0 items-center gap-2.5">
        <RepoIcon visual={repo.visual} size="row" />
        <span className="truncate font-display text-[21px] leading-6 font-semibold text-foreground">{repo.name}</span>
      </div>
      <p className="line-clamp-3 font-sans text-meta leading-5 text-secondary-foreground">
        {highlight(repo.reason, repo.matches)}
      </p>
    </li>
  );
}

// A search someone could run, framed as that person's: a cached answer the server paints, and one link to their page
// with that search. It has no field, so nobody types into it.
function ExampleTile({ example: { login, query, starred, answer } }: { example: Example }) {
  return (
    <Tile className="group flex flex-col gap-3 px-5 py-[18px] has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-offset-2 has-[a:focus-visible]:outline-ring sm:gap-5 sm:px-7 sm:pt-[26px] sm:pb-7">
      <div className="flex items-center justify-between gap-5">
        <div className="grid min-w-0 grid-cols-[32px_1fr] items-center gap-x-2.5 gap-y-3 [grid-template-areas:'face_line'_'query_query'] sm:grid-cols-[48px_1fr] sm:gap-x-3.5 sm:gap-y-0.5 sm:[grid-template-areas:'face_line'_'face_query']">
          <img
            src={avatarOf(login, 48)}
            alt=""
            width={48}
            height={48}
            className="[grid-area:face] size-8 rounded-full bg-accent-soft outline-1 -outline-offset-1 outline-image-edge sm:size-12"
          />
          <p className="[grid-area:line] font-sans text-sm text-muted-foreground sm:text-meta">
            for example, in <strong className="font-semibold text-foreground">{`@${login}'s`}</strong>{" "}
            {starred !== null && <span className="max-sm:hidden">{formatCount(starred)} </span>}
            stars
          </p>
          <h2 className="[grid-area:query] font-display text-[22px] leading-[26px] font-semibold text-foreground sm:text-name sm:tracking-snug">
            <Link
              {...loginPage(login)}
              search={{ q: query }}
              className="outline-none after:absolute after:inset-0 after:rounded-[inherit]"
            >
              {`"${query}"`}
            </Link>
            {answer !== null && (
              <span className="font-sans text-base font-normal tracking-normal text-muted-foreground max-sm:hidden">
                {` found ${formatCount(answer.found)}!`}
              </span>
            )}
          </h2>
        </div>
        <span
          aria-hidden
          className="flex h-[42px] shrink-0 items-center rounded-full bg-accent-soft px-[18px] font-sans text-[15px] font-semibold text-foreground transition-colors duration-120 group-hover:bg-accent/40 max-sm:hidden"
        >
          {`open @${login}'s page →`}
        </span>
      </div>
      {answer !== null && (
        <ul className="grid grid-cols-2 gap-4 max-sm:hidden lg:grid-cols-4">
          {answer.repos.map((repo) => (
            <ExampleRepoTile key={`${repo.owner}/${repo.name}`} repo={repo} />
          ))}
        </ul>
      )}
    </Tile>
  );
}

// A visitor's first look: one field for whose stars, a few people to look at, what an account gets, and an example.
export function Landing({ example }: { example: Example }) {
  return (
    <div className="flex flex-col gap-4 lg:gap-gap">
      <section className="flex flex-col gap-4 lg:flex-row lg:gap-gap lg:pt-6">
        <div className="flex min-w-0 flex-1 flex-col gap-4 sm:gap-[22px] lg:pt-2 lg:pr-2 lg:pl-1">
          <h1 className="font-display text-[34px] leading-[37px] font-semibold tracking-tight text-wrap sm:text-[56px] sm:leading-[58px] sm:tracking-[-0.025em]">
            search anyone's starred GitHub repos in plain words
          </h1>
          <LoginField className="sm:max-w-[600px]" />
          <Faces />
        </div>
        <JoinTile />
      </section>
      <ExampleTile example={example} />
    </div>
  );
}
