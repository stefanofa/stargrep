import { describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import * as Atom from "./atom.ts";
import { SubjectId } from "./ids.ts";

const decodeAtom = Schema.decodeUnknownSync(Atom.AtomKey);
const encodeAtom = Schema.encodeSync(Atom.AtomKey);
const decodeSelection = Schema.decodeUnknownSync(Atom.SelectionKey);
const encodeSelection = Schema.encodeSync(Atom.SelectionKey);
const rejects = (key: string) => Schema.decodeExit(Atom.AtomKey)(key)._tag === "Failure";

describe("AtomKey", () => {
  test("reads each role and dimension form", () => {
    expect(decodeAtom("lang:rust")).toEqual({ role: "any", value: { dim: "language", id: "rust" } });
    expect(decodeAtom("kind:library")).toEqual({ role: "any", value: { dim: "kind", id: "library" } });
    expect(decodeAtom("license:Apache-2.0")).toEqual({ role: "any", value: { dim: "license", id: "Apache-2.0" } });
    expect(decodeAtom("status:deprecated")).toEqual({ role: "any", value: { dim: "status", id: "deprecated" } });
    expect(decodeAtom("subject:4127")).toEqual({ role: "any", value: { dim: "subject", id: SubjectId.make(4127) } });
    expect(decodeAtom("about:subject:4127")).toEqual({
      role: "about",
      value: { dim: "subject", id: SubjectId.make(4127) },
    });
    expect(decodeAtom("written-in:lang:rust")).toEqual({ role: "written_in", value: { dim: "language", id: "rust" } });
    expect(decodeAtom("for:platform:node")).toEqual({ role: "for", value: { dim: "platform", id: "node" } });
    expect(decodeAtom("alt:platform:node")).toEqual({ role: "alternative_to", value: { dim: "platform", id: "node" } });
    expect(decodeAtom("alt:subject:77")).toEqual({
      role: "alternative_to",
      value: { dim: "subject", id: SubjectId.make(77) },
    });
    expect(decodeAtom("replaced-by:subject:9310")).toEqual({
      role: "replaced_by",
      value: { dim: "subject", id: SubjectId.make(9310) },
    });
    expect(decodeAtom("with:subject:812")).toEqual({
      role: "built_with",
      value: { dim: "subject", id: SubjectId.make(812) },
    });
    expect(decodeAtom("with:lang:dart")).toEqual({ role: "built_with", value: { dim: "language", id: "dart" } });
  });

  test("round-trips every form it reads", () => {
    const keys = [
      "lang:rust",
      "kind:library",
      "license:Apache-2.0",
      "status:deprecated",
      "platform:cloudflare-workers",
      "subject:4127",
      "about:subject:4127",
      "tagged:subject:5",
      "written-in:lang:objective-cpp",
      "for:platform:node",
      "for:lang:python",
      "alt:platform:node",
      "alt:subject:77",
      "replaced-by:lang:typescript",
      "with:subject:812",
      "with:platform:bun",
    ];
    expect(keys.map((key) => encodeAtom(decodeAtom(key)))).toEqual(keys);
  });

  test("writes the shortest form, so a dimension's only default role reads as any", () => {
    expect(encodeAtom(decodeAtom("is:kind:app"))).toBe("kind:app");
    expect(encodeAtom(decodeAtom("licensed:license:MIT"))).toBe("license:MIT");
    expect(encodeAtom(decodeAtom("status:status:unmaintained"))).toBe("status:unmaintained");
    expect(decodeAtom("is:kind:app")).toEqual(decodeAtom("kind:app"));
  });

  test("refuses unknown values, roles that do not accept the dimension, and non-canonical subject ids", () => {
    for (const key of [
      "lang:klingon",
      "lang:Rust",
      "kind:other",
      "license:NOASSERTION",
      "subject:0",
      "subject:01",
      "subject:abc",
      "subject:9007199254740992",
      "alt:kind:app",
      "about:lang:rust",
      "with:kind:app",
      "nope:lang:rust",
      "any:lang:rust",
      "built_with:subject:1",
      "lang:",
      "rust",
      "",
    ]) {
      expect([key, rejects(key)]).toEqual([key, true]);
    }
  });

  test("refuses a hand-built atom in a role written as any", () => {
    expect(() => Schema.encodeSync(Atom.Atom)({ role: "is", value: { dim: "kind", id: "app" } } as never)).toThrow();
  });
});

describe("SelectionKey", () => {
  test("reads groups, alternatives, and negation, and writes them back unchanged", () => {
    const key = "lang:rust subject:4127 subject:812|subject:9031 -kind:list";
    const selection = decodeSelection(key);
    expect(selection.all.map((group) => [group.negate, group.any.length])).toEqual([
      [false, 1],
      [false, 1],
      [false, 2],
      [true, 1],
    ]);
    expect(encodeSelection(selection)).toBe(key);
  });

  test("reads the empty string as everything", () => {
    expect(decodeSelection("")).toEqual(Atom.everything);
    expect(encodeSelection(Atom.everything)).toBe("");
  });

  test("refuses empty groups, empty alternatives, bad atoms, and keys over 2000 characters", () => {
    for (const key of ["lang:rust  kind:cli", "-", "lang:rust|", "|", " lang:rust", "lang:klingon"]) {
      expect([key, Schema.decodeExit(Atom.SelectionKey)(key)._tag]).toEqual([key, "Failure"]);
    }
    expect(Schema.decodeExit(Atom.SelectionKey)(`subject:1${"|subject:1".repeat(200)}`)._tag).toBe("Failure");
  });
});

describe("normalize", () => {
  test("sorts atoms and groups, puts negated groups last, and drops repeats", () => {
    const messy = decodeSelection(
      "-kind:list subject:9031|subject:812|subject:9031 lang:rust subject:812|subject:9031",
    );
    expect(encodeSelection(Atom.normalize(messy))).toBe("lang:rust subject:812|subject:9031 -kind:list");
  });

  test("keeps subject ids as given", () => {
    expect(encodeSelection(Atom.normalize(decodeSelection("subject:77 alt:subject:77")))).toBe(
      "alt:subject:77 subject:77",
    );
  });

  test("gives equal selections equal keys", () => {
    const a = Atom.normalize(decodeSelection("kind:cli|is:kind:app lang:go"));
    const b = Atom.normalize(decodeSelection("lang:go kind:app|kind:cli"));
    expect(encodeSelection(a)).toBe(encodeSelection(b));
  });
});
