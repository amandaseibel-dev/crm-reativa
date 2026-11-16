// Teste de navegador isolado: sem rede produtiva. O Supabase aponta para um host fictício (.invalid)
// que so existe dentro do teste, interceptado pelo Playwright. Qualquer outra origem externa e bloqueada.
import { defineConfig } from "@playwright/test";

const PORTA = 5180;

export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORTA}`,
    acceptDownloads: true,
  },
  webServer: {
    command: `npx vite --port ${PORTA} --strictPort --host localhost`,
    url: `http://localhost:${PORTA}`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      VITE_SUPABASE_URL: "https://supa-teste.invalid",
      VITE_SUPABASE_ANON_KEY: "chave-ficticia-de-teste",
    },
  },
});
