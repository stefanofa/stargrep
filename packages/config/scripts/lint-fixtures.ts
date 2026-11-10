for (const suite of ["no-raw-tracer", "api-handler-errors", "no-repos-kind"]) {
  const fixtures = new URL(`../fixtures/${suite}/`, import.meta.url).pathname;
  const expected: Record<string, number> = await Bun.file(`${fixtures}expected.json`).json();

  const lint = Bun.spawnSync(["bunx", "biome", "lint", "--max-diagnostics=none", "--colors=off", "."], {
    cwd: fixtures,
  });
  const output = `${lint.stdout.toString()}${lint.stderr.toString()}`;
  const found: Record<string, number> = {};
  for (const [, file] of output.matchAll(/^(\S+\.ts):\d+:\d+ plugin/gm)) {
    if (file !== undefined) found[file] = (found[file] ?? 0) + 1;
  }

  const wrong = Object.keys({ ...expected, ...found })
    .sort()
    .filter((file) => (found[file] ?? 0) !== (expected[file] ?? 0))
    .map((file) => `${file}: expected ${expected[file] ?? 0} diagnostics, found ${found[file] ?? 0}`);

  const total = Object.values(found).reduce((sum, count) => sum + count, 0);
  if (wrong.length > 0) {
    console.error(wrong.join("\n"));
    process.exit(1);
  }
  console.log(`${suite} fixtures: ${total} diagnostics in ${Object.keys(expected).length} files, as expected`);
}
