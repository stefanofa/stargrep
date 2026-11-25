import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig, type Plugin, type Rollup } from "vite";
import { topicLogos } from "./topic-logos.ts";

const engineModule = /\/src\/components\/stars\.tsx(\?|$)/;

// The engine loads through import(), so Start's manifest leaves it out of the HTML and the browser asks for it only
// once the entry runs. The client builds before the server, so the server learns the engine's chunks from the client's
// bundle, leaving out the ones the entry already preloads, and a page that hydrates the engine preloads them.
const engineChunks = (): Plugin => {
  let chunks: ReadonlyArray<string> = [];
  return {
    name: "stargrep:engine-chunks",
    enforce: "pre",
    generateBundle(_options, bundle) {
      if (this.environment.name !== "client") return;
      const files = Object.values(bundle).filter((file): file is Rollup.OutputChunk => file.type === "chunk");
      const byName = new Map(files.map((chunk) => [chunk.fileName, chunk]));
      const reached = (roots: ReadonlyArray<Rollup.OutputChunk>) => {
        const seen = new Set<string>();
        const visit = (chunk: Rollup.OutputChunk | undefined) => {
          if (chunk === undefined || seen.has(chunk.fileName)) return;
          seen.add(chunk.fileName);
          for (const name of chunk.imports) visit(byName.get(name));
        };
        for (const chunk of roots) visit(chunk);
        return seen;
      };
      const entry = reached(files.filter((chunk) => chunk.isEntry));
      const engine = reached(files.filter((chunk) => chunk.moduleIds.some((id) => engineModule.test(id))));
      if (engine.size === 0) throw new Error("no chunk holds src/components/stars.tsx, so the engine moved");
      chunks = [...engine].filter((name) => !entry.has(name)).map((name) => `${this.environment.config.base}${name}`);
    },
    transform(code) {
      if (this.environment.name !== "ssr" || !code.includes("import.meta.env.STARGREP_ENGINE")) return;
      const json = JSON.stringify(JSON.stringify(chunks));
      return { code: code.replaceAll("import.meta.env.STARGREP_ENGINE", json), map: null };
    },
  };
};

export default defineConfig({
  plugins: [engineChunks(), topicLogos(), tailwindcss(), tanstackStart(), viteReact()],
  // A font inlined into the render-blocking stylesheet is downloaded on every page, even where no glyph needs it.
  build: { assetsInlineLimit: (file) => (file.endsWith(".woff2") ? false : undefined) },
});
