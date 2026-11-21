import { projectToken, proxyHost, uiHost } from "@stargrep/analytics/project";
import type { CaptureResult, PostHog, Properties } from "posthog-js/dist/module.no-external";

// Only prod's own host sends, so previews, localhost, and tests never load PostHog.
export const prodHost = "stargrep.com";
export const sends = (hostname: string) => hostname === prodHost;

const queryOfUrl = /(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/g;

const scrubbed = (value: unknown): unknown => {
  if (typeof value === "string") return value.replace(queryOfUrl, "$1");
  if (Array.isArray(value)) return value.map(scrubbed);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, scrubbed(entry)]));
  }
  return value;
};

const scrubbedProperties = (properties: Properties): Properties =>
  Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, scrubbed(value)]));

// A page's URL holds the query, its filters, and the open repo, and a referrer can hold another site's search. So every
// URL in an event, an error message's included, leaves without its query string and fragment.
export const scrub = ({ properties, $set, $set_once, ...rest }: CaptureResult): CaptureResult => ({
  ...rest,
  properties: scrubbedProperties(properties),
  ...($set === undefined ? {} : { $set: scrubbedProperties($set) }),
  ...($set_once === undefined ? {} : { $set_once: scrubbedProperties($set_once) }),
});

// The build that bundles what it runs and fetches no script from PostHog, so nothing such as session replay can load
// later. Cookieless mode keeps no cookie and nothing in storage, and PostHog's servers hash the visitor instead, so no
// banner asks for consent.
const load = async (): Promise<PostHog> => {
  const { posthog } = await import("posthog-js/dist/module.no-external");
  posthog.init(projectToken, {
    api_host: proxyHost,
    ui_host: uiHost,
    defaults: "2026-05-30",
    cookieless_mode: "always",
    capture_pageview: "history_change",
    capture_pageleave: true,
    autocapture: false,
    disable_session_recording: true,
    disable_surveys: true,
    advanced_disable_flags: true,
    disable_external_dependency_loading: true,
    before_send: scrub,
  });
  posthog.register({ stage: "prod" });
  return posthog;
};

let client: Promise<PostHog | undefined> | undefined;

const started = () => {
  client ??= load().catch(() => undefined);
  return client;
};

// The route's error page reports what it caught, and the window's error events report the rest.
export const reportError = (error: unknown) => {
  if (!sends(location.hostname)) return;
  void started().then((posthog) => posthog?.captureException(error));
};

// The events the browser sends for a visitor's action, with their properties. Autocapture is off, so each is named here
// and carries counts at most, never text.
interface ClientEvents {
  readonly github_star_clicked: undefined;
  readonly new_to_you_shown: { readonly shared: number; readonly repos: number };
  readonly new_to_you_opened: { readonly position: number };
  // Which of the repo panel's rows held the repo the visitor opened.
  readonly similar_repo_opened: { readonly row: "in_stars" | "not_starred" };
}

export type ClientEvent = keyof ClientEvents;

export const capture = <Event extends ClientEvent>(
  event: Event,
  ...[properties]: ClientEvents[Event] extends undefined ? [] : [ClientEvents[Event]]
) => {
  if (!sends(location.hostname)) return;
  void started().then((posthog) => posthog?.capture(event, properties));
};

// Called once the page has hydrated. PostHog loads in a chunk of its own when the browser is idle, so the landing page's
// first paint and its search engine never wait on it. PostHog's own error listeners load as a remote script, so the
// page listens itself.
export const startAnalytics = () => {
  if (!sends(location.hostname)) return;
  window.addEventListener("error", (event) => reportError(event.error ?? event.message));
  window.addEventListener("unhandledrejection", (event) => reportError(event.reason));
  if (typeof requestIdleCallback === "function") requestIdleCallback(() => void started(), { timeout: 5_000 });
  else void started();
};
