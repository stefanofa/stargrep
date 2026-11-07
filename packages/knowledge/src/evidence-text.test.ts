import { describe, expect, test } from "bun:test";
import fixture from "./evidence-text.fixture.json";
import { evidenceText } from "./evidence-text.ts";

// 65 quotes a model wrote for public repos that the prompt input does not contain verbatim, each with the lines of
// that input it was quoting from. 59 quote the rendered README. 6 cite a line label, invent a name, paraphrase, splice
// with an ellipsis, or change a symbol.
const found = (input: string, quote: string) => evidenceText(input).includes(evidenceText(quote));
const verbatim = (input: string, quote: string) =>
  input.toLowerCase().replace(/\s+/g, " ").includes(quote.toLowerCase().replace(/\s+/g, " ").trim());

describe("evidenceText", () => {
  test("matches the 59 recorded quotes that differ from their input only in markdown", () => {
    const rendered = fixture.filter((row) => row.matches);
    expect(rendered).toHaveLength(59);
    for (const row of rendered) {
      expect([row.repo, row.quote, verbatim(row.input, row.quote)]).toEqual([row.repo, row.quote, false]);
      expect([row.repo, row.quote, found(row.input, row.quote)]).toEqual([row.repo, row.quote, true]);
    }
  });

  test("still refuses the 6 recorded quotes that are not in their input", () => {
    const refused = fixture.filter((row) => !row.matches);
    expect(refused.map((row) => `${row.repo}: ${row.quote}`)).toEqual([
      "Infisical/infisical: topics: vault",
      "RocketChat/Rocket.Chat: topics: slack",
      "vitejs/vite: Vite is a build tool that aims to provide a faster and leaner development experience for modern web projects.",
      "PaddlePaddle/PaddleSpeech: ESPnet",
      "cosscom/ui: Special thanks to: ... shadcn/ui ... For inspiring our copy-paste approach and component philosophy",
      "SigNoz/signoz: Community: Free open-source SigNoz that runs in your own infrastructure.",
    ]);
    for (const row of refused) expect([row.repo, found(row.input, row.quote)]).toEqual([row.repo, false]);
  });

  test("strips link, emphasis, code, heading, list, quote-block, and table syntax", () => {
    expect(
      evidenceText(
        "# Title\n> Powered by [**Cloudflare** Tunnels](https://x.dev) and `bun`\n- one | two\n1. _three_ ~~four~~",
      ),
    ).toBe("title powered by cloudflare tunnels and bun one two three four");
  });
});
