import { gzipSync } from "node:zlib";

export const budget = 130_000;

export const forbidden: ReadonlyArray<readonly [name: string, module: RegExp]> = [
  ["Effect", /\/node_modules\/effect\//],
  ["TanStack DB", /\/node_modules\/@tanstack\/(react-)?db\//],
  ["skullet", /\/node_modules\/skullet\//],
  ["oRPC client", /\/node_modules\/@orpc\//],
];

const indexRoute = /\/src\/routes\/index\.tsx(\?|$)/;

export interface Chunk {
  readonly fileName: string;
  readonly code: string;
  readonly isEntry: boolean;
  readonly imports: ReadonlyArray<string>;
  readonly moduleIds: ReadonlyArray<string>;
}

export interface Audit {
  readonly chunks: ReadonlyArray<{ readonly fileName: string; readonly gzipped: number }>;
  readonly total: number;
  readonly found: ReadonlyArray<{ readonly name: string; readonly fileName: string; readonly module: string }>;
}

export const landingChunks = (chunks: ReadonlyArray<Chunk>): ReadonlyArray<Chunk> => {
  const entries = chunks.filter((chunk) => chunk.isEntry);
  if (entries.length !== 1) throw new Error(`expected one entry chunk, found ${entries.length}`);
  const routes = chunks.filter((chunk) => chunk.moduleIds.some((id) => indexRoute.test(id)));
  if (routes.length === 0) throw new Error("no chunk holds src/routes/index.tsx, so the landing route moved");
  const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  const loaded = new Set<string>();
  const visit = (chunk: Chunk) => {
    if (loaded.has(chunk.fileName)) return;
    loaded.add(chunk.fileName);
    for (const name of chunk.imports) {
      const imported = byName.get(name);
      if (imported !== undefined) visit(imported);
    }
  };
  for (const chunk of [...entries, ...routes]) visit(chunk);
  return chunks.filter((chunk) => loaded.has(chunk.fileName));
};

export const audit = (chunks: ReadonlyArray<Chunk>): Audit => {
  const landing = landingChunks(chunks);
  const sized = landing.map((chunk) => ({
    fileName: chunk.fileName,
    gzipped: gzipSync(chunk.code, { level: 9 }).byteLength,
  }));
  const found = landing.flatMap((chunk) =>
    forbidden.flatMap(([name, module]) => {
      const hit = chunk.moduleIds.find((id) => module.test(id));
      return hit === undefined ? [] : [{ name, fileName: chunk.fileName, module: hit }];
    }),
  );
  return { chunks: sized, total: sized.reduce((sum, chunk) => sum + chunk.gzipped, 0), found };
};

const buildClient = async (root: string): Promise<ReadonlyArray<Chunk>> => {
  const { createBuilder } = await import("vite");
  const builder = await createBuilder({ root, logLevel: "warn", build: { write: false } });
  const client = builder.environments.client;
  if (client === undefined) throw new Error("vite config has no client environment");
  const result = await builder.build(client);
  const outputs = Array.isArray(result) ? result : [result];
  return outputs.flatMap((output) =>
    "output" in output ? output.output.flatMap((item) => (item.type === "chunk" ? [item] : [])) : [],
  );
};

if (import.meta.main) {
  const report = audit(await buildClient(new URL("..", import.meta.url).pathname));
  const lines = [
    ...report.chunks.map((chunk) => `${String(chunk.gzipped).padStart(8)} B gz  ${chunk.fileName}`),
    `${String(report.total).padStart(8)} B gz  landing JS, budget ${budget}`,
  ];
  const problems = [
    ...report.found.map((hit) => `${hit.name} in landing chunk ${hit.fileName}: ${hit.module}`),
    ...(report.total > budget ? [`landing JS is ${report.total - budget} B over budget`] : []),
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
  if (problems.length > 0) {
    process.stderr.write(`${problems.join("\n")}\n`);
    process.exit(1);
  }
}
