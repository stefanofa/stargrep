import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Step = { readonly id?: string; readonly run?: string };
type Workflow = {
  readonly defaults?: { readonly run?: { readonly shell?: string } };
  readonly jobs: Record<string, { readonly steps: ReadonlyArray<Step> }>;
};

const root = new URL("..", import.meta.url).pathname;

const githubShell = (shell: string | null) =>
  shell === "bash" ? ["bash", "--noprofile", "--norc", "-eo", "pipefail"] : ["bash", "-e"];

const mocks = mkdtempSync(join(tmpdir(), "reconcile-mocks-"));
const mock = (name: string, body: string) => {
  writeFileSync(join(mocks, name), `#!/bin/bash\n${body}`);
  chmodSync(join(mocks, name), 0o755);
};
mock(
  "gh",
  `if [ -n "$GH_FAIL" ]; then echo "$GH_FAIL" >&2; exit 1; fi
for pair in $GH_STATES; do if [ "\${pair%%=*}" = "$3" ]; then echo "\${pair#*=}"; exit 0; fi; done
echo "GraphQL: Could not resolve to a PullRequest with the number of $3. (repository.pullRequest)" >&2
exit 1
`,
);
mock("bunx", `printf '%s' "$INVENTORY"\nexit "\${INVENTORY_EXIT:-0}"\n`);
mock("bun", `echo "bun $*"\n`);

const reconcile = Bun.YAML.parse(
  readFileSync(join(root, ".github/workflows/preview-reconcile.yml"), "utf8"),
) as Workflow;
const stepRun = (job: string, find: (step: Step) => boolean) => {
  const run = reconcile.jobs[job]?.steps.find(find)?.run;
  if (!run) throw new Error(`no run step in job ${job}`);
  return run;
};

const runStep = (script: string, env: Record<string, string>, shell = reconcile.defaults?.run?.shell ?? null) => {
  const dir = mkdtempSync(join(tmpdir(), "reconcile-step-"));
  writeFileSync(join(dir, "step.sh"), script);
  writeFileSync(join(dir, "output"), "");
  const result = Bun.spawnSync([...githubShell(shell), join(dir, "step.sh")], {
    cwd: root,
    env: {
      PATH: `${mocks}:${process.env.PATH}`,
      GITHUB_REPOSITORY: "stefanofa/stargrep",
      GITHUB_OUTPUT: join(dir, "output"),
      ...env,
    },
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    output: readFileSync(join(dir, "output"), "utf8"),
  };
};

const inventory = [
  "Stargrep/prod/output",
  "StargrepDatabase/shared/Project",
  "open-seo/pr-7/output",
  "Stargrep/pr-4/output",
  "Stargrep/pr-9/Worker",
  "Stargrep/pr-11/Branch",
  "Stargrep/pr-11/output",
  "Stargrep/pr-12/output",
  "Stargrep/pr-0/output",
  "Stargrep/pr-011/output",
  "Stargrep/pr-11evil/output",
].join("\n");

describe("preview-reconcile list step", () => {
  const list = stepRun("list", (step) => step.id === "list");

  test("marks Stargrep pull request stages that are closed or gone as stale", () => {
    const result = runStep(list, { INVENTORY: inventory, GH_STATES: "4=OPEN 9=OPEN 11=CLOSED" });
    expect(result.exitCode).toBe(0);
    expect(result.output.trim()).toBe("stale=[11,12]");
  });

  test("reports no stale stages when there are no pull request stages", () => {
    const result = runStep(list, { INVENTORY: "Stargrep/prod/output\nStargrepDatabase/shared/Project" });
    expect(result.exitCode).toBe(0);
    expect(result.output.trim()).toBe("stale=[]");
  });

  test.each([
    ["the declared shell", reconcile.defaults?.run?.shell ?? null],
    ["GitHub's implicit shell", null],
  ])("fails when the state inventory cannot be read, under %s", (_, shell) => {
    const result = runStep(list, { INVENTORY: "", INVENTORY_EXIT: "1" }, shell);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toBe("");
  });

  test("fails when GitHub cannot report a pull request's state", () => {
    const result = runStep(list, { INVENTORY: inventory, GH_FAIL: "HTTP 500: internal server error" });
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toBe("");
  });
});

describe("preview-reconcile destroy step", () => {
  const destroy = stepRun("destroy", (step) => step.run?.includes("destroy") ?? false).replaceAll(
    /\$\{\{ matrix\.number \}\}/g,
    "11",
  );
  const destroyWith = (env: Record<string, string>) => runStep(destroy, { STAGE: "pr-11", DRY_RUN: "false", ...env });

  test("destroys the stage of a closed pull request", () => {
    expect(destroyWith({ GH_STATES: "11=CLOSED" }).stdout).toContain("bun run --cwd infra destroy --stage pr-11 --yes");
  });

  test("keeps the stage of a reopened pull request", () => {
    const result = destroyWith({ GH_STATES: "11=OPEN" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("destroy --stage");
  });

  test("destroys nothing on a dry run", () => {
    const result = destroyWith({ GH_STATES: "11=CLOSED", DRY_RUN: "true" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Dry run: pr-11 would be destroyed");
    expect(result.stdout).not.toContain("destroy --stage");
  });

  test("fails when GitHub cannot report the pull request's state", () => {
    const result = destroyWith({ GH_FAIL: "HTTP 401: Bad credentials" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("destroy --stage");
  });
});
