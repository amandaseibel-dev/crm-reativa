// Config exclusiva do preview do painel de registro das ações massivas.
// Troca a camada de serviço por dados de exemplo: a tela abre sem login e sem
// banco, e o COMPONENTE que aparece é o real (src/pages/AcoesMassivas.jsx).
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";

export default {
  appType: "mpa",
  server: { port: 5204, strictPort: true },
  plugins: [
    react(),
    {
      name: "preview-massivas-fallback",
      configureServer(servidor) {
        servidor.middlewares.use((req, _res, proximo) => {
          if (req.url && !req.url.includes(".") && !req.url.startsWith("/@")) {
            req.url = "/preview-massivas.html";
          }
          proximo();
        });
      },
    },
  ],
  resolve: {
    alias: [
      { find: /^.*\/services\/supabase$/, replacement: resolve("./.preview/mock-supabase-massivas.js") },
      { find: /^\.{1,2}\/supabase$/,      replacement: resolve("./.preview/mock-supabase-massivas.js") },
    ],
  },
};
