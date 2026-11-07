import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Concurrency = { readonly group: string; readonly "cancel-in-progress"?: boolean; readonly queue?: string };
type Job = {
  readonly if?: string;
  readonly concurrency?: Concurrency;
  readonly steps: ReadonlyArray<{ readonly run?: string }>;
};
type Workflow = {
  readonly on: { readonly pull_request: { readonly types: ReadonlyArray<string> } };
  readonly concurrency?: Concurrency;
  readonly jobs: Record<string, Job>;
};

const root = new URL("..", import.meta.url).pathname;
const preview = Bun.YAML.parse(readFileSync(join(root, ".github/workflows/preview.yml"), "utf8")) as Workflow;
const job = preview.jobs.preview;
const head = "0123456789abcdef0123456789abcdef01234567";
// Evaluates the GitHub expressions this workflow uses: string literals, ==, !=, &&, ||, parentheses, and format().
// A missing property reads as null, as GitHub's does.
const evaluate = (expression: string, github: object) => {
  const js = expression
    .replaceAll(/'([^']*)'/g, (_, text: string) => JSON.stringify(text))
    .replaceAll(/([!=])=/g, "$1==")
    .replaceAll(/\b(github|vars)((?:\.[A-Za-z_]+)+)/g, (chain: string) => chain.replaceAll(".", "?."));
  const format = (template: string, ...values: ReadonlyArray<unknown>) =>
    values.reduce<string>((text, value, index) => text.replace(`{${index}}`, String(value)), template);
  return new Function("github", "vars", "format", `return (${js});`)(
    github,
    { CLOUDFLARE_ACCOUNT_ID: "account" },
    format,
  );
};
const interpolate = (template: string, github: object) =>
  template.replaceAll(/\$\{\{(.*?)\}\}/g, (_, expression: string) => String(evaluate(expression, github)));

const deployStep = interpolate(job?.steps.find((step) => step.run?.includes("infra deploy"))?.run ?? "", {
  event: { pull_request: { number: 7, head: { sha: head } } },
});

const mocks = mkdtempSync(join(tmpdir(), "preview-mocks-"));
const mock = (name: string, body: string) => {
  writeFileSync(join(mocks, name), `#!/bin/bash\n${body}`);
  chmodSync(join(mocks, name), 0o755);
};
mock("gh", `printf '%s\\n' "$PULL_REQUEST_NOW"\n`);
mock(
  "bunx",
  `case "$3" in
  list) printf '%s\\n' "$INVENTORY";;
  read) if [ -n "$OUTPUT_RECORD" ]; then printf 'reading state\\n%s\\n' "$OUTPUT_RECORD"; else echo "no record" >&2; exit 1; fi;;
esac
`,
);
mock("bun", `echo "bun $* provider=$STARGREP_AI_PROVIDER"\n`);

const deploy = (env: {
  readonly labels: "preview-ai" | "none";
  readonly inventory?: string;
  readonly output?: object;
}) => {
  const dir = mkdtempSync(join(tmpdir(), "preview-step-"));
  writeFileSync(join(dir, "step.sh"), deployStep);
  const result = Bun.spawnSync(["bash", "--noprofile", "--norc", "-eo", "pipefail", join(dir, "step.sh")], {
    cwd: root,
    env: {
      PATH: `${mocks}:${process.env.PATH}`,
      GITHUB_REPOSITORY: "stefanofa/stargrep",
      STAGE: "pr-7",
      PULL_REQUEST_NOW: `OPEN ${head} ${env.labels === "preview-ai" ? "gateway" : "fake"}`,
      INVENTORY: env.inventory ?? "",
      OUTPUT_RECORD: env.output === undefined ? "" : JSON.stringify(env.output, null, 2),
    },
  });
  const ran = result.stdout
    .toString()
    .split("\n")
    .filter((line) => line.startsWith("bun "));
  return { exitCode: result.exitCode, ran };
};

