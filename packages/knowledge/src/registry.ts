import * as Schema from "effect/Schema";
import { type LabelKey, labelKey } from "./label-key.ts";

export interface ClosedValue<Id extends string> {
  readonly id: Id;
  readonly label: string;
  // Spellings of this value. An alias is a spelling, never a narrower or neighboring concept: "tui" is not the
  // terminal. Every label key of an id, label, or alias belongs to exactly one closed value.
  readonly aliases: ReadonlyArray<string>;
  // Names that imply this value without being a spelling of it, such as Chrome for the browser. They resolve only in a
  // role that accepts nothing but this dimension, reserve nothing, and never reach the query compiler, so Chrome stays
  // free to be a subject.
  readonly impliedBy: ReadonlyArray<string>;
  // A filter on this value also matches these ids of the same dimension, as JavaScript matches TypeScript.
  readonly expands: ReadonlyArray<string>;
}

const value = <const Id extends string>(
  id: Id,
  label: string,
  aliases: ReadonlyArray<string> = [],
  impliedBy: ReadonlyArray<string> = [],
  expands: ReadonlyArray<string> = [],
): ClosedValue<Id> => ({ id, label, aliases, impliedBy, expands });

// A repo the model cannot place gets no kind, so there is no "other". A kind the model names in other words, such as
// compiler or tool, is an impliedBy name rather than an alias, so the word stays free to be a subject. The id
// system-software reserves no bare "system", which would split a query such as "content management system".
export const kinds = [
  value("app", "app", ["apps", "application", "applications"], ["platform", "shell"]),
  value("library", "library", ["libraries", "lib", "libs"], ["sdk", "design system", "package", "shader"]),
  value("framework", "framework", ["frameworks"]),
  value(
    "cli",
    "CLI",
    ["clis", "command line tool", "command-line tool"],
    ["script", "shell script", "tool", "installer"],
  ),
  // A theme installs into a host, such as Hugo, WordPress, or VS Code, and updates from its upstream, as a plugin does.
  // A template is copied once and then owned.
  value(
    "plugin",
    "plugin",
    ["plugins", "extension", "extensions"],
    ["skill", "action", "github action", "userscript", "user script", "theme"],
  ),
  value("template", "template", ["templates", "starter", "boilerplate"]),
  value("list", "list", ["lists", "awesome list"]),
  value(
    "learning",
    "learning resource",
    ["tutorial", "course", "examples"],
    ["book", "books", "sample", "learning path"],
  ),
  value("dataset", "dataset", ["datasets"], ["benchmark"]),
  value("model", "model", ["models", "model weights"]),
  value("config", "config", ["dotfiles", "configuration"]),
  value("database", "database", ["databases", "db"], ["vector database"]),
  value(
    "system-software",
    "system software",
    [],
    ["operating system", "os", "kernel", "microkernel", "firmware", "driver", "compiler", "runtime"],
  ),
] as const;

