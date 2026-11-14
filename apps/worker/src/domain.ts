// The stargrep.com zone already exists in the account, so prod only references it and never creates or deletes it.
export const zone = "stargrep.com";

// Prod serves on one hostname. The main Worker holds the custom domain, which gives the hostname its DNS records and
// certificate, and a zone route sends every path to the web Worker. Routes take precedence over custom domains, so the
// custom domain stays on the main Worker and nothing detaches during a deploy. Until the route attaches, the custom
// domain sends every request to the main Worker, which answers /health itself.
export const prodWorkerHosting = {
  domain: { name: zone, zoneName: zone, redirects: [`www.${zone}`] },
  workersDev: false,
};

export const prodWebHosting = {
  routes: [{ pattern: `${zone}/*`, zoneName: zone }],
  workersDev: false,
};