const deployed = (provider: string) => [
  `bun run --cwd infra deploy --stage pr-7 --yes provider=${provider}`,
  `bun scripts/stage-smoke.ts pr-7 provider=${provider}`,
];
const recreated = (provider: string) => [
  `bun run --cwd infra destroy --stage pr-7 --yes provider=${provider}`,
  ...deployed(provider),
];
const existing = "Stargrep/pr-70/output\nStargrep/pr-7/Branch\nStargrep/pr-7/output";

describe("preview deploy step", () => {
  test("deploys a new pull request's stage on the fakes", () => {
    expect(deploy({ labels: "none", inventory: "Stargrep/pr-70/output" })).toEqual({
      exitCode: 0,
      ran: deployed("fake"),
    });
  });

  test("deploys in place when the stage already runs on the provider the labels ask for", () => {
    expect(deploy({ labels: "none", inventory: existing, output: { aiProvider: "fake" } }).ran).toEqual(
      deployed("fake"),
    );
    expect(deploy({ labels: "preview-ai", inventory: existing, output: { aiProvider: "gateway" } }).ran).toEqual(
      deployed("gateway"),
    );
  });

  test("destroys the stage before deploying it on the provider the labels now ask for", () => {
    expect(deploy({ labels: "preview-ai", inventory: existing, output: { aiProvider: "fake" } }).ran).toEqual(
      recreated("gateway"),
    );
    expect(deploy({ labels: "none", inventory: existing, output: { aiProvider: "gateway" } }).ran).toEqual(
      recreated("fake"),
    );
  });

  test("recreates a stage deployed before stages recorded their provider, or cut off before its output", () => {
    expect(deploy({ labels: "none", inventory: existing, output: { url: "https://worker" } }).ran).toEqual(
      recreated("fake"),
    );
    expect(deploy({ labels: "none", inventory: "Stargrep/pr-7/Branch" }).ran).toEqual(recreated("fake"));
  });
});

const event = (action: string, extra: { readonly label?: string; readonly headRepository?: string } = {}) => ({
  repository: "stefanofa/stargrep",
  run_id: 101,
  event: {
    action,
    ...(extra.label === undefined ? {} : { label: { name: extra.label } }),
    pull_request: { number: 7, head: { repo: { full_name: extra.headRepository ?? "stefanofa/stargrep" } } },
  },
});
const events = {
  push: event("synchronize"),
  "preview-ai added": event("labeled", { label: "preview-ai" }),
  "preview-ai removed": event("unlabeled", { label: "preview-ai" }),
  "another label": event("labeled", { label: "bug" }),
  "a fork's push": event("synchronize", { headRepository: "someone/stargrep" }),
};

describe("preview triggers and concurrency", () => {
  test("label changes start the workflow", () => {
    expect(preview.on.pull_request.types).toEqual(["opened", "reopened", "synchronize", "labeled", "unlabeled"]);
  });

  test("a running preview is never cancelled, and stage operations queue on the pull request's deploy lock", () => {
    expect(preview.concurrency?.["cancel-in-progress"]).toBe(false);
    expect(job?.concurrency?.["cancel-in-progress"]).toBeUndefined();
    expect(job?.concurrency?.queue).toBe("max");
  });

  test("pushes and preview-ai changes share one group, any other label waits for nothing, and only same-repo heads deploy", () => {
    const matrix = Object.fromEntries(
      Object.entries(events).map(([name, github]) => [
        name,
        {
          group: interpolate(preview.concurrency?.group ?? "", github),
          lock: interpolate(job?.concurrency?.group ?? "", github),
          deploys: Boolean(evaluate(job?.if ?? "", github)),
        },
      ]),
    );
    expect(matrix).toEqual({
      push: { group: "preview-7", lock: "deploy-pr-7", deploys: true },
      "preview-ai added": { group: "preview-7", lock: "deploy-pr-7", deploys: true },
      "preview-ai removed": { group: "preview-7", lock: "deploy-pr-7", deploys: true },
      "another label": { group: "preview-7-101", lock: "deploy-pr-7", deploys: false },
      "a fork's push": { group: "preview-7", lock: "deploy-pr-7", deploys: false },
    });
  });
});
