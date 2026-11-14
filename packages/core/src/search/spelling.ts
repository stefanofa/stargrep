// Typed text shorter than this sits one edit from too many names, as "code" does from core.
export const shortest = 5;

// Typed text longer than this is a sentence, not a name, and its one-edit spellings would make a regular expression
// thousands of alternatives long.
export const longest = 64;

// The fewest insertions, deletions, substitutions, and swaps of two neighboring letters that turn one word into the
// other, counting no further than 2.
export const edits = (from: string, to: string): number => {
  if (Math.abs(from.length - to.length) > 1) return 2;
  let before: Array<number> = [];
  let previous = Array.from({ length: to.length + 1 }, (_, index) => index);
  for (let row = 1; row <= from.length; row++) {
    const current = [row];
    for (let column = 1; column <= to.length; column++) {
      const substitution = (previous[column - 1] ?? 0) + (from[row - 1] === to[column - 1] ? 0 : 1);
      const swap =
        row > 1 && column > 1 && from[row - 1] === to[column - 2] && from[row - 2] === to[column - 1]
          ? (before[column - 2] ?? 0) + 1
          : Number.POSITIVE_INFINITY;
      current[column] = Math.min((previous[column] ?? 0) + 1, (current[column - 1] ?? 0) + 1, substitution, swap);
    }
    before = previous;
    previous = current;
  }
  return Math.min(previous[to.length] ?? 0, 2);
};

// A text's letters and digits run together, as repo names are matched.
export const letters = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
