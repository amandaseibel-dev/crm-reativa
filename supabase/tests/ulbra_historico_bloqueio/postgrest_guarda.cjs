// Prova da guarda de ulbra_historico_reservar com PostgREST REAL (versão 16.5), em banco DESCARTÁVEL.
// JWTs gerados aqui, com segredo aleatório de teste: não são de produção e não são guardados.
// Uso: ULBRA_TESTE_DESCARTAVEL=sim POSTGREST_BIN=<caminho> PGHOST=localhost PGPORT=5499 PGUSER=postgres PGPASSWORD=... NODE_PATH=... node postgrest_guarda.cjs
// Distinção: esta prova mostra o comportamento deste PostgREST com este SQL. Não prova a configuração
// efetiva do projeto Supabase (que não é lida aqui).
const fs = require("fs"); const path = require("path"); const crypto = require("crypto");
const { spawn } = require("child_process"); const { Client } = require("pg");
const ROOT = path.resolve(__dirname, "../../..");
const INST = path.join(ROOT, "supabase/ledger/2026-11/20261112111006__20261110100000_ulbra_historico_orcamento.sql");
const MIG = path.join(ROOT, "supabase/aguardando_aprovacao/20261115120000_ulbra_historico_bloqueio_e_guarda_reserva.sql.pendente");
const BIN = process.env.POSTGREST_BIN; const BANCO = "teste_postgrest"; const PORTA = 3999;
const cfg = { host: process.env.PGHOST || "localhost", port: Number(process.env.PGPORT || 5432), user: process.env.PGUSER || "postgres", password: process.env.PGPASSWORD || "postgres" };
const linhas = []; let falhas = 0;
const registrar = (ok, nome, detalhe) => { if (!ok) falhas++; linhas.push(`${ok ? "OK  " : "FAIL"}  ${nome}${detalhe ? " — " + detalhe : ""}`); };
const b64 = (b) => Buffer.from(b).toString("base64url");
function jwt(segredo, role) {
  const h = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const p = b64(JSON.stringify({ role, exp: Math.floor(Date.now() / 1000) + 600 }));
  const s = crypto.createHmac("sha256", segredo).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${s}`;
}
async function chamar(token, corpo) {
  const cab = { "Content-Type": "application/json" }; if (token) cab.Authorization = `Bearer ${token}`;
  const r = await fetch(`http://localhost:${PORTA}/rpc/ulbra_historico_reservar`, { method: "POST", headers: cab, body: JSON.stringify(corpo) });
  const texto = await r.text(); let j = null; try { j = JSON.parse(texto); } catch {}
  return { status: r.status, corpo: j, texto };
}
(async () => {
  if (process.env.ULBRA_TESTE_DESCARTAVEL !== "sim") throw new Error("RECUSADO: defina ULBRA_TESTE_DESCARTAVEL=sim");
  if (!BIN) throw new Error("defina POSTGREST_BIN");
  if (!["localhost", "127.0.0.1", "::1"].includes(cfg.host)) throw new Error("RECUSADO: host não local");
  const admin = await new Client({ ...cfg, database: "postgres" }); await admin.connect();
  const supa = await admin.query("select nspname from pg_namespace where nspname in ('auth','storage','supabase_functions')");
  if (supa.rowCount) { await admin.end(); throw new Error("RECUSADO: schemas de Supabase"); }
  await admin.query(`do $$ begin
    if not exists (select 1 from pg_roles where rolname='authenticator') then create role authenticator login noinherit; end if;
    if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
    if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
  end $$`);
  const SENHA_TESTE = crypto.randomBytes(24).toString("hex"); // exclusiva deste teste; não guardada
  await admin.query(`alter role authenticator password '${SENHA_TESTE}'`);
  await admin.query(`drop database if exists ${BANCO} with (force)`); await admin.query(`create database ${BANCO}`); await admin.end();
  const c = new Client({ ...cfg, database: BANCO }); await c.connect();
  await c.query("create table public.ulbra_sync_estado (id boolean primary key, saldo_api_restam integer, saldo_api_em timestamptz)");
  await c.query("insert into public.ulbra_sync_estado (id) values (true)");
  await c.query(fs.readFileSync(INST, "utf8"));
  await c.query(fs.readFileSync(path.join(ROOT, "supabase/tests/ulbra_historico_bloqueio/auth_plataforma.sql"), "utf8"));
  await c.query(fs.readFileSync(MIG, "utf8"));
  await c.query("grant usage on schema public to anon, authenticated, service_role");
  await c.query("grant anon, authenticated, service_role to authenticator");
  const SEGREDO = crypto.randomBytes(48).toString("hex"); // exclusivo deste teste
  const srv = spawn(BIN, [], { env: { ...process.env, PGRST_DB_URI: `postgres://authenticator:${SENHA_TESTE}@${cfg.host}:${cfg.port}/${BANCO}`, PGRST_DB_SCHEMAS: "public", PGRST_DB_ANON_ROLE: "anon", PGRST_JWT_SECRET: SEGREDO, PGRST_SERVER_PORT: String(PORTA) }, stdio: ["ignore", "pipe", "pipe"] });
  let logs = ""; srv.stderr.on("data", (d) => (logs += d)); srv.stdout.on("data", (d) => (logs += d));
  try {
    for (let i = 0; i < 60; i++) { try { const r = await fetch(`http://localhost:${PORTA}/`); if (r.status) break; } catch {} await new Promise((r) => setTimeout(r, 250)); }
    const corpo = { p_operador: "op-guarda@x", p_dia: "2026-11-20", p_quantidade: 1, p_teto_operador: 20, p_teto_global: 150 };
    // 1) caminho legítimo de serviço
    const sv = await chamar(jwt(SEGREDO, "service_role"), corpo);
    registrar(sv.status === 200 && sv.corpo && sv.corpo[0] && sv.corpo[0].permitido === true, "serviço (service_role no JWT) é aceito pela guarda via PostgREST", `status ${sv.status}`);
    // 2) usuário autenticado: negado pelo grant (e a guarda também recusaria)
    const au = await chamar(jwt(SEGREDO, "authenticated"), corpo);
    registrar(au.status >= 400 && /permission denied|42501|RESERVA_NAO_AUTORIZADA/.test(au.texto), "usuário autenticado é recusado", `status ${au.status}`);
    // 3) anon (sem JWT): negado
    const an = await chamar(null, corpo);
    registrar(an.status >= 400 && /permission denied|42501|RESERVA_NAO_AUTORIZADA/.test(an.texto), "anon (sem JWT) é recusado", `status ${an.status}`);
    // 4) guarda ISOLADA: grant liberado de propósito só no banco descartável, para provar que a guarda sozinha recusa
    await c.query("grant execute on function public.ulbra_historico_reservar(text,date,integer,integer,integer) to authenticated, anon");
    await new Promise((r) => setTimeout(r, 300));
    const gA = await chamar(jwt(SEGREDO, "authenticated"), corpo);
    registrar(gA.status >= 400 && /RESERVA_NAO_AUTORIZADA/.test(gA.texto), "guarda isolada recusa authenticated (grant liberado de propósito)", `status ${gA.status}`);
    const gN = await chamar(null, corpo);
    registrar(gN.status >= 400 && /RESERVA_NAO_AUTORIZADA/.test(gN.texto), "guarda isolada recusa contexto ausente/anon", `status ${gN.status}`);
    const gS = await chamar(jwt(SEGREDO, "service_role"), corpo);
    registrar(gS.status === 200, "guarda isolada aceita service_role mesmo com grant liberado", `status ${gS.status}`);
    await c.query("revoke execute on function public.ulbra_historico_reservar(text,date,integer,integer,integer) from authenticated, anon");
    await new Promise((r) => setTimeout(r, 300));
    const pos = await chamar(jwt(SEGREDO, "authenticated"), corpo);
    registrar(pos.status >= 400, "após revogar, authenticated volta a ser recusado pelo grant", `status ${pos.status}`);
  } finally {
    srv.kill("SIGTERM"); await c.end();
  }
  console.log(linhas.join("\n")); console.log(falhas ? `\nFALHOU: ${falhas}` : `\nTodas passaram: ${linhas.length}`);
  process.exitCode = falhas ? 1 : 0;
})().catch((e) => { console.error("erro fatal:", e.message); process.exit(1); });
