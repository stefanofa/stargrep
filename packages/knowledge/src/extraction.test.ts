import { describe, expect, test } from "bun:test";
import { extractionLines } from "./extraction.ts";

describe("extractionLines", () => {
  // The facets block of the recipe 2 summary prompt. Changing it changes what every paid summary says, so a change here
  // ships with a recipe bump.
  test("renders the facets block from the role registry", () => {
    expect(extractionLines()).toEqual([
      `- facets: up to 12 facts about the repo, each {"role", "term", "quote"}.`,
      `  - term: one thing, named the way developers write it, as a short noun phrase of at most three words, such as "PostgreSQL", "terminal UI", or "self-hosted". Never join two things in one term, with "and" or otherwise: "rust cli" is two facts, a written_in and an is.`,
      `  - quote: the exact words from the description, topics, or README that support the fact. Quote the text itself, never a line label such as "Topics:".`,
      "  Roles:",
      "  - is: what the repo is, one or two of: app, library, framework, cli, plugin, template, list, learning, dataset, model, config. Put the main one first. Always include at least one.",
      "  - status: deprecated or unmaintained, only when the README says so. Quote it.",
      "  - written_in: a programming language its own code is written in.",
      "  - runs_on: an operating system, browser, terminal, or runtime it runs on, such as macOS, iOS, Node.js, or Cloudflare Workers. Docker, Kubernetes, and cloud hosts are for.",
      "  - for: a technology this repo is meant to be used with, such as a plugin for Figma, a client for PostgreSQL, or bindings for Python. Not a framework or library it is merely built with.",
      "  - built_with: a framework, library, or engine its own code is built on, such as Flutter, Tauri, or Electron. Only the main ones.",
      "  - about: a problem area or category of software, such as authentication, web scraping, or terminal UI.",
      "  - trait: a quality someone would filter on, such as self-hosted, local-first, offline, or zero-dependency.",
      "  - alternative_to: a named product or project it resembles, competes with, or replaces. Never the repo itself, a former name of it, code it contains, or a product of a different kind, such as a whole app for a UI component.",
      "  - replaced_by: the project the README says to use instead of this one. Quote it.",
      "  Leave out anything the input does not support, except the kind. Never write open-source, hacktoberfest, awesome, or the repo's own name as a fact.",
    ]);
  });
});
