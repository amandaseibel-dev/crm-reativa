// =============================================================================
// Testes de ATOMICIDADE da gravação de conexão (migration 20261117120000) contra Postgres real.
//
// Cobre: gravação sem linha; OAuth ativo com e sem refresh preservado; credencial revogada com
// refresh preservada; revogada sem credencial gravável; erro sem gravação; conclusão OAuth e
// cadastro de token CONCORRENTES (duas conexões, trava confirmada por pg_stat_activity); duas
// tentativas concorrentes de cadastro.
//
// Pré-requisito: a tabela vem da migration 20261111140000 (aplicada no banco de teste, como no
// runner ulbra_conexao_envio). Pendente de aprovação: não há efeito em produção.
//
// Uso (CI e local): NODE_PATH=<dir com pg> ULBRA_TESTE_DESCARTAVEL=sim PGHOST=localhost ... \
//   node supabase/tests/ulbra_conexao_token/run.cjs
// Sai com código 1 se qualquer verificação falhar.
// =============================================================================
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const ROOT = path.resolve(__dirname, "../../..");
const MIG_TABELA = path.join(ROOT, "supabase/aguardando_aprovacao/20261111140000_ulbra_conexao_individual_e_envio.sql.pendente");
const MIG_ATOMICA = path.join(ROOT, "supabase/aguardando_aprovacao/20261117120000_ulbra_gravar_conexao_atomica.sql.pendente");
const AUDITORIA_FIXTURE = path.join(ROOT, "supabase/tests/fixtures/auditoria_definicao_producao.json");

const cfg = {
  host: process.env.PGHOST || "localhost",
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "postgres",
  password: process.env.PGPASSWORD || "postgres",
};
const BANCO = "teste_token";
const FN = "select public.ulbra_gravar_conexao($1,$2,$3,$4::timestamptz,$5,$6,$7::jsonb,$8) as r";
const OP = "amanda.seibel@aelbra.com.br";
const EXP = "2026-12-17T12:00:00Z";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HOSTS_LOCAIS = ["localhost", "127.0.0.1", "::1"];
if (!HOSTS_LOCAIS.includes(cfg.host)) {
  console.error(`RECUSADO: PGHOST=${cfg.host} não é local.`);
  process.exit(2);
}
if (process.env.ULBRA_TESTE_DESCARTAVEL !== "sim") {
  console.error("RECUSADO: defina ULBRA_TESTE_DESCARTAVEL=sim (servidor de teste descartável).");
  process.exit(2);
}

async function conectar(database) {
  const c = new Client({ ...cfg, database });
  await c.connect();
  await c.query("set lock_timeout = '5s'");
  return c;
}

// Confirma que B está BLOQUEADA por trava enquanto A segura a linha (não é sleep fixo).
async function aguardarBloqueio(cliB, limiteMs = 10000) {
  const admin = await conectar("postgres");
  try {
    const inicio = Date.now();
    while (Date.now() - inicio < limiteMs) {
      const r = await admin.query("select wait_event_type from pg_stat_activity where pid = $1", [cliB.processID]);
      if (r.rows[0] && r.rows[0].wait_event_type === "Lock") return;
      await sleep(20);
    }
    throw new Error("B não ficou bloqueada por trava: a contenção não aconteceu");
  } finally {
    await admin.end();
  }
}

async function criarBancoDescartavel() {
  const admin = await conectar("postgres");
  const supa = await admin.query("select nspname from pg_namespace where nspname in ('auth','storage','supabase_functions')");
  if (supa.rowCount > 0) {
    await admin.end();
    throw new Error("RECUSADO: servidor tem schemas de Supabase; não é descartável");
  }
  await admin.query(`drop database if exists ${BANCO} with (force)`);
  await admin.query(`create database ${BANCO}`);
  await admin.query(`do $$ begin
    if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
    if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
  end $$`);
  await admin.end();
}

