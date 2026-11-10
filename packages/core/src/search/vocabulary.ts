// The planner's schema and guards keep today's kinds and language names, with node and nodejs on JavaScript. The kinds
// are part of PlannerPrompt.version, which keys the plan and answer caches. Filters read the audited closed values in
// @stargrep/knowledge/registry, through the query compiler.
export const plannedKinds = [
  "app",
  "library",
  "framework",
  "cli",
  "plugin",
  "template",
  "list",
  "learning",
  "dataset",
  "model",
  "config",
  "other",
] as const;

// Each language name with the other words that name it.
const languages: Readonly<Record<string, ReadonlyArray<string>>> = {
  abap: [],
  ada: [],
  apex: [],
  assembly: ["asm"],
  astro: [],
  c: [],
  "c#": ["csharp"],
  "c++": ["cpp"],
  clojure: [],
  cobol: [],
  coffeescript: [],
  "common lisp": [],
  crystal: [],
  css: [],
  d: [],
  dart: [],
  delphi: [],
  elixir: [],
  elm: [],
  "emacs lisp": ["elisp"],
  erlang: [],
  "f#": ["fsharp"],
  fortran: [],
  gleam: [],
  go: ["golang"],
  groovy: [],
  haskell: [],
  hcl: [],
  html: [],
  java: [],
  javascript: ["js", "node", "nodejs"],
  julia: [],
  "jupyter notebook": [],
  kotlin: [],
  lua: [],
  matlab: [],
  mdx: [],
  nim: [],
  nix: [],
  "node.js": ["node", "nodejs"],
  "objective-c": ["objc"],
  ocaml: [],
  pascal: [],
  perl: [],
  php: [],
  powershell: [],
  prolog: [],
  purescript: [],
  python: ["py"],
  r: [],
  racket: [],
  rescript: [],
  ruby: [],
  rust: [],
  scala: [],
  scheme: [],
  shell: ["bash", "zsh"],
  smalltalk: [],
  solidity: [],
  sql: [],
  svelte: [],
  swift: [],
  tcl: [],
  typescript: ["ts"],
  v: [],
  vala: [],
  verilog: [],
  vhdl: [],
  "vim script": ["vimscript", "viml"],
  "visual basic": ["vb"],
  vue: [],
  zig: [],
};

const exclusivityWords = ["only", "just", "not", "except", "excluding", "exclusively"];

const metricAndDateWords = [
  "more",
  "less",
  "fewer",
  "than",
  "over",
  "under",
  "least",
  "most",
  "since",
  "before",
  "after",
  "last",
  "recent",
  "recently",
  "new",
  "newest",
  "old",
  "oldest",
  "year",
  "years",
  "month",
  "months",
  "week",
  "weeks",
  "day",
  "days",
  "ago",
  "today",
  "yesterday",
  "starred",
  "star",
  "stars",
  "fork",
  "forks",
  "contributor",
  "contributors",
  "commit",
  "commits",
  "release",
  "releases",
  "best",
  "top",
  "popular",
  "growing",
  "active",
  "maintained",
  "archived",
];

const licenseWords = [
  "license",
  "licensed",
  "licence",
  "mit",
  "apache",
  "gpl",
  "lgpl",
  "agpl",
  "bsd",
  "mpl",
  "isc",
  "unlicense",
];

const kindWords = plannedKinds
  .filter((kind) => kind !== "other")
  .flatMap((kind) => [kind, kind.endsWith("y") ? `${kind.slice(0, -1)}ies` : `${kind}s`]);

const connectives = [
  "a",
  "an",
  "the",
  "and",
  "or",
  "of",
  "in",
  "on",
  "at",
  "to",
  "from",
  "by",
  "for",
  "about",
  "into",
  "with",
  "without",
  "no",
  "like",
  "alternative",
  "alternatives",
  "similar",
  "instead",
  "replacement",
  "replace",
  "my",
  "me",
  "i",
  "we",
  "our",
  "you",
  "that",
  "which",
  "who",
  "what",
  "where",
  "when",
  "how",
];

const exclusive = new Set(exclusivityWords);
const filterWords = new Set([...exclusivityWords, ...metricAndDateWords, ...licenseWords, ...kindWords]);
const connectiveWords = new Set(connectives);
const spokenNames = Object.entries(languages).flatMap(([name, aliases]) => [name, ...aliases]);

const words = (query: string) =>
  query
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .map((word) => word.replace(/\.+$/, ""))
    .filter((word) => word.length > 0);

const says = (query: string, name: string) => ` ${words(query).join(" ")} `.includes(` ${name} `);

export const restrictsKind = (query: string): boolean => words(query).some((word) => exclusive.has(word));

const fold = (text: string) => text.normalize("NFKC").toLowerCase().trim();

const scripts = ["Latin", "Cyrillic", "Greek", "Han", "Hiragana", "Katakana", "Hangul", "Thai", "Arabic", "Hebrew"];
const unspacedScripts = new Set(["Han", "Hiragana", "Katakana", "Thai"]);
const scriptPatterns = scripts.map((script) => [script, new RegExp(`^\\p{Script=${script}}$`, "u")] as const);
const wordCharacter = /^[\p{L}\p{N}]$/u;
const nonLatinLetter = /(?=\p{L})\P{Script=Latin}/u;

const scriptOf = (character: string) => scriptPatterns.find(([, pattern]) => pattern.test(character))?.[0] ?? "Other";

const joins = (edge: string | undefined, neighbor: string | undefined) =>
  edge !== undefined &&
  neighbor !== undefined &&
  wordCharacter.test(edge) &&
  wordCharacter.test(neighbor) &&
  !unspacedScripts.has(scriptOf(edge)) &&
  scriptOf(edge) === scriptOf(neighbor);

export const appearsIn = (query: string, phrase: string): boolean => {
  const needle = fold(phrase);
  const haystack = [...fold(query)];
  const characters = [...needle];
  if (characters.length === 0) return false;
  for (let start = 0; start + characters.length <= haystack.length; start++) {
    if (haystack.slice(start, start + characters.length).join("") !== needle) continue;
    const before = haystack[start - 1];
    const after = haystack[start + characters.length];
    if (!joins(characters[0], before) && !joins(characters.at(-1), after)) return true;
  }
  return false;
};

export const namesLanguage = (query: string, stated: { readonly language: string; readonly said: string }) => {
  const said = fold(stated.said);
  const language = fold(stated.language);
  return (
    appearsIn(query, stated.said) &&
    (said === language || (languages[language] ?? []).includes(said) || nonLatinLetter.test(said))
  );
};

export const mentionsFilter = (query: string): boolean =>
  words(query).some((word) => filterWords.has(word) || /^[0-9]/.test(word)) ||
  spokenNames.some((name) => says(query, name));

export const isConnective = (word: string): boolean => connectiveWords.has(word.toLowerCase());

export const isFilterWord = (word: string): boolean => filterWords.has(word.toLowerCase());
