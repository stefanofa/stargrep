import { kinds, roleIds, roles, traits } from "./registry.ts";

const kindList = kinds.map((kind) => kind.id).join(", ");
const traitList = traits.join(", ");

// The facets block of the summary prompt. Role lines come from the registry in its order, so the prompt, the decoder's
// lanes, and the SQL columns name the same roles. No vocabulary enters the prompt beyond the kinds and the traits.
export const extractionLines = (): ReadonlyArray<string> => [
  `- facets: up to 12 facts about the repo, each {"role", "term", "quote"}.`,
  `  - term: one thing, named the way developers write it, as a short noun phrase of at most three words, such as "PostgreSQL", "terminal UI", or "self-hosted". Never join two things in one term, with "and" or otherwise: "rust cli" is two facts, a written_in and an is.`,
  `  - quote: the exact words from the description, topics, or README that support the fact. Quote the text itself, never a line label such as "Topics:".`,
  "  Roles:",
  ...roleIds.flatMap((role) => {
    const prompt = roles[role].prompt;
    return prompt === null
      ? []
      : [`  - ${role}: ${prompt.replace("{kinds}", kindList).replace("{traits}", traitList)}`];
  }),
  "  Leave out anything the input does not support, except the kind. Never write open-source, hacktoberfest, awesome, or the repo's own name as a fact.",
];
