import { describe, expect, test } from "bun:test";
import * as Vocabulary from "./vocabulary.ts";

describe("Vocabulary", () => {
  test("finds no filter in repo names that share a word with a multi-word language", () => {
    for (const query of ["vim", "emacs", "jupyter", "common crawl", "notebook viewer", "visual studio"]) {
      expect([query, Vocabulary.mentionsFilter(query)]).toEqual([query, false]);
    }
  });

  test("finds a multi-word language only as a whole phrase", () => {
    expect(Vocabulary.mentionsFilter("emacs lisp packages")).toBe(true);
    expect(Vocabulary.mentionsFilter("lisp emacs packages")).toBe(false);
    expect(Vocabulary.mentionsFilter("emacs packages")).toBe(false);
  });

  test("finds a language, a kind, a license, a metric word, or a number", () => {
    for (const query of ["rust", "orms for node.", "cli", "libraries", "mit", "most popular", "repos 2024", "only"]) {
      expect([query, Vocabulary.mentionsFilter(query)]).toEqual([query, true]);
    }
  });

  test("finds quoted words in the query as whole words, in any case, script, or Unicode form", () => {
    expect(Vocabulary.appearsIn("библиотеки на ПИТОНЕ для веба", "питоне")).toBe(true);
    expect(Vocabulary.appearsIn("emacs lisp packages", "Emacs Lisp")).toBe(true);
    expect(Vocabulary.appearsIn("orms for node.", "node")).toBe(true);
    expect(Vocabulary.appearsIn("c++ json parser", "C++")).toBe(true);
    expect(Vocabulary.appearsIn("ｔｓ orm", "ts")).toBe(true);
  });

  test("matches quoted words inside text written without spaces, and across a change of script", () => {
    expect(Vocabulary.appearsIn("用Python写的网络框架", "Python")).toBe(true);
    expect(Vocabulary.appearsIn("Pythonで書かれたウェブフレームワーク", "python")).toBe(true);
    expect(Vocabulary.appearsIn("C++で書かれたJSONライブラリ", "C++")).toBe(true);
    expect(Vocabulary.appearsIn("パイソンのウェブフレームワーク", "パイソン")).toBe(true);
    expect(Vocabulary.appearsIn("用于网页的蟒蛇语言库", "蟒蛇语言")).toBe(true);
    expect(Vocabulary.appearsIn("ไลบรารีไพธอนสำหรับเว็บ", "ไพธอน")).toBe(true);
    expect(Vocabulary.appearsIn("用Pythonic写的框架", "Python")).toBe(false);
  });

  test("misses quoted words inside a longer word, out of order, or empty", () => {
    expect(Vocabulary.appearsIn("tsconfig loader", "ts")).toBe(false);
    expect(Vocabulary.appearsIn("lisp emacs packages", "emacs lisp")).toBe(false);
    expect(Vocabulary.appearsIn("rust cli", "")).toBe(false);
    expect(Vocabulary.appearsIn("rust cli", "  ")).toBe(false);
  });

  test("restricts the kind for only, just, not, except, and excluding, but not for no or without, which usually describe features", () => {
    for (const query of [
      "only CLIs",
      "just apps",
      "apps, not libraries",
      "anything except plugins",
      "excluding lists",
    ]) {
      expect([query, Vocabulary.restrictsKind(query)]).toEqual([query, true]);
    }
    for (const query of ["apps without ads", "no-config bundler", "apps with no telemetry", "rust library"]) {
      expect([query, Vocabulary.restrictsKind(query)]).toEqual([query, false]);
    }
  });

  test("treats connectives as sentence words in any case", () => {
    expect(["for", "Like", "WITHOUT", "react"].map(Vocabulary.isConnective)).toEqual([true, true, true, false]);
  });
});
