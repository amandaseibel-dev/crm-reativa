// Config exclusiva do preview da situação acadêmica. Separada da
// vite.preview.config.js de propósito: aquela tem fallback fixo para
// /preview-central.html e aliases da Central, e mexer nela para caber os dois
// quebraria o preview que já existe.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// RAIZ EXPLÍCITA, e é o detalhe que faz a diferença. `npx vite --config <caminho>`
// NÃO muda a raiz: ela continua sendo o diretório de onde o comando foi chamado.
// Sem esta linha o vite servia o outro checkout -- varria `index.html` e
// `App.jsx` inteiros, e a página morria com dezenas de "Failed to resolve import
// ../services/supabase", que parecem defeito do componente e não são.
const AQUI = dirname(fileURLToPath(import.meta.url));

export default {
  root: AQUI,
  appType: "mpa",
  server: { port: 5198, strictPort: true, open: false },
  // Só a entrada do preview é varrida. Sem isto o vite tenta pré-empacotar a
  // partir de `index.html`, que carrega o app inteiro e o login.
  optimizeDeps: { entries: ["preview-academico.html"] },
  resolve: {
    alias: [
      // O componente importa `../services/supabase`. Sem o alias, o módulo real
      // roda na carga e apaga a página reclamando de variável de ambiente --
      // aqui não existe banco nenhum para configurar.
      { find: /^.*\/services\/supabase$/, replacement: resolve(AQUI, ".preview/mock-supabase-academico.js") },
      { find: /^\.{1,2}\/supabase$/,      replacement: resolve(AQUI, ".preview/mock-supabase-academico.js") },
    ],
  },
};
