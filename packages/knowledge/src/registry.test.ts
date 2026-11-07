import { describe, expect, test } from "bun:test";
import { labelKey } from "./label-key.ts";
import * as Registry from "./registry.ts";

const closedDims = Registry.Dim.literals.filter((dim): dim is Registry.ClosedDim => dim !== "subject");

const owners = () => {
  const byKey = new Map<string, Set<string>>();
  for (const dim of closedDims)
    for (const entry of Registry.closed[dim])
      for (const key of Registry.closedKeys(entry))
        byKey.set(key, new Set([...(byKey.get(key) ?? []), `${dim}:${entry.id}`]));
  return byKey;
};

describe("closed values", () => {
  test("give every id, label, and alias a label key", () => {
    const unkeyed = closedDims.flatMap((dim) =>
      Registry.closed[dim].flatMap((entry) =>
        [entry.id, entry.label, ...entry.aliases].filter((spelling) => labelKey(spelling) === null),
      ),
    );
    expect(unkeyed).toEqual([]);
  });

  test("give every label key exactly one closed value", () => {
    const shared = [...owners()].filter(([, values]) => values.size > 1).map(([key, values]) => [key, [...values]]);
    expect(shared).toEqual([]);
  });

  test("never let an impliedBy name spell a value of its own dimension or imply two of its values", () => {
    const problems = closedDims.flatMap((dim) => {
      const spellings = new Set(Registry.closed[dim].flatMap(Registry.closedKeys));
      const implied = Registry.closed[dim].flatMap((entry) => entry.impliedBy.map((name) => labelKey(name)));
      const spelled = implied.filter((key) => key === null || spellings.has(key));
      const twice = implied.filter((key, index) => implied.indexOf(key) !== index);
      return [...spelled, ...twice].map((key) => `${dim}:${key}`);
    });
    expect(problems).toEqual([]);
  });

  test("expand only to existing values of the same dimension, without cycles", () => {
    for (const dim of closedDims) {
      const expands = new Map(Registry.closed[dim].map((entry) => [entry.id, entry.expands]));
      const visit = (id: string, path: ReadonlyArray<string>): void => {
        expect([dim, id, expands.has(id)]).toEqual([dim, id, true]);
        expect([dim, id, path.includes(id)]).toEqual([dim, id, false]);
        for (const next of expands.get(id) ?? []) visit(next, [...path, id]);
      };
      for (const entry of Registry.closed[dim]) for (const next of entry.expands) visit(next, [entry.id]);
    }
  });

  test("keep the audited spellings off the closed values they only neighbor", () => {
    const owner = (term: string) => [...(owners().get(labelKey(term) ?? "") ?? [])];
    expect(owner("node")).toEqual(["platform:node"]);
    expect(owner("nodejs")).toEqual(["platform:node"]);
    expect(owner("Node.js")).toEqual(["platform:node"]);
    expect(owner("shell")).toEqual(["language:shell"]);
    expect(owner("tui")).toEqual([]);
    expect(owner("workers")).toEqual([]);
    expect(owner("web browser")).toEqual([]);
    expect(owner("chrome extension")).toEqual([]);
    expect(owner("Objective-C++")).toEqual(["language:objective-cpp"]);
    expect(owner("Jupyter Notebook")).toEqual(["language:jupyter-notebook"]);
    expect(owner("Visual Basic .NET")).toEqual(["language:visual-basic"]);
    expect(owner("Visual Basic 6.0")).toEqual(["language:visual-basic"]);
  });
});

describe("reservedKeys", () => {
  const reserved = (term: string) => {
    const key = labelKey(term);
    return [term, key !== null && Registry.reservedKeys.has(key)];
  };

  test("holds the 174 keys of kinds, languages, platforms, and statuses", () => {
    expect(Registry.reservedKeys.size).toBe(174);
    for (const term of ["cli", "rust", "macos", "node", "shell", "library", "c++", "c#", ".NET", "deprecated"]) {
      expect(reserved(term)).toEqual([term, true]);
    }
  });

  test("leaves subjects, licenses, and impliedBy names free", () => {
    for (const term of ["tui", "postgresql", "zlib", "chrome", "ubuntu", "sdk", "asm", "MIT", "apache", "workers"]) {
      expect(reserved(term)).toEqual([term, false]);
    }
  });
});

describe("roles", () => {
  test("try closed dimensions before subjects", () => {
    const subjectFirst = Registry.roleIds.filter((role) => {
      const accepts = Registry.roles[role].accepts;
      return accepts.includes("subject") && accepts.at(-1) !== "subject";
    });
    expect(subjectFirst).toEqual([]);
  });

  test("mint only in roles that accept subjects", () => {
    const minting = Registry.roleIds.filter((role) => Registry.roles[role].mints);
    expect(minting.filter((role) => !Registry.roles[role].accepts.includes("subject"))).toEqual([]);
  });

  test("give each role its own wire name", () => {
    const wires = Registry.roleIds.map((role) => Registry.roles[role].wire);
    expect(new Set(wires).size).toBe(wires.length);
  });

  test("match bare atoms through membership roles, never through built_with or comparisons", () => {
    expect(Registry.defaultRoles("subject")).toEqual(["for", "about", "trait", "tagged"]);
    expect(Registry.defaultRoles("language")).toEqual(["written_in", "for"]);
    expect(Registry.defaultRoles("platform")).toEqual(["runs_on", "for"]);
    expect(Registry.defaultRoles("kind")).toEqual(["is"]);
    expect(Registry.defaultRoles("license")).toEqual(["licensed"]);
    expect(Registry.defaultRoles("status")).toEqual(["status"]);
  });
});