// Labels are GitHub's display names, so a repo's language field resolves through its label or an alias. GitHub
// reports Delphi code as Pascal, so no language field resolves to delphi.
export const languages = [
  value("abap", "ABAP"),
  value("ada", "Ada"),
  value("apex", "Apex"),
  value("assembly", "Assembly", [], ["asm"]),
  value("astro", "Astro"),
  value("blade", "Blade"),
  value("c", "C"),
  value("clojure", "Clojure"),
  value("cobol", "COBOL"),
  value("coffeescript", "CoffeeScript"),
  value("common-lisp", "Common Lisp"),
  value("cpp", "C++", ["c-plus-plus"]),
  value("crystal", "Crystal"),
  value("csharp", "C#"),
  value("css", "CSS"),
  value("d", "D"),
  value("dart", "Dart"),
  value("delphi", "Delphi"),
  value("elixir", "Elixir"),
  value("elm", "Elm"),
  value("emacs-lisp", "Emacs Lisp", ["elisp"]),
  value("erlang", "Erlang"),
  value("fortran", "Fortran"),
  value("fsharp", "F#"),
  value("gleam", "Gleam"),
  value("go", "Go", ["golang"]),
  value("groovy", "Groovy"),
  value("haskell", "Haskell"),
  value("hcl", "HCL"),
  value("html", "HTML"),
  value("java", "Java"),
  value("javascript", "JavaScript", ["js", "ecmascript"], [], ["typescript"]),
  value("jinja", "Jinja"),
  value("julia", "Julia"),
  value("jupyter-notebook", "Jupyter Notebook"),
  value("kotlin", "Kotlin"),
  value("lua", "Lua"),
  value("luau", "Luau"),
  value("makefile", "Makefile"),
  value("markdown", "Markdown"),
  value("matlab", "MATLAB"),
  value("mdx", "MDX"),
  value("nim", "Nim"),
  value("nix", "Nix"),
  value("nushell", "Nushell"),
  value("objective-c", "Objective-C", ["objc"]),
  value("objective-cpp", "Objective-C++"),
  value("ocaml", "OCaml"),
  value("pascal", "Pascal"),
  value("perl", "Perl"),
  value("php", "PHP"),
  value("pkl", "Pkl"),
  value("powershell", "PowerShell"),
  value("prolog", "Prolog"),
  value("purescript", "PureScript"),
  value("python", "Python", ["py", "python3"]),
  value("r", "R"),
  value("racket", "Racket"),
  value("rescript", "ReScript"),
  value("ruby", "Ruby"),
  value("rust", "Rust", ["rust-lang"]),
  value("scala", "Scala"),
  value("scheme", "Scheme"),
  value("scss", "SCSS"),
  value("shell", "Shell", ["bash", "zsh"]),
  value("smalltalk", "Smalltalk"),
  value("solidity", "Solidity"),
  value("sql", "SQL"),
  value("stata", "Stata"),
  value("svelte", "Svelte"),
  value("swift", "Swift"),
  value("tcl", "Tcl"),
  value("typescript", "TypeScript", ["ts"]),
  value("v", "V"),
  value("vala", "Vala"),
  value("verilog", "Verilog"),
  value("vhdl", "VHDL"),
  value("vim-script", "Vim Script", ["vimscript", "viml"]),
  value("visual-basic", "Visual Basic", ["vb", "Visual Basic .NET", "Visual Basic 6.0"]),
  value("vue", "Vue"),
  value("zig", "Zig"),
] as const;

// Licenses resolve only from GitHub's SPDX field, by exact id, and from the planner's guarded output. No claim names a
// license, so license keys reserve nothing, and PostgreSQL and zlib stay free to be subjects.
export const licenses = [
  value("MIT", "MIT"),
  value("Apache-2.0", "Apache 2.0", ["apache"]),
  value("AGPL-3.0", "AGPL 3.0", ["agpl"]),
  value("GPL-3.0", "GPL 3.0", ["gpl", "gplv3"]),
  value("GPL-2.0", "GPL 2.0"),
  value("LGPL-2.1", "LGPL 2.1"),
  value("LGPL-3.0", "LGPL 3.0"),
  value("BSD-3-Clause", "BSD 3-Clause"),
  value("BSD-2-Clause", "BSD 2-Clause"),
  value("0BSD", "0BSD"),
  value("MPL-2.0", "MPL 2.0"),
  value("ISC", "ISC"),
  value("CC0-1.0", "CC0 1.0"),
  value("CC-BY-4.0", "CC BY 4.0"),
  value("CC-BY-SA-4.0", "CC BY-SA 4.0"),
  value("Unlicense", "Unlicense"),
  value("OFL-1.1", "OFL 1.1"),
  value("EPL-2.0", "EPL 2.0"),
  value("OSL-3.0", "OSL 3.0"),
  value("PostgreSQL", "PostgreSQL"),
  value("WTFPL", "WTFPL"),
  value("EUPL-1.1", "EUPL 1.1"),
  value("EUPL-1.2", "EUPL 1.2"),
  value("MS-PL", "MS-PL"),
  value("Zlib", "zlib"),
  value("BSL-1.0", "Boost 1.0"),
  value("MIT-0", "MIT-0"),
  value("Artistic-2.0", "Artistic 2.0"),
] as const;

