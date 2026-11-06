import fredoka from "@stargrep/ui/fonts/fredoka-latin-600-normal.woff2?url";
import inter from "@stargrep/ui/fonts/inter-latin-wght-normal.woff2?url";
import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { loadSession } from "../lib/load-page.ts";
import styles from "../styles.css?url";

export const Route = createRootRoute({
  loader: loadSession,
  staleTime: Number.POSITIVE_INFINITY,
  shouldReload: false,
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { title: "Stargrep" },
      { name: "description", content: "Search your GitHub stars in plain words." },
    ],
    links: [
      { rel: "preload", href: fredoka, as: "font", type: "font/woff2", crossOrigin: "anonymous" },
      { rel: "preload", href: inter, as: "font", type: "font/woff2", crossOrigin: "anonymous" },
      { rel: "stylesheet", href: styles },
      { rel: "icon", href: "/favicon.ico", sizes: "32x32" },
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
      { rel: "manifest", href: "/manifest.webmanifest" },
    ],
  }),
  component: () => (
    // The demo page's reveal script marks <html> before hydration, so its attribute is expected to differ from the server's.
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        {/* HeadContent keeps one meta per name, so the two theme colors render here instead. */}
        <meta name="theme-color" content="#f5f2ff" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#15131f" media="(prefers-color-scheme: dark)" />
      </head>
      <body>
        <Outlet />
        <Scripts />
      </body>
    </html>
  ),
});