async function prepararBanco(cli) {
  // auditoria: dependência da migration de conexão (mesma fixture de produção do runner existente).
  await cli.query('create extension if not exists "uuid-ossp"');
  const def = JSON.parse(fs.readFileSync(AUDITORIA_FIXTURE, "utf8"));
  const colunas = def.colunas.map((k) => `${k.nome} ${k.tipo}${k.anulavel ? "" : " not null"}${k.padrao ? " default " + k.padrao : ""}`);
  colunas[0] += " primary key";
  await cli.query(`create table public.auditoria (${colunas.join(", ")})`);
  await cli.query("grant select, insert on public.auditoria to service_role");
  await cli.query(fs.readFileSync(MIG_TABELA, "utf8"));
  await cli.query(fs.readFileSync(MIG_ATOMICA, "utf8"));
}

const resultados = [];
let falhas = 0;
async function teste(nome, fn) {
  try {
    await fn();
    resultados.push({ nome, ok: true });
    console.log(`  ok   ${nome}`);
  } catch (e) {
    falhas++;
    resultados.push({ nome, ok: false, erro: e.message });
    console.log(`  FALHA ${nome}: ${e.message}`);
  }
}
function esperar(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function linha(cli) {
  const r = await cli.query("select access_token_cifrado as a, refresh_token_cifrado as r, revogada_em from public.ulbra_conexoes_operador where operador_email = $1", [OP]);
  return r.rows[0] || null;
}
async function limpar(cli) {
  await cli.query("delete from public.ulbra_conexoes_operador where operador_email = $1", [OP]);
}
const args = (access, refresh) => [OP, access, refresh, EXP, "Amanda", OP, null, false];

async function main() {
  await criarBancoDescartavel();
  const admin = await conectar(BANCO);
  await prepararBanco(admin);

  console.log("ulbra_gravar_conexao — atomicidade (Postgres real)");

  await teste("sem linha prévia: grava (GRAVADA)", async () => {
    await limpar(admin);
    const r = await admin.query(FN, args("tok_a", null));
    esperar(r.rows[0].r === "GRAVADA", "esperado GRAVADA, veio " + r.rows[0].r);
  });

  await teste("OAuth ativo COM refresh: EXISTENTE e linha preservada", async () => {
    await limpar(admin);
    await admin.query(FN, args("oauth_a", "oauth_r"));
    const r = await admin.query(FN, args("tok_novo", null));
    esperar(r.rows[0].r === "EXISTENTE", "esperado EXISTENTE");
    const l = await linha(admin);
    esperar(l.a === "oauth_a" && l.r === "oauth_r", "linha OAuth foi alterada");
  });

  await teste("OAuth ativo SEM refresh: EXISTENTE e linha preservada", async () => {
    await limpar(admin);
    await admin.query(FN, args("oauth_a", null));
    const r = await admin.query(FN, args("tok_novo", null));
    esperar(r.rows[0].r === "EXISTENTE", "esperado EXISTENTE");
    esperar((await linha(admin)).a === "oauth_a", "linha sem refresh foi alterada");
  });

  await teste("revogada com refresh guardado (A4): EXISTENTE e preservada", async () => {
    await limpar(admin);
    await admin.query(FN, args("a", "r_valido"));
    await admin.query("update public.ulbra_conexoes_operador set revogada_em = now() where operador_email = $1", [OP]);
    const r = await admin.query(FN, args("tok_novo", null));
    esperar(r.rows[0].r === "EXISTENTE", "esperado EXISTENTE");
    esperar((await linha(admin)).r === "r_valido", "refresh guardado foi apagado");
  });

  await teste("revogada SEM credencial (desconexão confirmada): GRAVADA", async () => {
    await limpar(admin);
    await admin.query(FN, args("a", null));
    await admin.query("update public.ulbra_conexoes_operador set access_token_cifrado = null, revogada_em = now() where operador_email = $1", [OP]);
    const r = await admin.query(FN, args("tok_novo", null));
    esperar(r.rows[0].r === "GRAVADA", "esperado GRAVADA, veio " + r.rows[0].r);
  });

  await teste("operador com maiúscula: erro e nada gravado", async () => {
    await limpar(admin);
    let erro = null;
    try { await admin.query(FN, ["Amanda@X.com", "a", null, EXP, null, null, null, false]); } catch (e) { erro = e; }
    esperar(erro && erro.code === "22023", "esperado erro 22023");
    const n = await admin.query("select count(*)::int as n from public.ulbra_conexoes_operador");
    esperar(n.rows[0].n === 0, "linha foi gravada apesar do erro");
  });

  await teste("CONCORRÊNCIA: conclusão OAuth segura a linha; cadastro de token espera e é recusado", async () => {
    await limpar(admin);
    const A = await conectar(BANCO);
    const B = await conectar(BANCO);
    try {
      await A.query("begin");
      const ra = await A.query(FN, args("oauth_a", "oauth_r")); // A segura a trava até o COMMIT
      esperar(ra.rows[0].r === "GRAVADA", "A devia gravar");
      const pB = B.query(FN, args("tok_b", null)); // B tenta gravar a mesma linha
      await aguardarBloqueio(B);
      await A.query("commit");
      const rb = await pB;
      esperar(rb.rows[0].r === "EXISTENTE", "B devia ser recusada, veio " + rb.rows[0].r);
      esperar((await linha(admin)).a === "oauth_a", "a conexão OAuth foi substituída");
    } finally {
      await A.end().catch(() => {});
      await B.end().catch(() => {});
    }
  });

  await teste("CONCORRÊNCIA: duas tentativas de cadastro de token ao mesmo tempo: exatamente uma grava", async () => {
    await limpar(admin);
    const A = await conectar(BANCO);
    const B = await conectar(BANCO);
    try {
      await A.query("begin");
      const ra = await A.query(FN, args("tok_a", null));
      esperar(ra.rows[0].r === "GRAVADA", "A devia gravar");
      const pB = B.query(FN, args("tok_b", null));
      await aguardarBloqueio(B);
      await A.query("commit");
      const rb = await pB;
      esperar(rb.rows[0].r === "EXISTENTE", "B devia ser recusada, veio " + rb.rows[0].r);
      esperar((await linha(admin)).a === "tok_a", "a segunda tentativa substituiu a primeira");
    } finally {
      await A.end().catch(() => {});
      await B.end().catch(() => {});
    }
  });

  await teste("erro de leitura do banco (função ausente): nada gravado", async () => {
    await limpar(admin);
    const c = await conectar(BANCO);
    let erro = null;
    try { await c.query("select public.funcao_que_nao_existe($1)", [OP]); } catch (e) { erro = e; }
    await c.end();
    esperar(erro !== null, "esperado erro");
    esperar((await linha(admin)) === null, "algo foi gravado mesmo com erro");
  });

  // RENOVAÇÃO CONDICIONAL (compare-and-set): a mesma condição que o handler usa em provedorOAuth.renovar.
  const RENOVA = "update public.ulbra_conexoes_operador set access_token_cifrado = $2, refresh_token_cifrado = $3, atualizado_em = now() where operador_email = $1 and refresh_token_cifrado = $4 and revogada_em is null returning operador_email";

  await teste("renovação com o refresh vigente: grava (1 linha)", async () => {
    await limpar(admin);
    await admin.query(FN, args("a0", "r1"));
    const r = await admin.query(RENOVA, [OP, "a1", "r2", "r1"]);
    esperar(r.rowCount === 1, "esperado 1 linha, veio " + r.rowCount);
    esperar((await linha(admin)).r === "r2", "refresh não foi rotacionado");
  });

  await teste("renovação antiga após NOVA conexão: não sobrescreve (0 linhas)", async () => {
    await limpar(admin);
    await admin.query(FN, args("a0", "r1"));
    await admin.query("update public.ulbra_conexoes_operador set refresh_token_cifrado = 'r_nova' where operador_email = $1", [OP]);
    const r = await admin.query(RENOVA, [OP, "a_velha", "r_velho", "r1"]);
    esperar(r.rowCount === 0, "renovação antiga sobrescreveu a conexão nova");
    esperar((await linha(admin)).r === "r_nova", "conexão nova foi alterada");
  });

  await teste("renovação após DESCONEXÃO (revogada): não reativa (0 linhas)", async () => {
    await limpar(admin);
    await admin.query(FN, args("a0", "r1"));
    await admin.query("update public.ulbra_conexoes_operador set revogada_em = now() where operador_email = $1", [OP]);
    const r = await admin.query(RENOVA, [OP, "a_velha", "r_velho", "r1"]);
    esperar(r.rowCount === 0, "renovação reativou conexão desconectada");
    esperar((await linha(admin)).revogada_em !== null, "linha voltou a ativa");
  });

  // ---------------------------------------------------------------- grants, search_path e rollback da função (20261117120000)
  const ASSINATURA = "public.ulbra_gravar_conexao(text,text,text,timestamptz,text,text,jsonb,boolean)";

  await teste("função: anon e authenticated SEM execute; service_role COM execute; PUBLIC sem execute", async () => {
    const r = await admin.query(
      `select has_function_privilege('anon', $1, 'execute') as anon_exec,
              has_function_privilege('authenticated', $1, 'execute') as auth_exec,
              has_function_privilege('service_role', $1, 'execute') as servico_exec,
              exists (select 1 from pg_proc p, aclexplode(p.proacl) a where p.oid = to_regprocedure($1) and a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_exec`,
      [ASSINATURA],
    );
    const x = r.rows[0];
    esperar(x.anon_exec === false, "anon tem execute");
    esperar(x.auth_exec === false, "authenticated tem execute");
    esperar(x.servico_exec === true, "service_role sem execute");
    esperar(x.public_exec === false, "PUBLIC tem execute");
  });

  await teste("função: SECURITY INVOKER e search_path fixo (public)", async () => {
    const r = await admin.query(
      `select p.prosecdef as definer, p.proconfig as config from pg_proc p where p.oid = to_regprocedure($1)`,
      [ASSINATURA],
    );
    esperar(r.rowCount === 1, "função não encontrada");
    esperar(r.rows[0].definer === false, "função é SECURITY DEFINER (deveria ser INVOKER)");
    esperar((r.rows[0].config || []).some((c) => c.replace(/\s/g, "") === "search_path=public"), "search_path não fixado em public");
  });

  await teste("ROLLBACK da 20261117120000 remove SÓ a função e preserva a tabela (transação descartada)", async () => {
    const rollback = fs.readFileSync(path.join(ROOT, "supabase/aguardando_aprovacao/20261117120000_ulbra_gravar_conexao_atomica.rollback.sql"), "utf8");
    await admin.query("begin");
    try {
      await admin.query(rollback);
      esperar((await admin.query("select to_regprocedure($1) as f", [ASSINATURA])).rows[0].f === null, "função ainda existe após o rollback");
      esperar((await admin.query("select to_regclass('public.ulbra_conexoes_operador') as t")).rows[0].t !== null, "rollback apagou a tabela, que é da 20261111140000");
    } finally {
      await admin.query("rollback");
    }
    esperar((await admin.query("select to_regprocedure($1) as f", [ASSINATURA])).rows[0].f !== null, "a transação descartada não restaurou a função");
  });

  await admin.end();
  const total = resultados.length;
  console.log(`\n${total - falhas}/${total} verificações passaram.`);
  process.exit(falhas === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("ERRO FATAL:", e.message);
  process.exit(1);
});
