// The text a quote is matched on. Link, reference, emphasis, inline code, HTML tag, heading, list, quote-block, and
// table syntax come out, then the text is lowercased with whitespace collapsed. The prompt input and the quote both go
// through it, so a model that quotes the rendered README still matches.
export const evidenceText = (text: string): string =>
  text
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")
    .replace(/\[([^\]\n]*)\]\[[^\]\n]*\]/g, "$1")
    .replace(/\[([^\]\n]+)\]/g, "$1")
    .replace(/<\/?[a-z][^>\n]*>/gi, " ")
    .replace(/(\*\*|__|~~|\*|`)/g, "")
    .replace(/(^|\s)_+|_+(\s|$)/g, "$1$2")
    .replace(/^[ \t]*(#{1,6}|>|[-*+]|\d+\.)[ \t]+/gm, "")
    .replace(/\|/g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
