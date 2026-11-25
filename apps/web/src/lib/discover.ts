import { useSyncExternalStore } from "react";

// Discover's two segments, each on its own address: /people and /topics.
export type Segment = "people" | "topics";

// The cookie that remembers the segment this browser opened last.
export const segmentCookie = "stargrep-discover";

const topicsLast = new RegExp(`${segmentCookie}=topics`);

// The segment this browser opened last, people until it opens topics.
export const rememberedSegment = (cookies: string): Segment => (topicsLast.test(cookies) ? "topics" : "people");

const unwatched = () => () => {};

// The segment discover opens on. The server paints the one its cookie named, and the browser reads the cookie again on
// every render, so a segment opened since the page loaded counts.
export const useDiscoverSegment = (painted: Segment) =>
  useSyncExternalStore(
    unwatched,
    () => rememberedSegment(document.cookie),
    () => painted,
  );
