/**
 * test_estrutural.mjs — validação estrutural do servidor MCP reativa-readonly (Opção A)
 * Verifica propriedades de segurança sem conexão real ao banco.
 */
import { readFileSync } from "fs";
import { TABELAS_AUTORIZADAS, validarTabela } from "./tabelas.mjs";

let passou = 0;
let falhou = 0;

function ok(label) {
  console.log(`  APROVADO  ${label}`);
  passou++;
}

function falha(label, motivo) {
  console.log(`  REPROVADO ${label}`);
  console.log(`             → ${motivo}`);
  falhou++;
}

const servidorSrc = readFileSync(new URL("./server.js", import.meta.url), "utf-8");
const authSrc     = readFileSync(new URL("./auth.mjs",  import.meta.url), "utf-8");

console.log("\n=== Testes estruturais: MCP reativa-readonly v2 (Opção A — Supabase Auth) ===\n");

// T1 — Apenas select_tabela como ferramenta registrada
{
  const temSelect    = servidorSrc.includes('"select_tabela"');
  const temQueryOld  = servidorSrc.includes('"query_readonly"');
  if (temSelect && !temQueryOld)
    ok("T1  Ferramenta registrada é exclusivamente 'select_tabela'");
  else
    falha("T1  Ferramenta registrada é exclusivamente 'select_tabela'",
      temQueryOld ? "ainda contém 'query_readonly'" : "'select_tabela' não encontrada");
}

// T2 — 10 tabelas autorizadas exatas
{
  const esperadas = [
    "acordos","alunos","borderos","casos","importacoes",
    "importacoes_acordos","operadores","pagamentos","parcelas","usuarios",
  ];
  const sobrando = [...TABELAS_AUTORIZADAS].filter(t => !esperadas.includes(t));
  const faltando  = esperadas.filter(t => !TABELAS_AUTORIZADAS.has(t));
  if (sobrando.length === 0 && faltando.length === 0 && TABELAS_AUTORIZADAS.size === 10)
    ok("T2  Conjunto de tabelas autorizadas: 10 exatas, sem extras nem faltas");
  else
    falha("T2  Conjunto de tabelas autorizadas",
      `sobrando: [${sobrando}], faltando: [${faltando}], total: ${TABELAS_AUTORIZADAS.size}`);
}

// T3 — Tabelas não autorizadas são rejeitadas; autorizadas passam
{
  const casos = [
    { input: "auth.users",                     esperaErro: true  },
    { input: "usuarios; DROP TABLE acordos",   esperaErro: true  },
    { input: "pagamentos--",                   esperaErro: true  },
    { input: "",                               esperaErro: true  },
    { input: "acordos",                        esperaErro: false },
    { input: "pagamentos",                     esperaErro: false },
  ];
  let ok3 = true;
  for (const c of casos) {
    let lancou = false;
    try { validarTabela(c.input); } catch { lancou = true; }
    if (lancou !== c.esperaErro) {
      falha("T3  Validação de tabelas",
        `'${c.input}': esperava erro=${c.esperaErro}, obteve=${lancou}`);
      ok3 = false;
      break;
    }
  }
  if (ok3)
    ok("T3  Validação de tabelas: injeção SQL, auth.users, string vazia → BLOQUEADO; tabelas válidas → PERMITIDO");
}

// T4 — Sem .rpc( no server.js (nenhuma chamada a funções SECDEF)
{
  if (!servidorSrc.includes(".rpc("))
    ok("T4  server.js não contém .rpc() — funções SECURITY DEFINER write inalcançáveis");
  else
    falha("T4  server.js não contém .rpc()", "encontrou .rpc( no código");
}

// T5 — Sem mutações (insert/update/delete/upsert) no server.js
{
  const proibidos = [".insert(", ".update(", ".delete(", ".upsert("];
  const encontrados = proibidos.filter(p => servidorSrc.includes(p));
  if (encontrados.length === 0)
    ok("T5  server.js não contém .insert/.update/.delete/.upsert — API Supabase em modo leitura");
  else
    falha("T5  server.js não contém mutações", `encontrou: ${encontrados.join(", ")}`);
}

