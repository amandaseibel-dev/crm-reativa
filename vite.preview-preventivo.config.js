// Config exclusiva do preview visual do Preventivo. Troca a camada de serviço
// por dados de exemplo, para ver as quatro abas sem login e sem banco. O
// COMPONENTE é o real — o que aparece na tela é o código do PR.
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default {
  appType: "mpa",
  server: { port: 5197, strictPort: true },
  plugins: [
    react(),
    {
      name: "preview-preventivo-fallback",
      configureServer(servidor) {
        servidor.middlewares.use((req, _res, proximo) => {
          if (req.url && !req.url.includes(".") && !req.url.startsWith("/@")) {
            req.url = "/preview-preventivo.html";
          }
          proximo();
        });
      },
    },
  ],
  resolve: {
    alias: [
      { find: /^.*\/services\/supabase$/, replacement: resolve("./.preview-preventivo/mock-supabase.js") },
      { find: /^\.{1,2}\/supabase$/,      replacement: resolve("./.preview-preventivo/mock-supabase.js") },
    ],
  },
};
