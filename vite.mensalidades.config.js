// Config exclusiva do preview visual do detalhamento das mensalidades na Minha
// Carteira. Os COMPONENTES sao os reais -- o que aparece na tela e o codigo do
// PR. Nao ha banco nem login.
export default {
  appType: "mpa",
  server: { port: 5206, strictPort: true },
  plugins: [
    {
      name: "preview-mensalidades-fallback",
      configureServer(servidor) {
        servidor.middlewares.use((req, _res, proximo) => {
          if (req.url && !req.url.includes(".") && !req.url.startsWith("/@")) req.url = "/preview-mensalidades.html";
          proximo();
        });
      },
    },
  ],
};
