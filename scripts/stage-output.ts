import { $ } from "bun";

const infra = new URL("../infra", import.meta.url).pathname;

export const readStageOutput = async (stage: string, alchemyArgs: ReadonlyArray<string> = []) => {
  const text = await $`bunx alchemy state read ${`Stargrep/${stage}/output`} ${alchemyArgs}`.cwd(infra).quiet().text();
  const start = text.search(/^\{/m);
  if (start < 0) throw new Error(`Stage ${stage} has no output record`);
  const output = JSON.parse(text.slice(start)) as { debugUrl?: string; debugToken?: { __redacted__?: string } };
  const debugUrl = output.debugUrl;
  const debugToken = output.debugToken?.__redacted__;
  if (!debugUrl || !debugToken) throw new Error(`Stage ${stage} has no debug worker`);
  return { debugUrl, debugToken };
};

if (import.meta.main) {
  const [stage, field, ...alchemyArgs] = process.argv.slice(2);
  if (!stage || (field !== "debugUrl" && field !== "debugToken")) {
    throw new Error("usage: bun scripts/stage-output.ts <stage> debugUrl|debugToken [alchemy state read flags]");
  }
  process.stdout.write((await readStageOutput(stage, alchemyArgs))[field]);
}
