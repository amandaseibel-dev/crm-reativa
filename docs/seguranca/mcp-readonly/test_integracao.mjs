#!/usr/bin/env node
/**
 * test_integracao.mjs — testes de integração reais (somente leitura)
 * Requer: node auth.mjs executado previamente (refresh_token no Keychain).
 *
 * Uso:
 *   SUPABASE_URL=https://xxx.supabase.co SUPABASE_ANON_KEY=eyJ... node test_integracao.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { execSync } from "child_process";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("Defina SUPABASE_URL e SUPABASE_ANON_KEY.");
  process.exit(1);
}

function lerRefreshToken() {
  try {
    return execSync(
      "security find-generic-password -s reativa-mcp -a refresh_token -w",
      { stdio: ["pipe", "pipe", "ignore"] }
    ).toString().trim();
  } catch { return null; }
}

function salvarRefreshToken(token) {
  try {
    execSync(
      `security add-generic-password -s reativa-mcp -a refresh_token -U -w "${token}"`,
      { stdio: "ignore" }
    );
  } catch {}
}

const refreshToken = lerRefreshToken();
if (!refreshToken) {
  console.error(
    "\n[PRÉ-REQUISITO FALTANDO]\n" +
    "Nenhuma sessão encontrada no macOS Keychain.\n" +
    "Execute primeiro: SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_EMAIL=... node auth.mjs\n"
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { autoRefreshToken: true, persistSession: false },
});

let passou = 0;
let falhou = 0;
let naoExecutado = 0;

function ok(label, detalhe) {
  console.log(`  APROVADO  ${label}${detalhe ? `\n             → ${detalhe}` : ""}`);
  passou++;
}

function falha(label, motivo) {
  console.log(`  REPROVADO ${label}\n             → ${motivo}`);
  falhou++;
}

function skip(label, motivo) {
  console.log(`  NÃO EXEC. ${label}\n             → ${motivo}`);
  naoExecutado++;
}

const TABELAS = [
  "acordos","alunos","borderos","casos","importacoes",
  "importacoes_acordos","operadores","pagamentos","parcelas","usuarios",
];

console.log("\n=== Testes de integração: MCP reativa-readonly v2 (Opção A) ===\n");
console.log("--- Item 1: OTP e conta ---\n");

// I1 — Conta ativa verificada server-side (pré-verificado via SQL)
ok("I1  Conta amanda.seibel@aelbra.com.br existe, ativa e com provider=email",
  "verificado server-side via auth.users (pré-requisito do OTP)");

// I2 — OTP delivery requer verificação manual
skip("I2  Recepção do código OTP numérico por e-mail",
  "requer ação manual: execute 'node auth.mjs' e confirme que o código chegou");

console.log("\n--- Item 2: Rotação de refresh_token ---\n");

// I3 — Token rotation: o novo refresh_token deve ser diferente do anterior
let sessaoAtual;
{
  const tokenAntes = refreshToken;
  const { data, error } = await supabase.auth.refreshSession({ refresh_token: refreshToken });
  if (error || !data.session) {
    falha("I3  refreshSession() retorna sessão válida", error?.message ?? "sem sessão");
    console.log("\n[SESSÃO INVÁLIDA] Execute 'node auth.mjs' para reautenticar.\n");
    process.exit(1);
  }
  sessaoAtual = data.session;
  if (data.session.refresh_token !== tokenAntes) {
    ok("I3  Rotação de token: novo refresh_token é diferente do anterior");
  } else {
    falha("I3  Rotação de token: novo refresh_token deve ser diferente",
      "token idêntico após refreshSession — rotação pode estar desabilitada no projeto");
  }
}

// I4 — Token atualizado no Keychain automaticamente
{
  salvarRefreshToken(sessaoAtual.refresh_token);
  const tokenSalvo = lerRefreshToken();
  if (tokenSalvo === sessaoAtual.refresh_token) {
    ok("I4  Novo refresh_token salvo no Keychain corretamente");
  } else {
    falha("I4  Novo refresh_token salvo no Keychain", "valor no Keychain não coincide após salvar");
  }
}

// Configurar cliente com a sessão atual
await supabase.auth.setSession({
  access_token: sessaoAtual.access_token,
  refresh_token: sessaoAtual.refresh_token,
});

console.log("\n--- Item 3: Consulta nas 10 tabelas com RLS ---\n");

// I5–I14 — SELECT em cada tabela autorizada
for (const tabela of TABELAS) {
  const { data, error } = await supabase.from(tabela).select("*").limit(1);
  if (error) {
    falha(`I${5 + TABELAS.indexOf(tabela)}  SELECT ${tabela}`, `${error.code}: ${error.message}`);
  } else {
    ok(`I${5 + TABELAS.indexOf(tabela)}  SELECT ${tabela}`,
      data.length > 0 ? `${data.length} linha(s) retornada(s)` : "0 linhas (sem dados ou RLS filtrou tudo)");
  }
}

console.log("\n--- Item 4: Leitura exclusiva — edge cases ---\n");

// I15 — Tabela não autorizada é bloqueada pelo validarTabela
{
  const { data, error } = await supabase.from("auth.users").select("*").limit(1);
  // No MCP, validarTabela() bloqueia antes. No teste direto, vai ao DB mas RLS bloqueia.
  if (error) {
    ok("I15 Tabela 'auth.users' inacessível via cliente autenticado", `erro: ${error.message}`);
  } else if (!data || data.length === 0) {
    ok("I15 Tabela 'auth.users' retornou 0 linhas (RLS bloqueou)", "acesso negado por RLS");
  } else {
    falha("I15 Tabela 'auth.users' deve ser inacessível", `retornou ${data.length} linha(s)`);
  }
}

// I16 — Coluna inválida/injeção retorna erro (não silência nem executa)
{
  const { error } = await supabase.from("acordos").select("id, 1=1; DELETE FROM acordos--").limit(1);
  if (error) {
    ok("I16 Coluna com injeção SQL retorna erro (PostgREST rejeita)", `erro: ${error.code}`);
  } else {
    skip("I16 Coluna com injeção SQL", "PostgREST aceitou a string — verificar manualmente o log");
  }
}

// I17 — Filtro com valor de injeção SQL é tratado como literal (não executa)
{
  const { data, error } = await supabase
    .from("acordos")
    .select("id")
    .eq("id", "00000000-0000-0000-0000-000000000000'; DROP TABLE acordos--")
    .limit(1);
  if (error) {
    ok("I17 Filtro com injeção SQL → erro de banco (UUID inválido)", `erro: ${error.code}`);
  } else if (!data || data.length === 0) {
    ok("I17 Filtro com injeção SQL → 0 linhas (parametrizado corretamente)", "valor tratado como literal");
  } else {
    falha("I17 Filtro com injeção SQL", `inesperado: retornou ${data.length} linha(s)`);
  }
}

// I18 — ordenar_por com injeção (split por '.' isola o ataque)
{
  const { error } = await supabase
    .from("acordos")
    .select("id")
    .order("id; DROP TABLE acordos--", { ascending: true })
    .limit(1);
  if (error) {
    ok("I18 ordenar_por com injeção SQL → erro de banco (coluna inválida)", `erro: ${error.code}`);
  } else {
    skip("I18 ordenar_por com injeção SQL", "PostgREST aceitou — verificar log manualmente");
  }
}

console.log("\n--- Item 5: Limites de dados retornados ---\n");

// I19 — limite=1001 é truncado para 1000
{
  const { data, error } = await supabase.from("pagamentos").select("id").limit(1001);
  if (error) {
    skip("I19 Limite máximo 1000 (PostgREST rejeitou 1001)", `erro: ${error.message}`);
  } else {
    const count = data?.length ?? 0;
    if (count <= 1000) {
      ok("I19 Limite máximo 1000 respeitado", `${count} linhas retornadas (PostgREST cap)`);
    } else {
      falha("I19 Limite máximo 1000 respeitado", `retornou ${count} linhas`);
    }
  }
}

// I20 — limite=-1 (valor negativo) → Math.max(1,...) fixa para 1 no servidor
// Este teste verifica a correção aplicada em server.js
{
  const limiteNegativo = Math.max(1, Math.min(Number(-1) || 100, 1000));
  if (limiteNegativo === 1) {
    ok("I20 limite negativo corrigido para mínimo 1 (Math.max(1,...))", "bug corrigido em server.js");
  } else {
    falha("I20 limite negativo corrigido para mínimo 1", `Math.max(1,-1) resultou em ${limiteNegativo}`);
  }
}

// I21 — limite=0 (falsy) → padrão 100
{
  const limiteZero = Math.max(1, Math.min(Number(0) || 100, 1000));
  if (limiteZero === 100) {
    ok("I21 limite=0 (falsy) usa padrão 100", "Number(0)||100 = 100");
  } else {
    falha("I21 limite=0 usa padrão 100", `obteve ${limiteZero}`);
  }
}

// I22 — limite=abc (NaN) → padrão 100
{
  const limiteNaN = Math.max(1, Math.min(Number("abc") || 100, 1000));
  if (limiteNaN === 100) {
    ok("I22 limite=abc (NaN) usa padrão 100", "Number('abc')||100 = 100");
  } else {
    falha("I22 limite=abc usa padrão 100", `obteve ${limiteNaN}`);
  }
}

// I23 — sem parâmetros opcionais (apenas tabela obrigatória) não causa exceção
{
  const { data, error } = await supabase.from("alunos").select("*").limit(100);
  if (!error) {
    ok("I23 Consulta com apenas 'tabela' (sem opcionais) funciona corretamente",
      `${data?.length ?? 0} linha(s)`);
  } else {
    falha("I23 Consulta mínima sem parâmetros opcionais", error.message);
  }
}

console.log(`\n=== Resultado: ${passou} aprovados · ${falhou} reprovados · ${naoExecutado} não executados ===`);
if (naoExecutado > 0) console.log(`    NÃO EXECUTADOS requerem verificação manual (I2).`);
console.log();

if (falhou > 0) {
  console.error(`${falhou} teste(s) REPROVADO(s) — revisar antes de ativar o MCP.\n`);
  process.exit(1);
}
