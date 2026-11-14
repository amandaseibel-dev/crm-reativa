// =============================================================================
// Testes de PERMISSÃO da migration 20261114120000 (auditoria) em Postgres descartável.
// Prova, nesta ordem: (1) o estado observado em produção reproduz o problema; (2) a migration fecha o
// INSERT direto de authenticated e anon; (3) o trigger de recusa continua registrando a auditoria
// mesmo quando quem altera é authenticated; (4) service_role mantém o INSERT.
// Uso: ULBRA_TESTE_DESCARTAVEL=sim PGHOST=localhost PGPORT=... NODE_PATH=... node run.cjs
// Sai com 1 se qualquer verificação falhar.
// =============================================================================
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const ROOT = path.resolve(__dirname, "../../..");
const MIG = path.join(ROOT, "supabase/aguardando_aprovacao/20261114120000_auditoria_insert_so_pela_funcao_definer.sql.pendente");
const FIXTURE = path.join(ROOT, "supabase/tests/fixtures/auditoria_definicao_producao.json");
const BANCO = "teste_auditoria";
const cfg = { host: process.env.PGHOST || "localhost", port: Number(process.env.PGPORT || 5432), user: process.env.PGUSER || "postgres", password: process.env.PGPASSWORD || "postgres" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const resultados = [];
let falhas = 0;
async function teste(nome, fn) {
  try { await fn(); resultados.push(`OK    ${nome}`); } catch (e) { falhas++; resultados.push(`FAIL  ${nome} -> ${e.message}`); }
}
function igual(obtido, esperado, msg) {
  if (JSON.stringify(obtido) !== JSON.stringify(esperado)) throw new Error(`${msg}: esperado ${JSON.stringify(esperado)}, obtido ${JSON.stringify(obtido)}`);
}
async function conectar(database) {
  const c = new Client({ ...cfg, database });
  await c.connect();
  return c;
}

// Trigger EXATAMENTE como em produção (prosrc lido em 14/11/2026), INVOKER.
const TRIGGER_PRODUCAO = `
create or replace function public._titulo_em_confirmacao_protegido() returns trigger language plpgsql as $f$
declare
  v_oficial boolean := coalesce(current_setting('conferencia_prime.decisao', true), '') = 'on';
  v_novo    text := upper(coalesce(new.situacao,''));
  v_velho   text := case when tg_op = 'UPDATE' then upper(coalesce(old.situacao,'')) else '' end;
begin
  if v_oficial then
    return new;
  end if;
  if v_novo = 'EM_CONFIRMACAO' and v_velho <> 'EM_CONFIRMACAO' then
    raise exception 'EM_CONFIRMACAO_SO_PELA_CONFERENCIA_PRIME: o titulo % so entra em confirmacao pela deteccao do grupo A.',
      coalesce(new.documento, '?') using errcode = 'P0001';
  end if;
  if v_velho = 'EM_CONFIRMACAO'
     and (v_novo <> 'EM_CONFIRMACAO'
          or lower(coalesce(new.status,'')) <> lower(coalesce(old.status,''))
          or new.aluno_id is distinct from old.aluno_id
          or new.acordo_id is distinct from old.acordo_id) then
    insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
    values ('sistema', 'TITULO_EM_CONFIRMACAO_ALTERACAO_RECUSADA', 'acordos_titulos', old.id,
            jsonb_build_object('documento', old.documento,
                               'tentou_situacao', new.situacao, 'tentou_status', new.status,
                               'tentou_aluno_id', new.aluno_id, 'tentou_acordo_id', new.acordo_id));
    new.situacao  := old.situacao;
    new.status    := old.status;
    new.aluno_id  := old.aluno_id;
    new.acordo_id := old.acordo_id;
  end if;
  return new;
end;
$f$;
create trigger trg_titulo_em_confirmacao_protegido before update on public.acordos_titulos
  for each row execute function public._titulo_em_confirmacao_protegido();
`;

async function main() {
  if (process.env.ULBRA_TESTE_DESCARTAVEL !== "sim") throw new Error("RECUSADO: defina ULBRA_TESTE_DESCARTAVEL=sim (servidor de teste descartável)");
  if (!["localhost", "127.0.0.1", "::1"].includes(cfg.host)) throw new Error("RECUSADO: host não local");
  const admin = await conectar("postgres");
  const supa = await admin.query("select nspname from pg_namespace where nspname in ('auth','storage','supabase_functions')");
  if (supa.rowCount > 0) { await admin.end(); throw new Error("RECUSADO: schemas de Supabase no servidor"); }
  await admin.query(`do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  end $$`);
  await admin.query(`drop database if exists ${BANCO} with (force)`);
  await admin.query(`create database ${BANCO}`);
  await admin.end();

  const c = await conectar(BANCO);
  try {
    // Estado observado em produção: authenticated com INSERT em auditoria; service_role com INSERT.
    const def = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
    const colunas = def.colunas.map((k) => `${k.nome} ${k.tipo}${k.anulavel ? "" : " not null"}${k.padrao ? " default " + k.padrao : ""}`);
    colunas[0] += " primary key";
    await c.query('create extension if not exists "uuid-ossp"');
    await c.query(`create table public.auditoria (${colunas.join(", ")})`);
    await c.query("alter table public.auditoria enable row level security");
    // Produção: painel_negado = ALL para authenticated com (NOT eh_painel()). Para um usuário FORA do painel, a expressão é verdadeira:
    // reproduzimos esse caso (eh_painel() = false). A política não bloqueia o INSERT; só o grant bloqueia.
    await c.query("create policy painel_negado on public.auditoria for all to authenticated using (true) with check (true)");
    await c.query("grant select, insert on public.auditoria to authenticated, anon, service_role");
    await c.query(`create table public.acordos_titulos (id uuid primary key default gen_random_uuid(), documento text, situacao text, status text, aluno_id uuid, acordo_id uuid)`);
    await c.query("grant select, update on public.acordos_titulos to authenticated");
    await c.query(TRIGGER_PRODUCAO);
    const titulo = "11111111-1111-1111-1111-111111111111";
    await c.query("insert into public.acordos_titulos (id, documento, situacao, status) values ($1, 'DOC-1', 'EM_CONFIRMACAO', 'ATIVO')", [titulo]);

    await teste("ANTES (estado de produção): authenticated consegue INSERT direto em auditoria (o problema existe)", async () => {
      await c.query("set role authenticated");
      try { await c.query("insert into public.auditoria (usuario, acao) values ('forjado', 'FORJADO')"); }
      finally { await c.query("reset role"); }
      igual((await c.query("select count(*)::int as n from public.auditoria where acao = 'FORJADO'")).rows[0].n, 1, "linha forjada gravada");
      await c.query("delete from public.auditoria where acao = 'FORJADO'");
    });
    await teste("ANTES (estado de produção): a recusa do trigger já funciona para authenticated, pelo grant atual (é o que a correção precisa preservar)", async () => {
      const antes = (await c.query("select count(*)::int as n from public.auditoria where acao = 'TITULO_EM_CONFIRMACAO_ALTERACAO_RECUSADA'")).rows[0].n;
      await c.query("set role authenticated");
      try { await c.query("update public.acordos_titulos set situacao = 'ABERTO' where id = $1", [titulo]); }
      finally { await c.query("reset role"); }
      igual((await c.query("select count(*)::int as n from public.auditoria where acao = 'TITULO_EM_CONFIRMACAO_ALTERACAO_RECUSADA'")).rows[0].n - antes, 1, "auditorias de recusa geradas");
    });

    // Aplica a migration (no banco descartável, para provar o efeito).
    await c.query(fs.readFileSync(MIG, "utf8").replace(/^-- .*$/gm, "").replace(/\n+/g, "\n"));

    await teste("DEPOIS: authenticated e anon NÃO têm INSERT em auditoria (privilégio)", async () => {
      igual((await c.query("select has_table_privilege('authenticated','public.auditoria','INSERT') as ok")).rows[0].ok, false, "authenticated");
      igual((await c.query("select has_table_privilege('anon','public.auditoria','INSERT') as ok")).rows[0].ok, false, "anon");
    });
    await teste("DEPOIS: INSERT direto como authenticated é negado (42501)", async () => {
      await c.query("set role authenticated");
      let erro = null;
      try { await c.query("insert into public.auditoria (usuario, acao) values ('forjado', 'FORJADO2')"); }
      catch (e) { erro = e; }
      finally { await c.query("reset role"); }
      igual(erro && erro.code, "42501", "código do erro");
    });
    await teste("DEPOIS: INSERT direto como anon é negado (42501)", async () => {
      await c.query("set role anon");
      let erro = null;
      try { await c.query("insert into public.auditoria (usuario, acao) values ('forjado', 'FORJADO3')"); }
      catch (e) { erro = e; }
      finally { await c.query("reset role"); }
      igual(erro && erro.code, "42501", "código do erro");
    });
    await teste("DEPOIS: service_role mantém INSERT em auditoria", async () => {
      await c.query("set role service_role");
      try { await c.query("insert into public.auditoria (usuario, acao) values ('servico', 'SERVICO_OK')"); }
      finally { await c.query("reset role"); }
      igual((await c.query("select count(*)::int as n from public.auditoria where acao = 'SERVICO_OK'")).rows[0].n, 1, "linha de serviço");
    });
    await teste("DEPOIS: a recusa do trigger continua gravando auditoria, mesmo quando quem altera é authenticated", async () => {
      await c.query("set role authenticated");
      try { await c.query("update public.acordos_titulos set situacao = 'ABERTO' where id = $1", [titulo]); }
      finally { await c.query("reset role"); }
      const situ = (await c.query("select situacao from public.acordos_titulos where id = $1", [titulo])).rows[0].situacao;
      igual(situ, "EM_CONFIRMACAO", "situação revertida pela recusa");
      igual((await c.query("select count(*)::int as n from public.auditoria where acao = 'TITULO_EM_CONFIRMACAO_ALTERACAO_RECUSADA'")).rows[0].n, 2, "auditorias de recusa (uma antes e uma depois da correção)");
    });
    await teste("DEPOIS: a função do trigger é SECURITY DEFINER com search_path fixo", async () => {
      const r = (await c.query("select prosecdef, proconfig::text as cfg from pg_proc where proname = '_titulo_em_confirmacao_protegido'")).rows[0];
      igual(r.prosecdef, true, "security definer");
      if (!/search_path=public/.test(r.cfg || "")) throw new Error("search_path fixo ausente: " + r.cfg);
    });
  } finally {
    await c.end();
  }
  console.log(resultados.join("\n"));
  console.log(falhas ? `\nFALHOU: ${falhas} verificação(ões)` : `\nTodas passaram: ${resultados.length}`);
  process.exitCode = falhas ? 1 : 0;
}
main().catch((e) => { console.error("erro fatal:", e.message); process.exit(1); });