// Docker, Kubernetes, and cloud hosts are not platforms. The extraction prompt sends them to for.
export const platforms = [
  value("linux", "Linux", [], ["ubuntu", "debian"]),
  value("macos", "macOS", ["mac", "osx", "mac os"]),
  value("windows", "Windows"),
  value("ios", "iOS", ["iphone", "ipad", "ipados"]),
  value("android", "Android"),
  value(
    "browser",
    "the browser",
    [],
    ["browsers", "web browser", "web browsers", "chrome", "firefox", "safari", "edge"],
  ),
  value("terminal", "the terminal", [], ["shell", "bash", "zsh", "fish", "powershell"]),
  value("node", "Node.js", ["nodejs"]),
  value("deno", "Deno"),
  value("bun", "Bun"),
  value("wasm", "WebAssembly", ["webassembly"]),
  value("cloudflare-workers", "Cloudflare Workers", ["workerd"]),
  value("jvm", "JVM"),
  value("dotnet", ".NET"),
  value("embedded", "embedded devices", ["embedded"]),
] as const;

// Lifecycle, as the README states it. GitHub's archived flag stays a repo fact.
export const statuses = [
  value("deprecated", "deprecated", ["superseded"]),
  value("unmaintained", "unmaintained", ["no longer maintained", "not maintained", "abandoned"]),
] as const;

export type KindId = (typeof kinds)[number]["id"];
export type LanguageId = (typeof languages)[number]["id"];
export type LicenseId = (typeof licenses)[number]["id"];
export type PlatformId = (typeof platforms)[number]["id"];
export type StatusId = (typeof statuses)[number]["id"];

const ids = <Id extends string>(values: ReadonlyArray<ClosedValue<Id>>) => values.map((entry) => entry.id);
export const KindId = Schema.Literals(ids(kinds));
export const LanguageId = Schema.Literals(ids(languages));
export const LicenseId = Schema.Literals(ids(licenses));
export const PlatformId = Schema.Literals(ids(platforms));
export const StatusId = Schema.Literals(ids(statuses));

// Five dimensions are closed lists in code. Subject is open and lives in the database.
export const Dim = Schema.Literals(["kind", "language", "license", "platform", "status", "subject"]);
export type Dim = typeof Dim.Type;

export type ClosedDim = Exclude<Dim, "subject">;

export const closed: { readonly [D in ClosedDim]: ReadonlyArray<ClosedValue<string>> } = {
  kind: kinds,
  language: languages,
  license: licenses,
  platform: platforms,
  status: statuses,
};

export const dimPrefix: Readonly<Record<Dim, string>> = {
  kind: "kind",
  language: "lang",
  license: "license",
  platform: "platform",
  status: "status",
  subject: "subject",
};

export const RoleId = Schema.Literals([
  "is",
  "status",
  "written_in",
  "runs_on",
  "for",
  "built_with",
  "about",
  "trait",
  "licensed",
  "tagged",
  "alternative_to",
  "replaced_by",
]);
export type RoleId = typeof RoleId.Type;

