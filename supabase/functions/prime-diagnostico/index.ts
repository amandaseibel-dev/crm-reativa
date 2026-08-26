// Diagnóstico da API da Ulbra: descobrir POR QUE a coleta parou de trazer.
//
// POR QUE EXISTE. Em 26/08/2026 a coleta passou cinco horas com 55 erros em
// cada lote de 60 e zero gravado. A função de coleta só contava "erros" -- não
// dizia se era a chave, limite deles, instabilidade ou defeito nosso. Foram
// cinco horas de chamada desperdiçada por falta de uma linha de diagnóstico.
//
// Esta função responde isso em dez segundos: faz UMA chamada de cada tipo e
// devolve status HTTP, tempo e o corpo cru -- é no corpo que a API explica.
//
// Naquele dia ela provou que a API estava perfeita (200 em 1 a 2,6s) e que o
// problema era nosso: um cast de `integer` num número fracionário.
//
// Só token de rotina. Não grava nada, não altera nada.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BASE = "https://prime-api.ulbra.ai/api";

Deno.serve(async (req) => {
  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const tokenRecebido = req.headers.get("x-rotina-token") ?? "";
  let ehRotina = false;
  if (tokenRecebido) {
    const { data } = await supa.rpc("prime_cadastro_token_valido", { p_token: tokenRecebido });
    ehRotina = data === true;
  }
  if (!ehRotina) {
    return new Response(JSON.stringify({ erro: "SEM_TOKEN" }), {
      status: 401, headers: { "Content-Type": "application/json" },
    });
  }

  let chave = Deno.env.get("PRIME_API_KEY") ?? "";
  if (!chave) {
    const { data } = await supa.rpc("prime_api_key_backend");
    chave = typeof data === "string" ? data : "";
  }

  let corpo: any = {};
  try { corpo = await req.json(); } catch { /* padrões */ }
  const cpf = String(corpo?.cpf ?? "").replace(/\D/g, "");
  const cpfFormatado = cpf.length === 11
    ? `${cpf.slice(0,3)}.${cpf.slice(3,6)}.${cpf.slice(6,9)}-${cpf.slice(9)}`
    : null;

  async function testar(rotulo: string, caminho: string) {
    const t0 = Date.now();
    try {
      const r = await fetch(BASE + caminho, { headers: { "X-API-Key": chave } });
      const texto = await r.text();
      return {
        rotulo,
        status: r.status,
        ms: Date.now() - t0,
        corpo: texto.slice(0, 300),
        retry_after: r.headers.get("retry-after"),
        ratelimit: r.headers.get("x-ratelimit-remaining"),
      };
    } catch (e) {
      return { rotulo, status: 0, ms: Date.now() - t0, corpo: `EXCECAO: ${e}` };
    }
  }

  const testes = [
    await testar("carriers (mais simples)", "/carriers?take=1"),
    await testar("students 195 pagina 1", "/students?carrierId=195&take=1"),
  ];
  if (cpfFormatado) {
    testes.push(await testar("busca por CPF", `/students?search=${encodeURIComponent(cpfFormatado)}&carrierId=195&take=10`));
  }

  return new Response(JSON.stringify({
    tem_chave: chave.length > 0,
    tamanho_da_chave: chave.length,
    testes,
  }, null, 2), { headers: { "Content-Type": "application/json" } });
});
