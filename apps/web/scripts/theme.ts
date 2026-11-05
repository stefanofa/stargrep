// Reads color tokens from the design system's theme.css, so generated files and checks use the values the app paints.
const css = await Bun.file(new URL(import.meta.resolve("@stargrep/ui/theme.css"))).text();

export const themeColor = (name: string) => {
  const value = css.match(new RegExp(`--color-${name}:\\s*([^;]+);`))?.[1];
  if (value === undefined) throw new Error(`theme.css has no --color-${name}`);
  const [, light = value, dark = value] = value.match(/^light-dark\((#[0-9a-f]+),\s*(#[0-9a-f]+)\)$/i) ?? [];
  return { light, dark };
};
