import { $ } from "bun";

const infra = new URL("../infra", import.meta.url).pathname;

export const readStageOutput = async (stage: string, alchemyArgs: ReadonlyArray<string> = []) => {
  const text = await $`bunx alchemy state read ${`Stargrep/${stage}/output`} ${alchemyArgs}`.cwd(infra).quiet().text();
  const start = text.search(/^\{/m);
  if (start < 0) throw new Error(`Stage ${stage} has no output record`);
  const output = JSON.parse(text.slice(start)) as {
    url?: string;
    debugUrl?: string;
    debugToken?: { __redacted__?: string };
    webUrl?: string;
  };
  const { url, debugUrl, webUrl } = output;
  const debugToken = output.debugToken?.__redacted__;
  if (!debugUrl || !debugToken) throw new Error(`Stage ${stage} has no debug worker`);
  if (!webUrl) throw new Error(`Stage ${stage} has no web worker`);
  if (!url) throw new Error(`Stage ${stage} has no worker URL`);
  return { url, debugUrl, debugToken, webUrl };
};

if (import.meta.main) {
  const [stage, field, ...alchemyArgs] = process.argv.slice(2);
  if (!stage || (field !== "url" && field !== "debugUrl" && field !== "debugToken" && field !== "webUrl")) {
    throw new Error(
      "usage: bun scripts/stage-output.ts <stage> url|debugUrl|debugToken|webUrl [alchemy state read flags]",
    );
  }
  process.stdout.write((await readStageOutput(stage, alchemyArgs))[field]);
}
