import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { renameSync } from "fs";
import { resolve } from "path";

// Plugin que renomeia o HTML de saída para index.html após o build,
// necessário porque o Netlify serve apenas index.html como página raiz.
function renameHtmlOutput() {
  return {
    name: "rename-tv-html",
    closeBundle() {
      renameSync(
        resolve("dist-tv/index-tv.html"),
        resolve("dist-tv/index.html"),
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), renameHtmlOutput()],
  build: {
    rollupOptions: {
      input: "index-tv.html",
    },
    outDir: "dist-tv",
    emptyOutDir: true,
  },
  publicDir: "public",
});
