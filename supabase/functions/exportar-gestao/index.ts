// Edge Function: exportar-gestao
// -----------------------------------------------------------------------------
// Tira do banco uma tabela de gestão inteira e a entrega como arquivo, sem
// passar pela API de linhas (que corta em 1.000) e sem expor chave nenhuma.
//
// POR QUE EXISTE. A revisão "100% dos casos no Prime" (04/09/2026) produz
// ~17 mil linhas, uma por aluno. A gestão precisa disso em planilha. Nenhuma
// tela pagina isso de forma útil e a API de leitura corta em mil linhas.
//
// O QUE FAZ. Lê a tabela permitida em páginas de 1.000 (dentro da função),
// grava um JSON num bucket PRIVADO e devolve uma URL assinada de 10 minutos.
// Depois de baixar, chame `apagar` para remover o arquivo.
//
// QUEM PODE. O token de rotina (Vault) ou uma sessão de gestão. Mesmo portão
// das outras funções do Prime.
//
// AÇÕES (POST JSON, campo `acao`):
//   "exportar" -> { acao, tabela, nome }  devolve { url, linhas, bytes }
//   "apagar"   -> { acao, nome }          remove o arquivo do bucket
//
// Só tabelas da lista TABELAS saem por aqui. Nunca aceita SQL, nunca aceita
// bucket ou caminho vindos do cliente.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TABELAS = new Set(["revisao_prime_aluno"]);
const BUCKET = "fechamento-remuneracao"; // privado, leitura só da gestão
const PASTA = "exportacoes";
const TTL_SEGUNDOS = 600;
const PAGINA = 1000;

const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Portão: token de rotina OU sessão de gestão.
  const tokenRecebido = req.headers.get("x-rotina-token") ?? "";
  let ehRotina = false;
  if (tokenRecebido) {
    const { data } = await supa.rpc("prime_cadastro_token_valido", { p_token: tokenRecebido });
    ehRotina = data === true;
  }
  if (!ehRotina) {
    const autorizacao = req.headers.get("Authorization") ?? "";
    if (!autorizacao.startsWith("Bearer ")) return json({ erro: "SEM_TOKEN" }, 401);
    const supaChamador = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: autorizacao } } },
    );
    const { data: ehGestao } = await supaChamador.rpc("usuario_e_gestao");
    if (ehGestao !== true) return json({ erro: "ACESSO_NEGADO", detalhe: "restrito a gestao" }, 403);
  }

  let corpo: any = {};
  try { corpo = await req.json(); } catch { /* padrões */ }
  const acao = String(corpo?.acao ?? "exportar");
  const nome = String(corpo?.nome ?? "").replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 80);
  if (!nome) return json({ erro: "NOME_INVALIDO" }, 400);
  const caminho = `${PASTA}/${nome}`;

  if (acao === "apagar") {
    const { error } = await supa.storage.from(BUCKET).remove([caminho]);
    return json({ apagado: !error, detalhe: error?.message ?? null });
  }

  const tabela = String(corpo?.tabela ?? "");
  if (!TABELAS.has(tabela)) return json({ erro: "TABELA_NAO_PERMITIDA" }, 400);

  // Lê tudo, em páginas -- a API corta em 1.000 mesmo sem limite.
  const linhas: unknown[] = [];
  for (let de = 0; ; de += PAGINA) {
    const { data, error } = await supa.from(tabela).select("*").order("nome").range(de, de + PAGINA - 1);
    if (error) return json({ erro: "LEITURA_FALHOU", detalhe: error.message }, 500);
    if (!data?.length) break;
    linhas.push(...data);
    if (data.length < PAGINA) break;
  }

  const texto = JSON.stringify(linhas);
  const up = await supa.storage.from(BUCKET).upload(caminho, new Blob([texto], { type: "application/json" }), {
    upsert: true, contentType: "application/json",
  });
  if (up.error) return json({ erro: "UPLOAD_FALHOU", detalhe: up.error.message }, 500);

  const ass = await supa.storage.from(BUCKET).createSignedUrl(caminho, TTL_SEGUNDOS);
  if (ass.error) return json({ erro: "ASSINATURA_FALHOU", detalhe: ass.error.message }, 500);

  return json({ ok: true, tabela, linhas: linhas.length, bytes: texto.length, expira_em_s: TTL_SEGUNDOS, url: ass.data.signedUrl });
});
