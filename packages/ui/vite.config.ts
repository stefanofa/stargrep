import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "gallery",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "../dist/gallery",
    emptyOutDir: true,
    assetsInlineLimit: 0,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: "react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            { name: "components", test: /packages[\\/]ui[\\/]src[\\/]|node_modules[\\/]/ },
          ],
        },
      },
    },
  },
});
