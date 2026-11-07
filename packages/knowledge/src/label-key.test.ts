import { describe, expect, test } from "bun:test";
import * as LabelKey from "./label-key.ts";

const labelKey = (term: string): string | null => LabelKey.labelKey(term);

describe("labelKey", () => {
  test("joins spellings that differ only in case, separators, or Unicode form", () => {
    const groups = [
      ["computer-use-agent", "computer-use agent", "computer use agent"],
      ["key-value-store", "key-value store", "key value store"],
      ["worker_threads", "worker-threads", "worker threads"],
      ["Swift", "swift"],
      ["Claude Code", "claude code"],
      ["MCP server", "mcp server", "ＭＣＰ　server"],
      ["CI/CD", "ci cd"],
    ];
    for (const group of groups) expect(group.map(labelKey)).toEqual(group.map(() => labelKey(group[0] ?? "")));
  });

  test("keeps apart plurals, js suffixes, and synonyms, which are curated aliases", () => {
    const apart = [
      ["agent", "agents"],
      ["agent skill", "agent skills"],
      ["react", "reactjs", "react.js"],
      ["node", "nodejs", "node.js", "node js"],
      ["k8s", "kubernetes"],
      ["llm", "large-language-model"],
      ["postgres", "postgresql"],
      ["C", "C++", "C#"],
    ];
    for (const group of apart) expect(new Set(group.map(labelKey)).size).toBe(group.length);
  });

  test("trims edge punctuation and symbols but keeps a leading dot and a trailing plus or hash", () => {
    expect(["C++", "C#", ".NET", "Node.js", "(Rust)", '"terminal UI".', "🚀 Rocket", "--flag--"].map(labelKey)).toEqual(
      ["c++", "c#", ".net", "node.js", "rust", "terminal ui", "rocket", "flag"],
    );
  });

  test("gives no key to a term with no letter or digit", () => {
    expect(["", "   ", "---", "...", "🚀", "#"].map(labelKey)).toEqual([null, null, null, null, null, null]);
  });

  test("gives no key past 80 characters, including one NFKC lengthens", () => {
    expect(labelKey("a".repeat(80))).toBe("a".repeat(80));
    expect(labelKey("a".repeat(81))).toBeNull();
    expect(labelKey("ﬀ".repeat(40))).toBe("ff".repeat(40));
    expect(labelKey("ﬀ".repeat(80))).toBeNull();
  });
});
