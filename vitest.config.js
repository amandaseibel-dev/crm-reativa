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
    // O gateway do WhatsApp tem testes proprios, escritos para `node --test`
    // (rodam com `npm test` DENTRO de services/whatsapp-gateway). O vitest da
    // raiz nao sabe executa-los e os marcaria como falha — ruido que esconderia
    // falha de verdade.
    exclude: ["**/node_modules/**", "**/dist/**", "services/**"],
    // Variaveis do Supabase com valor INERTE e LOCAL. Nao e configuracao de
    // verdade: e o mesmo placeholder que src/services/supabase.js ja usa fora
    // do browser. Sem isto o teste depende do .env.local da maquina de quem
    // roda — passava aqui e quebrava no CI, que nao tem .env nenhum. Nenhuma
    // rede real e usada nos testes; todo teste de tela dubla o supabase.
    env: {
      VITE_SUPABASE_URL: "http://localhost:54321",
      VITE_SUPABASE_ANON_KEY: "anon-inert-nao-producao",
    },
  },
});
