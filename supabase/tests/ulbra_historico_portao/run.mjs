// Prova de acesso da RPC public.ulbra_historico_reservar: estado aplicado (ledger 20261112111006)
// -> migration corretiva 20261116150000 -> asserções de acesso permitido e negado.
// Banco descartável em memória (PGlite). Nenhuma conexão com produção.
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const raiz = process.argv[2] ?? process.cwd();
const ler = (p) => fs.readFileSync(`${raiz}/${p}`, "utf8");
const db = new PGlite();
const falhas = [];
const afirma = (nome, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${nome}`); if (!cond) falhas.push(nome); };

// Papéis e auth mínimo (imitam o Supabase)
await db.exec(`
  create schema if not exists auth;
  create or replace function auth.role() returns text language sql stable as $$
    select coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '') $$;
  do $$ begin
    if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
    if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
  end $$;
  grant usage on schema public to anon, authenticated, service_role;
`);
// Estado aplicado em produção: versão do ledger 20261112111006 (sem portão)
await db.exec(ler("supabase/ledger/2026-11/20261112111006__20261110100000_ulbra_historico_orcamento.sql"));
await db.exec("grant execute on function public.ulbra_historico_reservar(text,date,integer,integer,integer) to public;");
// Antes da correção, a chamada por authenticated passa (é a exposição a ser fechada)
await db.exec("set role authenticated; set request.jwt.claims = '{\"role\":\"authenticated\"}';");
let antes = "ok";
try { await db.query("select * from public.ulbra_historico_reservar('x@y', current_date, 1, 20, 100)"); } catch (e) { antes = "erro:" + e.message; }
await db.exec("reset role;");
afirma("ANTES: authenticated consegue chamar a RPC (exposição reproduzida)", antes === "ok");

// Aplica a migration corretiva (pendente, não aplicada em produção)
await db.exec(ler("supabase/aguardando_aprovacao/20261116150000_ulbra_historico_reservar_portao_interno.sql.pendente").replace(/\bstart transaction;|\bcommit;/gi, ""));

// Negado: authenticated (sem EXECUTE e sem service_role no JWT)
const tentativa = async (papel, role) => {
  await db.exec(`set role ${papel}; set request.jwt.claims = '${JSON.stringify({ role })}';`);
  try { await db.query("select * from public.ulbra_historico_reservar('x@y', current_date, 1, 20, 100)"); return "ok"; }
  catch (e) { return "erro:" + e.message; }
  finally { await db.exec("reset role;"); }
};
const negadoAuth = await tentativa("authenticated", "authenticated");
afirma("DEPOIS: authenticated é negado (permissão ou portão)", negadoAuth.startsWith("erro:"));
const negadoAnon = await tentativa("anon", "anon");
afirma("DEPOIS: anon é negado", negadoAnon.startsWith("erro:"));

// Portão interno: mesmo com EXECUTE concedido a authenticated, o papel do JWT não é service_role
await db.exec("grant execute on function public.ulbra_historico_reservar(text,date,integer,integer,integer) to authenticated;");
const negadoPortao = await tentativa("authenticated", "authenticated");
afirma("DEPOIS: portão interno recusa authenticated mesmo com EXECUTE concedido (defesa em profundidade)", /acesso negado/.test(negadoPortao));
await db.exec("revoke execute on function public.ulbra_historico_reservar(text,date,integer,integer,integer) from authenticated;");

// Permitido: service_role
const permitido = await tentativa("service_role", "service_role");
afirma("DEPOIS: service_role é permitido", permitido === "ok");

// search_path fixo (PREMISSA_SEGURANCA_PROJETO §4): exatamente search_path=public
const cfg = await db.query(`select proconfig from pg_proc where oid = 'public.ulbra_historico_reservar(text,date,integer,integer,integer)'::regprocedure`);
const pc = cfg.rows[0]?.proconfig;
afirma("SEARCH_PATH: função fixa em search_path=public (sem pg_temp)", Array.isArray(pc) && pc.length === 1 && pc[0] === "search_path=public");

// Grants finais: sem EXECUTE para anon/authenticated
const priv = await db.query(`select has_function_privilege('authenticated','public.ulbra_historico_reservar(text,date,integer,integer,integer)','EXECUTE') a,
  has_function_privilege('anon','public.ulbra_historico_reservar(text,date,integer,integer,integer)','EXECUTE') n`);
afirma("GRANTS: authenticated e anon sem EXECUTE", priv.rows[0].a === false && priv.rows[0].n === false);

await db.close();
console.log(falhas.length ? `\nFALHAS: ${falhas.length}` : "\nTodas as asserções passaram.");
process.exit(falhas.length ? 1 : 0);
