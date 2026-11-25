import "./gallery.css";
import { type ReactNode, StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Badge,
  Button,
  Chip,
  EmptyTile,
  LanguageBar,
  Pip,
  pipPoses,
  RephraseChips,
  type RepoDetail,
  RepoIcon,
  RepoPanel,
  type RepoVisual,
  Results,
  ScopeSwitch,
  SearchTile,
  type Sort,
  SortMenu,
  StarredWeeks,
  StatusLine,
  Tile,
  type TileProgress,
  type View,
  ViewToggle,
} from "../src/index.ts";
import { detailFor, icons, results, weeks } from "./data.ts";

// Browsing says nothing in the strip, and the rail alone shows an import or a read. An answer or a failure speaks.
const strips: ReadonlyArray<{ key: string; label?: string; phoneLabel?: string; progress?: TileProgress }> = [
  { key: "browsing" },
  { key: "importing", progress: { value: 1204, max: 1776, label: "progress", text: "1204 of 1,776" } },
  { key: "reading", progress: { value: 412, max: 1776, label: "progress", text: "412 of 1,776" } },
  {
    key: "partial",
    label: "found 3 so far",
    progress: { value: 412, max: 1776, label: "progress", text: "412 of 1,776" },
  },
  { key: "found", label: "found 6!" },
  { key: "missed", label: "found 2 · meaning search didn't answer", phoneLabel: "found 2 · meaning failed" },
  { key: "nothing yet", label: "nothing yet" },
  { key: "nothing", label: "nothing found" },
  { key: "failed", label: "sync didn't finish" },
];

const slots: ReadonlyArray<{ label: string; visual: RepoVisual }> = [
  { label: "own icon", visual: { kind: "icon", url: icons.ratatui, plate: "light", size: 128, letters: "ra" } },
  { label: "dark plate", visual: { kind: "icon", url: icons.ghost, plate: "dark", size: 128, letters: "gh" } },
  { label: "small icon", visual: { kind: "icon", url: icons.favicon, plate: "none", size: 16, letters: "ju" } },
  { label: "org avatar", visual: { kind: "avatar", url: "https://github.com/tokio-rs.png?size=88", letters: "to" } },
  { label: "monogram", visual: { kind: "monogram", letters: "ti" } },
  { label: "failed image", visual: { kind: "icon", url: "/missing.png", plate: "none", size: 128, letters: "fa" } },
];

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
  { value: "mine", label: "your stars", href: "#mine" },
  { value: "network", label: "network", href: "#network" },
  { value: "everyone", label: "everyone", href: "#everyone" },
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

function Gallery() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [view, setView] = useState<View>("tiles");
  const [scope, setScope] = useState("mine");
  const [query, setQuery] = useState("rust library for terminal dashboards");
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelRepo, setPanelRepo] = useState<RepoDetail>();
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  const [sort, setSort] = useState<Sort>("best");
  const controls = (
    <>
      <SortMenu value={sort} onValueChange={setSort} options={["best", "starred", "stars", "pushed"]} />
      <ViewToggle value={view} onValueChange={setView} />
    </>
  );

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

      <Section id="search" title="search · direction c">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <span className="flex items-center gap-1.5 font-display text-3xl font-semibold tracking-snug">
            <Pip pose="idle" size={40} />
            stargrep
          </span>
          <ScopeSwitch scopes={scopes} value={scope} onValueChange={setScope} />
          <span className="flex size-11 items-center justify-center rounded-full bg-avatar-2 font-display text-[16px] font-semibold text-ink">
            JP
          </span>
        </div>
        <SearchTile
          query={query}
          onQueryChange={setQuery}
          status={<StatusLine label="found 3 so far" />}
          controls={controls}
          progress={{ value: 412, max: 1776, label: "reading your stars", text: "412 of 1,776 read" }}
        />
        <Results
          view={view}
          groups={[
            {
              key: "words",
              heading: { label: "matching words", detail: "3 from all 1,776" },
              results: results.slice(1, 4),
            },
            {
              key: "meaning",
              heading: { label: "matching meaning", detail: "2 from the 412 read so far" },
              results: [results[0], results[4]].filter((result) => result !== undefined),
              pending: 2,
            },
          ]}
          onOpen={(result, link) => {
            setOpener(link);
            setPanelRepo(detailFor(result));
            setPanelOpen(true);
          }}
        />
        <RepoPanel repo={panelRepo} open={panelOpen} onOpenChange={setPanelOpen} returnFocus={opener} />
      </Section>

      <Section id="states" title="strip states">
        {strips.map((strip) => (
          <SearchTile
            key={strip.key}
            query=""
            placeholder="the rust tui library I starred last year"
            status={<StatusLine label={strip.label} phoneLabel={strip.phoneLabel} />}
            controls={controls}
            progress={strip.progress}
          />
        ))}
      </Section>

      <Section id="results" title="results, all read">
        <Results view={view} groups={[{ key: "all", results }]} />
        <Results view={view} groups={[{ key: "all", results: [], pending: 4 }]} />
      </Section>

      <Section id="empty" title="empty">
        <EmptyTile
          pose="unsure"
          ring={412 / 1776}
          heading="not in the 412 i've read yet"
          body="it might be in the 1,364 stars i'm still reading."
          meta="i'll search again when reading finishes · about 6 minutes left"
        />
        <EmptyTile
          pose="sad"
          heading="nothing in all 1,776 stars"
          body="i've read all of them, and none matches that. maybe you starred it under different words. try one of these:"
        >
          <RephraseChips phrases={["record terminal", "terminal sessions", "sessions gifs"]} onPick={() => {}} />
        </EmptyTile>
      </Section>

      <Section id="icons" title="icon slot">
        <ul className="flex flex-wrap gap-gap">
          {slots.map(({ label, visual }) => (
            <li key={label} className="flex flex-col items-center gap-2">
              <RepoIcon visual={visual} />
              <span className="view-list">
                <RepoIcon visual={visual} />
              </span>
              <span className="font-sans text-sm text-muted-foreground">{label}</span>
            </li>
          ))}
        </ul>
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
          <Button>follow</Button>
          <Button variant="secondary">add to collection</Button>
          <Button variant="ghost">search everyone instead</Button>
          <Button size="lg">claim</Button>
          <Button variant="secondary" size="lg">
            sign in with GitHub
          </Button>
          <Badge>archived</Badge>
          <Chip type="button">Rust 42%</Chip>
          <Chip type="button" active>
            all
          </Chip>
          <Chip type="button" tone="card">
            terminal recorder
          </Chip>
        </div>
      </Section>

      <Section id="pip" title="pip poses">
        <ul className="flex flex-wrap gap-gap">
          {pipPoses.map((pose) => (
            <li key={pose}>
              <Tile className="flex w-[180px] flex-col items-center gap-3">
                <Pip pose={pose} size={120} />
                <Pip pose={pose} size={32} />
                <span className="font-sans text-sm text-muted-foreground">{pose}</span>
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
