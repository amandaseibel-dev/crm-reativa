// `root` explícito: `npx vite --config <caminho>` NÃO muda a raiz, e sem isto
// o vite varre o index.html do checkout de onde o comando foi chamado.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const AQUI = dirname(fileURLToPath(import.meta.url));
export default {
  root: AQUI, appType: "mpa",
  server: { port: 5196, strictPort: true },
  optimizeDeps: { entries: ["preview-efetividade.html"] },
  resolve: { alias: [
    { find: /^.*\/services\/supabase$/, replacement: resolve(AQUI, ".preview/mock-supabase-efetividade.js") },
    { find: /^\.{1,2}\/supabase$/, replacement: resolve(AQUI, ".preview/mock-supabase-efetividade.js") },
  ] },
};