// T6 — Sem módulo pg (conexão direta PostgreSQL)
{
  const temPg = servidorSrc.includes("from 'pg'") || servidorSrc.includes('from "pg"') ||
    servidorSrc.includes("import pg");
  if (!temPg)
    ok("T6  server.js não usa módulo 'pg' — sem conexão direta ao PostgreSQL");
  else
    falha("T6  server.js não usa módulo 'pg'", "encontrou import do módulo pg");
}

// T7 — Sem service_role no server.js
{
  if (!servidorSrc.includes("service_role"))
    ok("T7  server.js não usa service_role — credencial administrativa ausente");
  else
    falha("T7  server.js não usa service_role", "encontrou 'service_role' no código");
}

// T8 — Sem string de conexão postgres:// embutida
{
  const temPostgresUrl = servidorSrc.includes("postgres://") ||
    servidorSrc.includes("postgresql://");
  if (!temPostgresUrl)
    ok("T8  server.js não contém string de conexão postgres:// — sem credencial embutida");
  else
    falha("T8  server.js não contém string de conexão postgres://", "encontrou URL direta");
}

// T9 — auth.mjs não persiste credenciais em arquivo plain text
{
  const semArquivo = !authSrc.includes("writeFileSync") &&
    !authSrc.includes("appendFileSync") &&
    !authSrc.includes("createWriteStream");
  if (semArquivo)
    ok("T9  auth.mjs não persiste credenciais em arquivo plain text");
  else
    falha("T9  auth.mjs não persiste credenciais em arquivo plain text",
      "encontrou operação de escrita em arquivo");
}

// T10 — auth.mjs usa macOS Keychain via 'security add-generic-password'
{
  const usaKeychain = authSrc.includes("security add-generic-password") &&
    authSrc.includes("reativa-mcp") && authSrc.includes("refresh_token");
  if (usaKeychain)
    ok("T10 auth.mjs armazena refresh_token via macOS Keychain (security add-generic-password)");
  else
    falha("T10 auth.mjs usa macOS Keychain", "padrão esperado não encontrado em auth.mjs");
}

// T11 — server.js usa SUPABASE_URL + SUPABASE_ANON_KEY (sem credencial admin)
{
  const usaVarsCorretas = servidorSrc.includes("SUPABASE_URL") &&
    servidorSrc.includes("SUPABASE_ANON_KEY");
  const naoUsaAdmin = !servidorSrc.includes("SUPABASE_SERVICE_KEY") &&
    !servidorSrc.includes("SERVICE_ROLE_KEY") &&
    !servidorSrc.includes("POSTGRES_PASSWORD");
  if (usaVarsCorretas && naoUsaAdmin)
    ok("T11 Variáveis de ambiente: SUPABASE_URL + SUPABASE_ANON_KEY apenas — sem credencial administrativa");
  else
    falha("T11 Variáveis de ambiente", "encontrou variável de credencial administrativa");
}

// T12 — server.js renova sessão via Keychain (não armazena token em memória entre reinícios)
{
  const renovaCorreto = servidorSrc.includes("refreshSession") &&
    servidorSrc.includes("refresh_token") &&
    servidorSrc.includes("security find-generic-password");
  if (renovaCorreto)
    ok("T12 Renovação de sessão: lê refresh_token do Keychain + chama refreshSession()");
  else
    falha("T12 Renovação de sessão via Keychain", "padrão esperado não encontrado em server.js");
}

// T13 — OTP flow: sem armazenamento de senha no auth.mjs
{
  const temSignInOtp   = authSrc.includes("signInWithOtp");
  const temVerifyOtp   = authSrc.includes("verifyOtp");
  const naoTemPassword = !authSrc.includes("signInWithPassword");
  if (temSignInOtp && temVerifyOtp && naoTemPassword)
    ok("T13 auth.mjs usa fluxo OTP por e-mail — sem senha armazenada");
  else
    falha("T13 auth.mjs usa fluxo OTP",
      `signInWithOtp=${temSignInOtp}, verifyOtp=${temVerifyOtp}, temPassword=${!naoTemPassword}`);
}

console.log(`\n=== Resultado: ${passou}/${passou + falhou} aprovados ===\n`);
if (falhou > 0) {
  console.error(`${falhou} teste(s) REPROVADO(s). Revisar antes de usar.\n`);
  process.exit(1);
}