export interface RoleSpec {
  // The role's name inside atom keys, as in "replaced-by:subject:9310".
  readonly wire: string;
  // The dimensions a claim in this role may resolve to, tried in order: closed values first, then subjects. A role
  // whose list is one closed dimension also resolves that dimension's impliedBy names.
  readonly accepts: readonly [Dim, ...Array<Dim>];
  // Which filters reach the role.
  //   bare: a bare atom such as "lang:rust" or "subject:4127" matches it, widened through Parent and Expand.
  //   qualified: only its own atom, such as "with:subject:812", matches it, widened the same way.
  //   comparison: only its own atom matches it, widened through merges and splits only.
  readonly matches: "bare" | "qualified" | "comparison";
  // The extraction prompt line, or null when only GitHub facts or curation write this role.
  readonly prompt: string | null;
  // The claim needs its quote found in the prompt input.
  readonly quoteRequired: boolean;
  // A claim in this role may create a subject the first time it is seen.
  readonly mints: boolean;
  // The most atoms of this role one repo keeps, in the order the model wrote them.
  readonly max: number;
  readonly phrase: (label: string) => string;
}

export const roles: Readonly<Record<RoleId, RoleSpec>> = {
  is: {
    wire: "is",
    accepts: ["kind"],
    matches: "bare",
    prompt: "what the repo is, one or two of: {kinds}. Put the main one first. Always include at least one.",
    quoteRequired: false,
    mints: false,
    max: 2,
    phrase: (label) => label,
  },
  status: {
    wire: "status",
    accepts: ["status"],
    matches: "bare",
    prompt: "deprecated or unmaintained, only when the README says so. Quote it.",
    quoteRequired: true,
    mints: false,
    max: 1,
    phrase: (label) => label,
  },
  written_in: {
    wire: "written-in",
    accepts: ["language"],
    matches: "bare",
    prompt: "a programming language its own code is written in.",
    quoteRequired: false,
    mints: false,
    max: 3,
    phrase: (label) => `written in ${label}`,
  },
  runs_on: {
    wire: "runs-on",
    accepts: ["platform"],
    matches: "bare",
    prompt:
      "an operating system, browser, terminal, or runtime it runs on, such as macOS, iOS, Node.js, or Cloudflare Workers. Docker, Kubernetes, and cloud hosts are for.",
    quoteRequired: false,
    mints: false,
    max: 6,
    phrase: (label) => `runs on ${label}`,
  },
  for: {
    wire: "for",
    accepts: ["language", "platform", "subject"],
    matches: "bare",
    prompt:
      "a technology this repo is meant to be used with, such as a plugin for Figma, a client for PostgreSQL, or bindings for Python. Not a framework or library it is merely built with.",
    quoteRequired: false,
    mints: true,
    max: 8,
    phrase: (label) => `works with ${label}`,
  },
  built_with: {
    wire: "with",
    accepts: ["language", "platform", "subject"],
    matches: "qualified",
    prompt:
      "a framework, library, or engine its own code is built on, such as Flutter, Tauri, or Electron. Only the main ones.",
    quoteRequired: false,
    mints: true,
    max: 4,
    phrase: (label) => `built with ${label}`,
  },
  about: {
    wire: "about",
    accepts: ["subject"],
    matches: "bare",
    prompt: "a problem area or category of software, such as authentication, web scraping, or terminal UI.",
    quoteRequired: false,
    mints: true,
    max: 8,
    phrase: (label) => label,
  },
  trait: {
    wire: "trait",
    accepts: ["subject"],
    matches: "bare",
    prompt: "a quality someone would filter on, such as self-hosted, local-first, offline, or zero-dependency.",
    quoteRequired: false,
    mints: true,
    max: 6,
    phrase: (label) => label,
  },
  licensed: {
    wire: "licensed",
    accepts: ["license"],
    matches: "bare",
    prompt: null,
    quoteRequired: false,
    mints: false,
    max: 1,
    phrase: (label) => `${label} license`,
  },
  tagged: {
    wire: "tagged",
    accepts: ["subject"],
    matches: "bare",
    prompt: null,
    quoteRequired: false,
    mints: false,
    max: 20,
    phrase: (label) => label,
  },
  alternative_to: {
    wire: "alt",
    accepts: ["language", "platform", "subject"],
    matches: "comparison",
    prompt:
      "a named product or project it resembles, competes with, or replaces. Never the repo itself, a former name of it, code it contains, or a product of a different kind, such as a whole app for a UI component.",
    quoteRequired: false,
    mints: true,
    max: 6,
    phrase: (label) => `alternative to ${label}`,
  },
  replaced_by: {
    wire: "replaced-by",
    accepts: ["language", "platform", "subject"],
    matches: "comparison",
    prompt: "the project the README says to use instead of this one. Quote it.",
    quoteRequired: true,
    mints: true,
    max: 2,
    phrase: (label) => `replaced by ${label}`,
  },
};

