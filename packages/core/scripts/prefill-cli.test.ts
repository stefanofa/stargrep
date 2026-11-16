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

// The CLI adapter asks the Claude Code CLI or the Gateway one prompt at a time, so a summary model meant for a batch
// would silently not apply. The CLI refuses it before it opens a database.
it.effect("exits non-zero when --summary-model comes with --adapter cli", () =>
  Effect.promise(async () => {
    const refused = Bun.spawnSync(
      ["bun", "scripts/prefill.ts", "--ids", "missing.txt", "--adapter", "cli", "--summary-model", "anthropic/x"],
      { cwd: `${import.meta.dir}/..`, env: process.env, stdout: "pipe", stderr: "pipe" },
    );
    expect(refused.exitCode).not.toBe(0);
    expect(`${refused.stdout}${refused.stderr}`).toContain("prefill refuses to start: --summary-model");
  }),
);

// The backlog is what the Worker would pay the Gateway for once its daily cap has room, so a backlog run that would ask
// the Gateway directly, past the cap, is refused before it opens a database.
it.effect("exits non-zero when --pending would ask anything but the Claude Code CLI", () =>
  Effect.promise(async () => {
    const attempts = [
      { args: ["--pending", "10"], provider: "claude-code" },
      { args: ["--pending", "10", "--adapter", "cli"], provider: "gateway" },
      { args: ["--pending", "10", "--adapter", "cli", "--ids", "missing.txt"], provider: "claude-code" },
    ];
    for (const { args, provider } of attempts) {
      const refused = Bun.spawnSync(["bun", "scripts/prefill.ts", ...args], {
        cwd: `${import.meta.dir}/..`,
        env: { ...process.env, AI_TEXT_PROVIDER: provider },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(refused.exitCode).not.toBe(0);
      expect(`${refused.stdout}${refused.stderr}`).toContain("prefill refuses to start");
    }
  }),
);
