// Config exclusiva do preview visual do card de alerta de parcela. O COMPONENTE
// e o real -- o que aparece na tela e o codigo do PR. Nao ha banco nem login.
import { resolve } from "node:path";

export default {
  appType: "mpa",
  server: { port: 5205, strictPort: true },
  plugins: [
    {
      name: "preview-alertas-fallback",
      configureServer(servidor) {
        servidor.middlewares.use((req, _res, proximo) => {
          if (req.url && !req.url.includes(".") && !req.url.startsWith("/@")) req.url = "/preview-alertas.html";
          proximo();
        });
      },
    },
  ],
  resolve: {
    alias: [{ find: /^.*\/services\/supabase$/, replacement: resolve("./.preview/mock-supabase.js") }],
  },
};
