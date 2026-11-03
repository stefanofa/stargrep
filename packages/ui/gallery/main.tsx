import "./gallery.css";
import { type ReactNode, StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Badge,
  Button,
  DeepSearch,
  type Filter,
  LanguageBar,
  Mascot,
  moods,
  type RepoDetail,
  RepoPanel,
  Results,
  ResultsSummary,
  ScopeSwitch,
  SearchTile,
  Skeleton,
  type Sort,
  SortMenu,
  StarredWeeks,
  SyncProgress,
  Tile,
  useStoredView,
  ViewToggle,
} from "../src/index.ts";
import { detailFor, results, weeks } from "./data.ts";

const themes = ["system", "light", "dark"] as const;
type Theme = (typeof themes)[number];

const applyTheme = (theme: Theme) => {
  document.documentElement.classList.remove("light", "dark");
  if (theme !== "system") document.documentElement.classList.add(theme);
};

const initialTheme = (): Theme => {
  const requested = new URLSearchParams(location.search).get("theme");
  const theme = themes.find((option) => option === requested) ?? "system";
  applyTheme(theme);
  return theme;
};

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="flex flex-col gap-gap">
      <h2 id={`${id}-title`} className="font-display text-2xl font-semibold tracking-snug">
        {title}
      </h2>
      {children}
    </section>
  );
}

const scopes = [
  { value: "mine", label: "Your stars", href: "#mine" },
  { value: "network", label: "Network", href: "#network" },
  { value: "everyone", label: "Everyone", href: "#everyone" },
];

const swatches = [
  "background",
  "foreground",
  "card",
  "secondary-foreground",
  "muted-foreground",
  "muted",
  "border",
  "primary",
  "accent",
  "accent-soft",
  "accent-strong",
  "highlight",
  "highlight-edge",
  "success",
  "warning",
  "destructive",
];

const typeScale = [
  ["text-label uppercase tracking-caps font-sans font-semibold", "label 11"],
  ["text-sm font-sans", "sm 13"],
  ["text-base font-sans", "base 15"],
  ["text-lg font-sans", "lg 17"],
  ["text-xl font-sans font-medium", "xl 24"],
  ["text-2xl font-display font-semibold", "2xl 30"],
  ["text-3xl font-display font-semibold", "3xl 36"],
  ["text-display font-display font-semibold tracking-tight", "display 52"],
  ["text-hero leading-none font-display font-semibold tracking-tight", "412"],
] as const;

const rerankMs = 1000;

function useRerank() {
  const [deep, setDeep] = useState(false);
  const [reranking, setReranking] = useState(false);
  useEffect(() => {
    if (!reranking) return;
    const settled = new AbortController();
    AbortSignal.timeout(rerankMs).addEventListener("abort", () => setReranking(false), { signal: settled.signal });
    return () => settled.abort();
  }, [reranking]);
  const toggle = (next: boolean) => {
    setDeep(next);
    setReranking(next);
  };
  return { deep, reranking, toggle };
}