export const roleIds = RoleId.literals;

// The roles a bare value like "lang:rust" or "subject:4127" matches.
export const defaultRoles = (dim: Dim): ReadonlyArray<RoleId> =>
  roleIds.filter((id) => roles[id].matches === "bare" && roles[id].accepts.includes(dim));

const reservingDims = ["kind", "language", "platform", "status"] as const satisfies ReadonlyArray<ClosedDim>;

export const closedKeys = (entry: ClosedValue<string>): ReadonlyArray<LabelKey> =>
  [entry.id, entry.label, ...entry.aliases].flatMap((spelling) => labelKey(spelling) ?? []);

// The label key of every id, label, and alias of a kind, language, platform, or status. No subject label may equal
// one, so "about: rust" cannot mint a subject that competes with the language. License keys and impliedBy names
// reserve nothing.
export const reservedKeys: ReadonlySet<LabelKey> = new Set(
  reservingDims.flatMap((dim) => closed[dim].flatMap(closedKeys)),
);

export const closedDims = Dim.literals.filter((dim): dim is ClosedDim => dim !== "subject");

const perDim = <A>(build: (dim: ClosedDim) => A): Readonly<Record<ClosedDim, A>> => ({
  kind: build("kind"),
  language: build("language"),
  license: build("license"),
  platform: build("platform"),
  status: build("status"),
});

const byId = perDim(
  (dim): ReadonlyMap<string, ClosedValue<string>> => new Map(closed[dim].map((entry) => [entry.id, entry])),
);

// Every label key of a value, and its id in lowercase, to its id. A label key never holds "-", and an id without one is
// its own label key, so no two values share an entry.
const indexes = perDim(
  (dim): ReadonlyMap<string, string> =>
    new Map(
      closed[dim].flatMap((entry) => [
        ...closedKeys(entry).map((key): readonly [string, string] => [key, entry.id]),
        [entry.id.toLowerCase(), entry.id] as const,
      ]),
    ),
);

export const closedValue = (dim: ClosedDim, id: string): ClosedValue<string> | undefined => byId[dim].get(id);

// The value's label, or the id itself for an id the registry no longer holds.
export const closedLabel = (dim: ClosedDim, id: string): string => closedValue(dim, id)?.label ?? id;

export const closedIndex = (dim: ClosedDim): ReadonlyMap<string, string> => indexes[dim];

export const RecipeId = Schema.Literals(["top", "trending_7d"]);
export type RecipeId = typeof RecipeId.Type;

// How a snapshot ranks a selection's members and how many it keeps. The selection's atoms already carry the roles.
export interface RankingRecipe {
  readonly description: string;
  readonly score: "stars_total" | "stars_gained_7d";
  readonly bound: number;
  // complete_7d refuses a period unless each of its seven UTC days has complete star-event coverage.
  readonly requires: "nothing" | "complete_7d";
}

export const recipes: Readonly<Record<RecipeId, RankingRecipe>> = {
  top: { description: "Most starred, for pages.", score: "stars_total", bound: 100, requires: "nothing" },
  trending_7d: {
    description: "Most stars gained in seven complete UTC days, for the weekly digest and trending pages.",
    score: "stars_gained_7d",
    bound: 50,
    requires: "complete_7d",
  },
};
