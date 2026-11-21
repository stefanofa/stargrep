import { mock } from "bun:test";

// PostHog itself, as the browser would load it on prod. The page keeps the client it loaded for its life, so every test
// file that captures shares this one and reads what it sent from captured.
export const captured: Array<readonly [string, unknown]> = [];

const posthog = {
  init: () => {},
  register: () => {},
  capture: (event: string, properties: unknown) => void captured.push([event, properties]),
  captureException: () => {},
};

mock.module("posthog-js/dist/module.no-external", () => ({ posthog }));
