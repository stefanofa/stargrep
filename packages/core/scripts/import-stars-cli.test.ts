import { describe, expect, test } from "bun:test";
import * as BunServices from "@effect/platform-bun/BunServices";
import type { RepoId } from "@stargrep/github/schemas";
import * as it from "@stargrep/testing";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as EnrichQueue from "../src/repos/enrich-queue.ts";
import { layerPendingFile, parseLogins, parsePending } from "./star-import-files.ts";

describe("parseLogins", () => {
  test("reads the first tab-separated column in order, and skips blank and comment lines", () => {
    expect(parseLogins("# ranked\nkarpathy\t1\t2\n\n  gaearon  \nmanaged_user\tx\n")).toEqual({
      logins: ["karpathy", "gaearon", "managed_user"],
      invalid: [],
    } as never);
  });

  test("names the lines whose first column is not a login", () => {
    expect(parseLogins("ada\nowner/repo\nbob\nhttps://github.com/x\n").invalid).toEqual([2, 4]);
  });
});

test("parsePending reads each repo once and skips a line that holds no repo ID", () => {
  expect(parsePending("12\n7\n12\n\n4x\n9").map(Number)).toEqual([12, 7, 9]);
});

const scratch = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "import-stars-" });
  return { fs, file: (name: string) => path.join(dir, name), dir };
});

it.effect("appends each repo the sync would enrich to the pending file", () =>
  Effect.gen(function* () {
    const { fs, file } = yield* scratch;
    const pending = file("pending.txt");
    yield* EnrichQueue.EnrichQueue.use((queue) =>
      Effect.andThen(
        queue.send([{ repoId: 1 as RepoId }, { repoId: 2 as RepoId }]),
        queue.send([{ repoId: 3 as RepoId }]),
      ),
    ).pipe(Effect.provide(layerPendingFile(pending)));
    expect(yield* fs.readFileString(pending)).toBe("1\n2\n3\n");
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
);

// A malformed list is refused before the CLI opens a database or reads GitHub, so a typo never starts a long run.
it.effect("exits non-zero when a login list line is not a login", () =>
  Effect.gen(function* () {
    const { fs, file, dir } = yield* scratch;
    yield* fs.writeFileString(file("logins.txt"), "ada\nowner/repo\n");
    const { DATABASE_URL: _, GITHUB_TOKEN: __, ...env } = process.env;
    const refused = Bun.spawnSync(
      ["bun", "scripts/import-stars.ts", "run", "--logins", file("logins.txt"), "--state", dir],
      { cwd: `${import.meta.dir}/..`, env, stdout: "pipe", stderr: "pipe" },
    );
    expect(refused.exitCode).not.toBe(0);
    expect(`${refused.stdout}${refused.stderr}`).toContain("import-stars refuses to start");
    expect(`${refused.stdout}${refused.stderr}`).toContain("not a login: 2");
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
);

it.effect("exits non-zero when --concurrency or --share is out of range", () =>
  Effect.gen(function* () {
    const { fs, file, dir } = yield* scratch;
    yield* fs.writeFileString(file("logins.txt"), "ada\n");
    const { DATABASE_URL: _, GITHUB_TOKEN: __, ...env } = process.env;
    for (const [flag, value, reason] of [
      ["--concurrency", "0", "--concurrency takes 1 to 8"],
      ["--share", "1.5", "--share takes more than 0 and at most 1"],
    ] as const) {
      const refused = Bun.spawnSync(
        [
          "bun",
          "scripts/import-stars.ts",
          "run",
          "--logins",
          file("logins.txt"),
          "--state",
          dir,
          `${flag}`,
          `${value}`,
        ],
        { cwd: `${import.meta.dir}/..`, env, stdout: "pipe", stderr: "pipe" },
      );
      expect(refused.exitCode).not.toBe(0);
      expect(`${refused.stdout}${refused.stderr}`).toContain(reason);
    }
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
);
