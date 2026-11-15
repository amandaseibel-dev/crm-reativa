// Testes da migration 20261115120000 em Postgres DESCARTÁVEL. Expectativas escritas à mão.
// Uso: ULBRA_TESTE_DESCARTAVEL=sim PGHOST=localhost PGPORT=... NODE_PATH=... node run.cjs
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const ROOT = path.resolve(__dirname, "../../..");
const INSTALADA = path.join(ROOT, "supabase/ledger/2026-11/20261112111006__20261110100000_ulbra_historico_orcamento.sql");
const MIG = path.join(ROOT, "supabase/aguardando_aprovacao/20261115120000_ulbra_historico_bloqueio_e_guarda_reserva.sql.pendente");
const ROLL = path.join(ROOT, "supabase/aguardando_aprovacao/20261115120000_ulbra_historico_bloqueio_e_guarda_reserva.rollback.sql");
const BANCO = "teste_historico_bloqueio";
const cfg = { host: process.env.PGHOST || "localhost", port: Number(process.env.PGPORT || 5432), user: process.env.PGUSER || "postgres", password: process.env.PGPASSWORD || "postgres" };
const resultados = []; let falhas = 0;
async function teste(nome, fn) { try { await fn(); resultados.push(`OK    ${nome}`); } catch (e) { falhas++; resultados.push(`FAIL  ${nome} -> ${e.message}`); } }
function igual(o, e, m) { if (JSON.stringify(o) !== JSON.stringify(e)) throw new Error(`${m}: esperado ${JSON.stringify(e)}, obtido ${JSON.stringify(o)}`); }
async function conectar(db) { const c = new Client({ ...cfg, database: db }); await c.connect(); return c; }
async function main() {
  if (process.env.ULBRA_TESTE_DESCARTAVEL !== "sim") throw new Error("RECUSADO: defina ULBRA_TESTE_DESCARTAVEL=sim");
  if (!["localhost", "127.0.0.1", "::1"].includes(cfg.host)) throw new Error("RECUSADO: host não local");
  const admin = await conectar("postgres");
  const supa = await admin.query("select nspname from pg_namespace where nspname in ('auth','storage','supabase_functions')");
  if (supa.rowCount) { await admin.end(); throw new Error("RECUSADO: schemas de Supabase"); }
  await admin.query(`do $$ begin
    if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
    if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
  end $$`);
  await admin.query(`drop database if exists ${BANCO} with (force)`);
  await admin.query(`create database ${BANCO}`);
  await admin.end();
  const c = await conectar(BANCO);
  try {
    await c.query(`create table public.ulbra_sync_estado (id boolean primary key, saldo_api_restam integer, saldo_api_em timestamptz)`);
    await c.query(`insert into public.ulbra_sync_estado (id) values (true)`);
    await c.query(fs.readFileSync(INSTALADA, "utf8"));
    await c.query("grant select, insert, update on public.ulbra_sync_estado to service_role");
    const antes = (await c.query("select count(*)::int as n from information_schema.columns where table_name='ulbra_sync_estado' and column_name like 'historico_bloqueado%'")).rows[0].n;
    igual(antes, 0, "colunas antes");
    await c.query(fs.readFileSync(MIG, "utf8"));
    const chamar = async (claim) => { if (claim) await c.query(`set local request.jwt.claim.role = '${claim}'`); return c.query("select * from public.ulbra_historico_reservar('op@x', current_date, 1, 20, 150)"); };
    await teste("migração adiciona as duas colunas de bloqueio", async () => {
      igual((await c.query("select count(*)::int as n from information_schema.columns where table_name='ulbra_sync_estado' and column_name in ('historico_bloqueado_ate','historico_bloqueado_sem_prazo')")).rows[0].n, 2, "colunas");
    });
    await teste("sem o papel de serviço no JWT, a reserva é recusada (RESERVA_NAO_AUTORIZADA) e não grava", async () => {
      await c.query("begin");
      let erro = null; try { await chamar(null); } catch (e) { erro = e; }
      await c.query("rollback");
      igual(erro && /RESERVA_NAO_AUTORIZADA/.test(erro.message), true, "recusa");
      igual((await c.query("select count(*)::int as n from public.ulbra_historico_uso")).rows[0].n, 0, "nada gravado");
    });
    await teste("com papel de serviço no JWT, a reserva funciona", async () => {
      await c.query("begin");
      const r = (await chamar("service_role")).rows[0];
      await c.query("commit");
      igual(r.permitido, true, "permitido");
    });
    await teste("authenticated e anon continuam sem EXECUTE (grant não ampliado)", async () => {
      igual((await c.query("select has_function_privilege('authenticated','public.ulbra_historico_reservar(text,date,integer,integer,integer)','EXECUTE') as ok")).rows[0].ok, false, "authenticated");
      igual((await c.query("select has_function_privilege('anon','public.ulbra_historico_reservar(text,date,integer,integer,integer)','EXECUTE') as ok")).rows[0].ok, false, "anon");
    });
    await teste("rollback volta ao estado instalado (sem guarda) e remove as colunas", async () => {
      await c.query(fs.readFileSync(ROLL, "utf8"));
      igual((await c.query("select count(*)::int as n from information_schema.columns where table_name='ulbra_sync_estado' and column_name like 'historico_bloqueado%'")).rows[0].n, 0, "colunas removidas");
      await c.query("begin");
      const r = (await chamar(null)).rows[0];
      await c.query("commit");
      igual(r.permitido, true, "volta a funcionar sem claim (versão instalada)");
    });
  } finally { await c.end(); }
  console.log(resultados.join("\n")); console.log(falhas ? `\nFALHOU: ${falhas}` : `\nTodas passaram: ${resultados.length}`);
  process.exitCode = falhas ? 1 : 0;
}
main().catch((e) => { console.error("erro fatal:", e.message); process.exit(1); });
