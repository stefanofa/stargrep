import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Step = {
  readonly id?: string;
  readonly run?: string;
  readonly shell?: string;
  readonly uses?: string;
  readonly with?: Readonly<Record<string, string>>;
  readonly if?: string;
};
type Concurrency = {
  readonly group: string;
  readonly queue?: string;
  readonly "cancel-in-progress"?: boolean | string;
};
type Job = {
  readonly if?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly environment?: string | { readonly name: string };
  readonly concurrency?: Concurrency;
  readonly steps: ReadonlyArray<Step>;
};
type Workflow = {
  readonly on?: {
    readonly workflow_run?: {
      readonly workflows: ReadonlyArray<string>;
      readonly types: ReadonlyArray<string>;
      readonly branches: ReadonlyArray<string>;
    };
    readonly workflow_dispatch?: null;
    readonly push?: unknown;
  };
  readonly concurrency?: Concurrency;
  readonly defaults?: { readonly run?: { readonly shell?: string } };
  readonly env?: Record<string, string>;
  readonly jobs: Record<string, Job>;
};

const workflows = new URL("../.github/workflows", import.meta.url).pathname;
const names = readdirSync(workflows).filter((file) => file.endsWith(".yml"));
const load = (name: string) => Bun.YAML.parse(readFileSync(join(workflows, name), "utf8")) as Workflow;

describe("workflow shell", () => {
  test("every workflow runs its steps in bash with pipefail", () => {
    for (const name of names) {
      const workflow = load(name);
      const runSteps = Object.values(workflow.jobs).flatMap((job) => job.steps.filter((step) => step.run));
      if (runSteps.length === 0) continue;
      expect({ name, shell: workflow.defaults?.run?.shell }).toEqual({ name, shell: "bash" });
      expect(runSteps.filter((step) => step.shell !== undefined)).toEqual([]);
    }
  });
});

describe("workflow secrets", () => {
  const jobs = names.flatMap((name) => {
    const workflow = load(name);
    return Object.entries(workflow.jobs).map(([id, job]) => ({
      job: `${name}:${id}`,
      environment: (typeof job.environment === "string" ? job.environment : job.environment?.name) ?? "none",
      readsSecrets: JSON.stringify([workflow.env, job]).includes("secrets."),
      readsAppKey: JSON.stringify([workflow.env, job]).includes("STARGREP_GITHUB_APP_PRIVATE_KEY"),
    }));
  });

  test("only the prod deploy reads the GitHub App's private key", () => {
    expect(jobs.filter((job) => job.readsAppKey).map((job) => job.job)).toEqual(["deploy.yml:prod"]);
  });

  test("the prod deploy reads secrets from production and every preview job from preview", () => {
    expect(Object.fromEntries(jobs.filter((job) => job.readsSecrets).map((job) => [job.job, job.environment]))).toEqual(
      {
        "deploy.yml:prod": "production",
        "preview.yml:preview": "preview",
        "preview-destroy.yml:destroy": "preview",
        "preview-reconcile.yml:list": "preview",
        "preview-reconcile.yml:destroy": "preview",
      },
    );
  });

  test("only the prod deploy uses the production environment", () => {
    expect(jobs.filter((job) => job.environment === "production").map((job) => job.job)).toEqual(["deploy.yml:prod"]);
  });
});

describe("workflow concurrency", () => {
  const groups = names.flatMap((name) => {
    const workflow = load(name);
    return [
      { at: name, concurrency: workflow.concurrency },
      ...Object.entries(workflow.jobs).map(([id, job]) => ({ at: `${name}:${id}`, concurrency: job.concurrency })),
    ].flatMap(({ at, concurrency }) => (concurrency === undefined ? [] : [{ at, ...concurrency }]));
  });

  test("a newer push to a pull request cancels its ci run, and never a running preview", () => {
    const cancelling = groups.filter((group) => group["cancel-in-progress"] !== undefined);
    expect(Object.fromEntries(cancelling.map((group) => [group.at, group["cancel-in-progress"]]))).toEqual({
      "ci.yml": "${{ github.event_name == 'pull_request' }}",
      "preview.yml": false,
    });
  });

  test("every deploy and destroy queues in a deploy group that nothing cancels", () => {
    const deploys = groups.filter(({ group }) => group.startsWith("deploy-"));
    expect(deploys.map(({ at }) => at).sort()).toEqual([
      "deploy.yml:prod",
      "preview-destroy.yml:destroy",
      "preview-reconcile.yml:destroy",
      "preview.yml:preview",
    ]);
    expect(deploys.filter((group) => group.queue !== "max" || group["cancel-in-progress"] !== undefined)).toEqual([]);
  });
});

describe("production validation", () => {
  test("automatic deploys follow completed main CI and checkout its exact SHA", () => {
    const workflow = load("deploy.yml");
    expect(workflow.on?.workflow_run).toEqual({ workflows: ["ci"], types: ["completed"], branches: ["main"] });
    expect(workflow.on).toHaveProperty("workflow_dispatch");
    expect(workflow.on).not.toHaveProperty("push");
    const prod = workflow.jobs.prod;
    expect(prod?.if?.replace(/\s+/g, " ").trim()).toBe(
      "vars.CLOUDFLARE_ACCOUNT_ID != '' && " +
        "((github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main') || " +
        "(github.event_name == 'workflow_run' && github.event.workflow_run.conclusion == 'success' && " +
        "github.event.workflow_run.event == 'push' && github.event.workflow_run.head_branch == 'main' && " +
        "github.event.workflow_run.head_repository.full_name == github.repository))",
    );
    expect(prod?.env?.DEPLOY_SHA).toBe(
      "${{ github.event_name == 'workflow_run' && github.event.workflow_run.head_sha || github.sha }}",
    );
    expect(prod?.steps.find((step) => step.uses?.startsWith("actions/checkout@"))?.with?.ref).toBe(
      "${{ env.DEPLOY_SHA }}",
    );
    const run = prod?.steps.find((step) => step.id === "deploy")?.run ?? "";
    expect(run).toContain('if [ "$head" != "$DEPLOY_SHA" ]');
    expect(run).toContain('if [ "$GITHUB_EVENT_NAME" = workflow_dispatch ]');
    expect(run).toContain("branch=main&event=push&head_sha=$DEPLOY_SHA&status=success");
    expect(run).toContain('if [ "$passed" -eq 0 ]');
    expect(run.indexOf('if [ "$head"')).toBeLessThan(run.indexOf("bun run --cwd infra deploy"));
    expect(
      prod?.steps.find((step) => step.run === "bun scripts/stage-smoke.ts --public https://stargrep.com")?.if,
    ).toBe("steps.deploy.outputs.deployed == 'true'");
  });

  test("CI checks lint fixtures", () => {
    expect(load("ci.yml").jobs.lint?.steps.some((step) => step.run === "bun run lint:fixtures")).toBe(true);
  });
});
