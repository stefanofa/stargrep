import { describe, expect, test } from "bun:test";
import { extractionLines } from "./extraction.ts";

describe("extractionLines", () => {
  // The facets block of the recipe 5 summary prompt. Changing it changes what every paid summary says, so a change here
  // ships with a recipe bump.
  test("renders the facets block from the role registry", () => {
    expect(extractionLines()).toEqual([
      `- facets: up to 12 facts about the repo, each {"role", "term", "quote"}.`,
      `  - term: one thing, named the way developers write it, as a short noun phrase of at most three words, such as "PostgreSQL", "terminal UI", or "self-hosted". Never join two things in one term, with "and" or otherwise: "rust cli" is two facts, a written_in and an is.`,
      `  - quote: the exact words from the description, topics, or README that support the fact. Quote the text itself, never a line label such as "Topics:".`,
      "  Roles:",
      "  - is: what the repo is, one or two of: app, library, framework, cli, plugin, template, list, learning, dataset, model, config, database, system-software. Put the main one first. Always include at least one. system-software is an operating system, kernel, driver, firmware, compiler, or runtime. A server, daemon, or service you run is an app. A browser or editor extension is a plugin, and an installer is a cli.",
      "  - status: deprecated or unmaintained, only when the README says so. Quote it.",
      "  - written_in: a programming language its own code is written in.",
      "  - runs_on: an operating system, browser, terminal, or runtime it runs on, such as macOS, iOS, Node.js, or Cloudflare Workers. Docker, Kubernetes, and cloud hosts are for.",
      "  - for: a technology this repo is meant to be used with, such as a plugin for Figma, a client for PostgreSQL, or bindings for Python. Not a framework or library it is merely built with. Never an audience, or what a list or course covers, which is about.",
      "  - built_with: a framework, library, or engine its own code is built on, such as Flutter, Tauri, or Electron. Only the main ones. Never a library it supports or integrates with, or a protocol, operating system, or platform API it targets, which are for. Never a build tool, a code generator, or its own language.",
      "  - about: a problem area or category of software, such as authentication, web scraping, or terminal UI.",
      "  - trait: one of self-hosted, local-first, offline, zero-dependency, cross-platform, only when the input says the repo itself has it. Quote it. A feature is about.",
      '  - alternative_to: a named product a user could pick instead of this one, such as a competitor or a product it replaces. Never a category, API, format, language feature, or technique, something it uses, wraps, or works with, an analogy such as Jira in "Jira for technicians", the repo itself, code it contains, a project it was forked or renamed from, or its successor, which is replaced_by.',
      "  - replaced_by: another project the README tells this repo's users to switch to, never one this repo replaces. In a repo of many projects, only the whole repo's successor. Quote it.",
      "  Leave out anything the input does not support, except the kind. Never write open-source, hacktoberfest, awesome, or the repo's own name as a fact.",
    ]);
  });
});
