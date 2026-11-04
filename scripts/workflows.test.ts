import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Step = { readonly run?: string; readonly shell?: string };
type Concurrency = {
  readonly group: string;
  readonly queue?: string;
  readonly "cancel-in-progress"?: boolean | string;
};
type Job = {
  readonly environment?: string | { readonly name: string };
  readonly concurrency?: Concurrency;
  readonly steps: ReadonlyArray<Step>;
};
type Workflow = {
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
    }));
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

  test("a newer push to a pull request cancels its ci and preview runs", () => {
    const cancelling = groups.filter((group) => group["cancel-in-progress"] !== undefined);
    expect(Object.fromEntries(cancelling.map((group) => [group.at, group["cancel-in-progress"]]))).toEqual({
      "ci.yml": "${{ github.event_name == 'pull_request' }}",
      "preview.yml": true,
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
