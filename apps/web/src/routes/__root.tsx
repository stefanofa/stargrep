import fredoka from "@stargrep/ui/fonts/fredoka-latin-600-normal.woff2?url";
import inter from "@stargrep/ui/fonts/inter-latin-wght-normal.woff2?url";
import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import styles from "../styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { title: "Stargrep" },
      { name: "description", content: "Search your GitHub stars in plain words." },
      { name: "theme-color", content: "#f5f2ff", media: "(prefers-color-scheme: light)" },
      { name: "theme-color", content: "#15131f", media: "(prefers-color-scheme: dark)" },
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
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <Outlet />
        <Scripts />
      </body>
    </html>
  ),
});
