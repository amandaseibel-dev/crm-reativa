// Config exclusiva da revisão visual da Efetividade. Troca só a camada de
// serviço: o componente que aparece na tela é o do PR.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";

// `root` explícito: sem isto o preview só sobe quando o `npx vite` roda a
// partir da raiz do projeto, e falha silenciosamente a partir de um worktree.
const raiz = fileURLToPath(new URL(".", import.meta.url));

export default {
  root: raiz,
  appType: "mpa",
  server: { port: 5202, strictPort: true },
  plugins: [
    react(),
    {
      name: "preview-efetividade-fallback",
      configureServer(servidor) {
        servidor.middlewares.use((req, _res, proximo) => {
          if (req.url && !req.url.includes(".") && !req.url.startsWith("/@")) {
            req.url = "/preview-efetividade.html";
          }
          proximo();
        });
      },
    },
  ],
  resolve: {
    alias: [
      { find: /^.*\/services\/supabase$/, replacement: resolve(raiz, ".preview/mock-supabase-efetividade.js") },
      { find: /^\.{1,2}\/supabase$/,      replacement: resolve(raiz, ".preview/mock-supabase-efetividade.js") },
    ],
  },
};
