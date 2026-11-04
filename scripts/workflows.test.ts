import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Step = { readonly run?: string; readonly shell?: string };
type Job = { readonly environment?: string | { readonly name: string }; readonly steps: ReadonlyArray<Step> };
type Workflow = {
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
