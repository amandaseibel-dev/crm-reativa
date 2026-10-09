import { defineConfig } from "vitest/config";
import { cpus } from "node:os";

// LIMITE DE WORKERS — por que existe e por que só vale fora do CI.
//
// Medido em 09/10/2026 num MacBook de 8 GB: `npm test` subia 5 workers, cada
// um com seu jsdom, somando 2,5 GB de uma vez. O swap ia a 4,9 GB e a carga a
// 41 em 6 núcleos — a máquina congelava por ~17 minutos, o tempo da suíte.
//
// O número 4 GB de swap não é chute: abaixo dele a carga média medida foi 2,4;
// na faixa 4-5 GB saltou para 19,15; acima de 5 GB para 35,56. É um degrau, e
// dois workers mantêm a máquina abaixo dele.
//
// No CI o limite NÃO se aplica: lá a suíte já leva de 12 a 15 minutos com
// timeout de 25 (ver .github/workflows/ci.yml), e cortar o paralelismo pela
// metade levaria o run a estourar o timeout — trocaria um problema local por
// uma catraca quebrada. O runner tem RAM de sobra e é descartável.
const emCI = Boolean(process.env.CI);
const maxWorkersLocal = Math.max(1, Math.min(2, cpus().length - 1));

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
    // Fora do CI, no máximo 2 workers (ver comentário no topo). No CI o vitest
    // decide sozinho, como sempre fez.
    ...(emCI ? {} : { maxWorkers: maxWorkersLocal, minWorkers: 1 }),
  },
});
