const removals: ReadonlyArray<RegExp> = [
  /<!--[\s\S]*?-->/g,
  /<(picture|svg|video)\b[\s\S]*?<\/\1>/gi,
  /<(img|source|br|hr)\b[^>]*>/gi,
  /!\[[^\]]*\]\([^)]*\)/g,
  /!\[[^\]]*\]\[[^\]]*\]/g,
  /\[\s*\]\([^)]*\)/g,
  /\[\s*\]\[[^\]]*\]/g,
  /^\s*\[[^\]]+\]:\s*\S+.*$/gm,
];

const tag = /<\/?[a-z][^>]*>/gi;
const blankRuns = /\n[ \t]*(\n[ \t]*)+/g;
const trailingSpace = /[ \t]+$/gm;
const wordCharacter = /[\p{L}\p{N}]/u;

export const readmeText = (readme: string): string | null => {
  const text = removals
    .reduce((current, pattern) => current.replace(pattern, ""), readme)
    .replace(tag, "")
    .replace(trailingSpace, "")
    .replace(blankRuns, "\n\n")
    .trim();
  return wordCharacter.test(text) ? text : null;
};
