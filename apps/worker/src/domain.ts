// The stargrep.com zone already exists in the account, so prod only references it and never creates or deletes it.
export const zone = "stargrep.com";

// Prod serves on one hostname: the main Worker holds the custom domain and answers /health, and a broader zone route
// sends every other path to the web Worker. Routes take precedence over custom domains, so the hostname never moves.
export const prodWorkerHosting = {
  domain: { name: zone, zoneName: zone, redirects: [`www.${zone}`] },
  routes: [{ pattern: `${zone}/health`, zoneName: zone }],
  workersDev: false,
};

export const prodWebHosting = {
  routes: [{ pattern: `${zone}/*`, zoneName: zone }],
  workersDev: false,
};
