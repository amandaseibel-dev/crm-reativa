import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));

// O componente importa "../services/supabase" -- caminho RELATIVO. Alias por
// nome nao intercepta caminho relativo: o Vite resolve antes. Por isso a troca
// e feita num plugin com enforce "pre", olhando o arquivo ja resolvido.
const alvo = path.resolve(AQUI, "src/services/supabase.js");
const duble = path.resolve(AQUI, ".previewef/mock-supabase.js");
const trocarSupabase = {
  name: "duble-supabase",
  enforce: "pre",
  async resolveId(origem, quem) {
    if (!quem || quem.includes(".previewef")) return null;
    const r = await this.resolve(origem, quem, { skipSelf: true });
    if (r && path.resolve(r.id.split("?")[0]) === alvo) return duble;
    return null;
  },
};

export default defineConfig({
  plugins: [trocarSupabase, react()],
  server: { port: 5196, open: false },
});
