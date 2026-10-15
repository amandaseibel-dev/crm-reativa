// Config exclusiva da revisao visual do bloco "Meu dia" (topo da tela inicial
// do operador). O componente e puro: nao precisa de mock de servico, so dos
// dados que a carteira passa por prop.
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";

const raiz = fileURLToPath(new URL(".", import.meta.url));

export default {
  root: raiz,
  appType: "mpa",
  server: { port: 5204, strictPort: true },
  plugins: [
    react(),
    {
      name: "preview-meu-dia-fallback",
      configureServer(servidor) {
        servidor.middlewares.use((req, _res, proximo) => {
          if (req.url && !req.url.includes(".") && !req.url.startsWith("/@")) {
            req.url = "/preview-meu-dia.html";
          }
          proximo();
        });
      },
    },
  ],
};