function Gallery() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [view, setView] = useStoredView();
  const [scope, setScope] = useState("mine");
  const [filters, setFilters] = useState<Filter[]>([
    { id: "lang", label: "Rust" },
    { id: "starred", label: "Starred in 2025" },
    { id: "topic", label: "Topic: TUI" },
  ]);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelRepo, setPanelRepo] = useState<RepoDetail>();
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  const [sort, setSort] = useState<Sort>("starred");
  const deepSearch = useRerank();

  return (
    <main className="mx-auto flex w-full max-w-page flex-col gap-16 px-4 pt-12 pb-24 min-[1232px]:px-0">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="font-display text-3xl font-semibold tracking-snug">stargrep design system</h1>
        <fieldset className="flex gap-1 rounded-full bg-card p-1">
          <legend className="sr-only">Theme</legend>
          {themes.map((option) => (
            <Button
              key={option}
              variant={theme === option ? "accent" : "ghost"}
              aria-pressed={theme === option}
              onClick={() => {
                applyTheme(option);
                setTheme(option);
              }}
            >
              {option}
            </Button>
          ))}
        </fieldset>
      </header>

      <Section id="search" title="search · artboard 02 and 03">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <span className="font-display text-3xl font-semibold tracking-snug">stargrep</span>
          <ScopeSwitch scopes={scopes} value={scope} onValueChange={setScope} />
          <span className="flex size-11 items-center justify-center rounded-full bg-avatar-2 font-display text-[16px] font-semibold text-ink">
            JP
          </span>
        </div>
        <SearchTile
          defaultQuery="rust library for terminal dashboards I starred last year"
          filters={filters}
          onRemoveFilter={(removed) => setFilters((current) => current.filter((filter) => filter.id !== removed.id))}
        />
        <div className="flex justify-end">
          <SortMenu value={sort} onValueChange={setSort} />
        </div>
        <Results
          view={view}
          results={results}
          onOpen={(result, link) => {
            setOpener(link);
            setPanelRepo(detailFor(result));
            setPanelOpen(true);
          }}
          summary={
            <ResultsSummary
              heading="found 5!"
              detail="of your 2,431 stars"
              mood="happy"
              motion="blink"
              reranking={deepSearch.reranking}
              controls={
                <>
                  <DeepSearch checked={deepSearch.deep} onCheckedChange={deepSearch.toggle} />
                  <ViewToggle value={view} onValueChange={setView} />
                </>
              }
            />
          }
        />
        <RepoPanel
          repo={panelRepo}
          open={panelOpen}
          onOpenChange={setPanelOpen}
          onAddToCollection={() => {}}
          returnFocus={opener}
        />
      </Section>

      <Section id="states" title="states">
        <Results
          view="tiles"
          results={results.slice(0, 3)}
          pending={2}
          summary={
            <ResultsSummary
              heading="syncing"
              detail={<SyncProgress done={1204} total={2431} timeLeft="about 20 seconds left" />}
              mood="delighted"
            />
          }
        />
        <Results
          view="tiles"
          results={[]}
          pending={6}
          summary={
            <ResultsSummary
              heading={
                <>
                  <span className="sr-only">searching</span>
                  <Skeleton aria-hidden className="h-11 w-[236px]" />
                </>
              }
              detail={<Skeleton className="mt-2 h-3 w-[148px]" />}
              mood="searching"
            />
          }
        />
        <Tile className="relative flex min-h-[264px] flex-col justify-between gap-6 px-12 pt-10">
          <h2 className="font-display text-display leading-[56px] font-semibold tracking-tight max-sm:text-3xl">
            nothing matches that
          </h2>
          <p className="flex flex-wrap items-center gap-4 font-sans text-lg text-secondary-foreground">
            <span>
              <strong className="font-semibold text-foreground">12 stars</strong> hidden by{" "}
              <strong className="font-semibold text-foreground">starred in 2019</strong>
            </span>
            <Button variant="accent" size="lg">
              remove that filter
            </Button>
          </p>
          <Mascot mood="flat" size={220} className="absolute top-8 right-[88px] -rotate-12 max-md:hidden" />
        </Tile>
        <Tile className="relative flex min-h-[200px] flex-col justify-center gap-2 px-12">
          <h2 className="font-display text-3xl font-semibold tracking-snug">github needs a breather.</h2>
          <p className="font-sans text-lg text-secondary-foreground">try again in 2 minutes</p>
          <Mascot mood="surprised" size={160} className="absolute top-5 right-[88px] rotate-[10deg] max-md:hidden" />
        </Tile>
      </Section>

      <Section id="tiles" title="tile variants">
        <div className="grid grid-cols-1 gap-gap sm:grid-cols-2 lg:grid-cols-4">
          <Tile>
            <p className="font-display text-2xl font-semibold">default</p>
          </Tile>
          <Tile variant="highlight">
            <p className="font-display text-2xl font-semibold">highlight</p>
            <p className="font-sans text-base text-secondary-foreground">
              light ink and <mark>matches</mark> in both themes
            </p>
          </Tile>
          <Tile variant="quiet" className="flex flex-col items-start gap-2">
            <Badge>sponsored</Badge>
            <p className="font-display text-2xl font-semibold">quiet</p>
          </Tile>
          <Tile variant="archived" className="flex flex-col items-start gap-2">
            <Badge>archived</Badge>
            <p className="font-display text-2xl font-semibold text-muted-foreground">archived</p>
          </Tile>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button>Follow</Button>
          <Button variant="secondary">Add to collection</Button>
          <Button variant="ghost">search everyone instead</Button>
          <Button size="lg">Claim</Button>
          <Button variant="secondary" size="lg">
            Sign in with GitHub
          </Button>
          <Badge>archived</Badge>
          <Badge variant="chip">Rust</Badge>
        </div>
      </Section>

      <Section id="mascot" title="mascot moods">
        <ul className="flex flex-wrap gap-gap">
          {moods.map((mood) => (
            <li key={mood}>
              <Tile className="flex w-[180px] flex-col items-center gap-3">
                <Mascot mood={mood} size={120} />
                <span className="font-sans text-sm text-muted-foreground">{mood}</span>
              </Tile>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="profile" title="profile pieces">
        <Tile className="flex flex-col gap-6">
          <LanguageBar
            languages={[
              { name: "Rust", share: 0.42 },
              { name: "TypeScript", share: 0.27 },
              { name: "Go", share: 0.11 },
            ]}
          />
          <StarredWeeks weeks={weeks} summary="Starred most in March and November, about 4 stars a week" />
        </Tile>
      </Section>

      <Section id="tokens" title="tokens">
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
          {swatches.map((name) => (
            <li key={name} className="flex flex-col gap-1.5">
              <span
                className="h-14 rounded-sm border-[1.5px] border-border"
                style={{ backgroundColor: `var(--color-${name})` }}
              />
              <span className="font-sans text-sm text-muted-foreground">{name}</span>
            </li>
          ))}
        </ul>
        <ul className="flex flex-col gap-2">
          {typeScale.map(([className, sample]) => (
            <li key={sample} className={className}>
              {sample}
            </li>
          ))}
        </ul>
      </Section>
    </main>
  );
}

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <StrictMode>
      <Gallery />
    </StrictMode>,
  );
