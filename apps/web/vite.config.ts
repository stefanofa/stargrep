import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss(), tanstackStart(), viteReact()],
  // A font inlined into the render-blocking stylesheet is downloaded on every page, even where no glyph needs it.
  build: { assetsInlineLimit: (file) => (file.endsWith(".woff2") ? false : undefined) },
});
