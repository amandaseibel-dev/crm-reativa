import { createClient } from "@supabase/supabase-js";

// SEM fallback para produção. As variáveis são OBRIGATÓRIAS e vêm do ambiente
// (Vite as assa no build). No BROWSER, se faltarem, a aplicação NÃO inicia e
// mostra um erro de configuração — nunca conecta silenciosamente a nenhum banco.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if ((!supabaseUrl || !supabaseAnonKey) && typeof document !== "undefined") {
  const msg =
    "Configuração ausente: defina VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY no ambiente " +
    "(Preview/Production). A aplicação não inicia sem essas variáveis.";
  document.body.innerHTML =
    '<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;' +
    'background:#0f172a;color:#fff;font-family:system-ui,sans-serif;padding:24px;text-align:center">' +
    '<div style="max-width:520px"><div style="font-size:40px;margin-bottom:12px">⚙️</div>' +
    '<h1 style="font-size:18px;margin:0 0 8px">Erro de configuração do ambiente</h1>' +
    '<p style="font-size:14px;color:#cbd5e1;line-height:1.5">Faltam as variáveis ' +
    '<code>VITE_SUPABASE_URL</code> e/ou <code>VITE_SUPABASE_ANON_KEY</code>. ' +
    'Configure-as no ambiente correto (ex.: Vercel Preview → staging) e refaça o deploy. ' +
    'A aplicação não conecta a nenhum banco sem elas.</p></div></div>';
  throw new Error(msg);
}

// No browser, a checagem acima garante url/key definidos. Fora do browser
// (build/SSR/testes) sem as vars, usa um placeholder LOCAL inerte — NUNCA
// produção — só para não quebrar imports; nenhuma rede real é usada nos testes.
export const supabase = createClient(
  supabaseUrl || "http://localhost:54321",
  supabaseAnonKey || "anon-inert-nao-producao"
);
