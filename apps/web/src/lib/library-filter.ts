import { dead } from "./dead-stars.ts";
import type { LibraryEntry } from "./library-collection.ts";

// The library's filters from the page's params, every one that is set at once. starredAt is an ISO time in UTC, so it
// starts with the month or the day a starred filter names.
export const libraryFilter =
  (lang: string | undefined, archived: boolean, starred = "", topic?: string) =>
  (entry: LibraryEntry) =>
    (lang === undefined || entry.language === lang) &&
    (!archived || dead(entry)) &&
    entry.starredAt.startsWith(starred) &&
    (topic === undefined || entry.topics.includes(topic));
