// Stargrep's PostHog project on US Cloud. The token is public: every browser sends it with every event.
export const projectToken = "phc_BBFkSM8BaAW2izSvsgFpWiaMZ6Fntr7i4cyCpkwioXjr";
// Browsers send through PostHog's managed reverse proxy on Stargrep's zone, a host ad blockers do not list.
export const proxyHost = "https://tortilla.stargrep.com";
export const uiHost = "https://us.posthog.com";
// Workers send straight to US Cloud, since no ad blocker sits between them.
export const captureHost = "https://us.i.posthog.com";
