import { defineConfig } from "vitest/config";

// Config dedicada aos testes. NAO altera vite.config.js (dev server/build).
// jsx: "automatic" alinha o transform de teste ao runtime da app (React 19,
// componentes sem `import React`). O ambiente padrao e node (mantem os testes
// utilitarios existentes); arquivos que precisam de DOM usam o pragma
// `// @vitest-environment jsdom` no topo.
export default defineConfig({
  esbuild: { jsx: "automatic", jsxImportSource: "react" },
  test: {
    environment: "node",
  },
});
