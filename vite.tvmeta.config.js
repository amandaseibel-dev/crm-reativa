// Preview visual SÓ do slide "Meta do Mês" da TV. Não vai para o PR: existe
// para conferir o layout em tela cheia sem precisar do banco.
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";

const raiz = fileURLToPath(new URL(".", import.meta.url));

export default {
  root: raiz,
  appType: "mpa",
  server: { port: 5203, strictPort: true },
  plugins: [
    react(),
    {
      name: "preview-tvmeta-fallback",
      configureServer(servidor) {
        servidor.middlewares.use((req, _res, proximo) => {
          if (req.url && !req.url.includes(".") && !req.url.startsWith("/@")) {
            req.url = "/preview-tv-meta.html";
          }
          proximo();
        });
      },
    },
  ],
};
