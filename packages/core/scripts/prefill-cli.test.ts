import { expect } from "bun:test";
import * as it from "@stargrep/testing";
import * as Effect from "effect/Effect";

// The CLI refuses a Gateway batch run with no R2 bucket before it opens a database or a provider, and says so with a
// failing exit, so a script or an operator cannot mistake the refusal for a run.
it.effect("exits non-zero when it refuses to start a Gateway batch run without R2", () =>
  Effect.promise(async () => {
    const { PREFILL_R2_BUCKET: _, ...env } = process.env;
    const refused = Bun.spawnSync(["bun", "scripts/prefill.ts", "--ids", "missing.txt"], {
      cwd: `${import.meta.dir}/..`,
      env: { ...env, AI_TEXT_PROVIDER: "gateway" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(refused.exitCode).not.toBe(0);
    expect(`${refused.stdout}${refused.stderr}`).toContain("PREFILL_R2_BUCKET");
  }),
);
