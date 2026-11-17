// Prova da tabulação de termo físico com PostgREST REAL (16.5), em banco DESCARTÁVEL.
// Mesmo padrão de supabase/tests/ulbra_historico_bloqueio/postgrest_guarda.cjs (#948).
// O authenticator é criado NOINHERIT e membro de anon/authenticated/service_role, como no Supabase:
// o PostgREST conecta como authenticator e faz SET ROLE para o papel da claim. JWTs são gerados aqui,
// com segredo aleatório de teste (não são de produção). Não prova a configuração efetiva do projeto.
// Uso: TERMO_TESTE_DESCARTAVEL=sim POSTGREST_BIN=<bin> PGHOST=localhost PGPORT=5432 PGUSER=postgres PGPASSWORD=... NODE_PATH=... node postgrest_termo_fisico.cjs
const fs = require("fs"); const path = require("path"); const crypto = require("crypto");
const { spawn } = require("child_process"); const { Client } = require("pg");
const ROOT = path.resolve(__dirname, "../../..");
const AMBIENTE = path.join(__dirname, "01_ambiente.sql");
const MIG = path.join(ROOT, "supabase/aguardando_aprovacao/20261114120000_tabulacao_termo_fisico_restrita_gestao.sql.pendente");
const BIN = process.env.POSTGREST_BIN; const BANCO = "teste_termo_postgrest"; const PORTA = 3998;
const cfg = { host: process.env.PGHOST || "localhost", port: Number(process.env.PGPORT || 5432), user: process.env.PGUSER || "postgres", password: process.env.PGPASSWORD || "postgres" };
const linhas = []; let falhas = 0;
const registrar = (ok, nome, detalhe) => { if (!ok) falhas++; linhas.push(`${ok ? "OK  " : "FAIL"}  ${nome}${detalhe ? " — " + detalhe : ""}`); };
const b64 = (b) => Buffer.from(b).toString("base64url");
function jwt(segredo, claims) {
  const h = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const p = b64(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 600, ...claims }));
  const s = crypto.createHmac("sha256", segredo).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${s}`;
}
async function http(metodo, rota, token, corpo) {
  const cab = { "Content-Type": "application/json", Prefer: "return=representation" };
  if (token) cab.Authorization = `Bearer ${token}`;
  const r = await fetch(`http://localhost:${PORTA}${rota}`, { method: metodo, headers: cab, body: corpo ? JSON.stringify(corpo) : undefined });
  const texto = await r.text();
  return { status: r.status, texto };
}
const LINHA = (aluno, tipo, status, email) => ({ aluno_id: aluno, tipo, status_novo: status, descricao: "Registro administrativo do termo físico.", registrado_por_email: email });
(async () => {
  if (process.env.TERMO_TESTE_DESCARTAVEL !== "sim") throw new Error("RECUSADO: defina TERMO_TESTE_DESCARTAVEL=sim");
  if (!BIN) throw new Error("defina POSTGREST_BIN");
  if (!["localhost", "127.0.0.1", "::1"].includes(cfg.host)) throw new Error("RECUSADO: host não local");
  const admin = new Client({ ...cfg, database: "postgres" }); await admin.connect();
  const supa = await admin.query("select nspname from pg_namespace where nspname in ('storage','supabase_functions')");
  if (supa.rowCount) { await admin.end(); throw new Error("RECUSADO: schemas de Supabase"); }
  await admin.query(`do $$ begin
    if not exists (select 1 from pg_roles where rolname='authenticator') then create role authenticator login noinherit password 'auth_teste_pw'; end if;
    if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
    if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
  end $$`);
  await admin.query(`drop database if exists ${BANCO} with (force)`); await admin.query(`create database ${BANCO}`); await admin.end();
  const c = new Client({ ...cfg, database: BANCO }); await c.connect();
  await c.query(fs.readFileSync(AMBIENTE, "utf8"));
  await c.query(fs.readFileSync(MIG, "utf8"));
  await c.query("grant anon, authenticated, service_role to authenticator");
  await c.query("alter role authenticator password 'auth_teste_pw'");
  const SEGREDO = crypto.randomBytes(48).toString("hex");
  const srv = spawn(BIN, [], { env: { ...process.env, PGRST_DB_URI: `postgres://authenticator:auth_teste_pw@${cfg.host}:${cfg.port}/${BANCO}`, PGRST_DB_SCHEMAS: "public", PGRST_DB_ANON_ROLE: "anon", PGRST_JWT_SECRET: SEGREDO, PGRST_SERVER_PORT: String(PORTA) }, stdio: ["ignore", "pipe", "pipe"] });
  let logs = ""; srv.stderr.on("data", (d) => (logs += d)); srv.stdout.on("data", (d) => (logs += d));
  const OP = "operador.teste@exemplo.local", AMANDA = "amanda.seibel@aelbra.com.br";
  const opTok = jwt(SEGREDO, { role: "authenticated", email: OP });
  const gestTok = jwt(SEGREDO, { role: "authenticated", email: AMANDA });
  const contar = async () => Number((await c.query("select count(*)::int n from public.aluno_movimentacoes")).rows[0].n);
  try {
    for (let i = 0; i < 60; i++) { try { const r = await fetch(`http://localhost:${PORTA}/`); if (r.status) break; } catch {} await new Promise((r) => setTimeout(r, 250)); }
    const RESTRITO = /restrita à gestão|restrito à gestão/;
    // 1) operador, claim authenticated válida: recusado com mensagem específica e sem linha gravada
    let n0 = await contar();
    let r = await http("POST", "/aluno_movimentacoes", opTok, LINHA("r1", "REGISTRO_ADMINISTRATIVO", "TERMO_FISICO_EM_ANDAMENTO", OP));
    registrar(r.status >= 400 && RESTRITO.test(r.texto) && (await contar()) === n0, "operador: REGISTRO com código restrito recusado (mensagem e sem linha)", `status ${r.status}`);
    r = await http("POST", "/aluno_movimentacoes", opTok, LINHA("r1", "CONTATO", "TERMO_FISICO_ARQUIVADO", OP));
    registrar(r.status >= 400 && RESTRITO.test(r.texto) && (await contar()) === n0, "operador: código restrito em CONTATO recusado", `status ${r.status}`);
    // 2) claim service_role assinada, mas e-mail de operador: a claim NÃO concede bypass (B2)
    const svcTok = jwt(SEGREDO, { role: "service_role", email: OP });
    r = await http("POST", "/aluno_movimentacoes", svcTok, LINHA("r1", "CONTATO", "TERMO_FISICO_ARQUIVADO", OP));
    registrar(r.status >= 400 && (await contar()) === n0, "claim service_role com e-mail de operador não concede bypass", `status ${r.status}`);
    // 3) JWT forjado (outro segredo): recusado pelo PostgREST
    const forjado = jwt("segredo-errado-" + crypto.randomBytes(8).toString("hex"), { role: "authenticated", email: AMANDA });
    r = await http("POST", "/aluno_movimentacoes", forjado, LINHA("r1", "REGISTRO_ADMINISTRATIVO", "TERMO_FISICO_ARQUIVADO", AMANDA));
    registrar(r.status === 401 && (await contar()) === n0, "JWT com assinatura inválida recusado (401)", `status ${r.status}`);
    // 4) claim sem e-mail: não é gestão
    const semEmail = jwt(SEGREDO, { role: "authenticated" });
    r = await http("POST", "/aluno_movimentacoes", semEmail, LINHA("r1", "REGISTRO_ADMINISTRATIVO", "TERMO_FISICO_ARQUIVADO", AMANDA));
    registrar(r.status >= 400 && (await contar()) === n0, "claim sem e-mail não vira gestão", `status ${r.status}`);
    // 5) anon sem JWT
    r = await http("POST", "/aluno_movimentacoes", null, LINHA("r1", "CONTATO", "TERMO_FISICO_ARQUIVADO", OP));
    registrar(r.status >= 400 && (await contar()) === n0, "anon sem JWT recusado", `status ${r.status}`);
    // 6) RPC como operador: recusada com mensagem da função
    r = await http("POST", "/rpc/registrar_administrativo_termo_fisico", opTok, { p_aluno_id: "r1", p_codigo: "TERMO_FISICO_ARQUIVADO" });
    registrar(r.status >= 400 && /restrito à gestão ativa/.test(r.texto) && (await contar()) === n0, "RPC como operador recusada com mensagem específica", `status ${r.status}`);
    // 7) positivos: gestão grava pela RPC; operador grava CONTATAR normal
    r = await http("POST", "/rpc/registrar_administrativo_termo_fisico", gestTok, { p_aluno_id: "a0000000-0000-0000-0000-000000000042", p_codigo: "TERMO_FISICO_ARQUIVADO" });
    registrar(r.status === 200 && (await contar()) === n0 + 1, "gestão (Amanda) registra pela RPC: uma linha", `status ${r.status}`);
    r = await http("POST", "/aluno_movimentacoes", opTok, LINHA("r1", "CONTATO", "CONTATAR", OP));
    registrar(r.status === 201 && (await contar()) === n0 + 2, "operador grava CONTATAR normal (não restrito)", `status ${r.status}`);
    // 8) documentado: sessão postgres (manutenção) com SET ROLE authenticated NÃO é recusada pelo gatilho.
    //    Aceito como caminho administrativo; o teste prova o comportamento para que a decisão fique explícita.
    await c.query("set role authenticated");
    await c.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ role: "authenticated", email: OP })]);
    let adm = "ok";
    try { await c.query("insert into public.aluno_movimentacoes (aluno_id,tipo,status_novo,registrado_por_email) values ('r1','CONTATO','TERMO_FISICO_ARQUIVADO',$1)", [OP]); }
    catch (e) { adm = e.message; }
    await c.query("reset role");
    registrar(adm === "ok", "CARACTERIZAÇÃO, NÃO APROVADA: sessão postgres (manutenção) + SET ROLE authenticated é aceita pelo gatilho; não é decisão da gestão", adm);
  } finally {
    srv.kill("SIGTERM"); await c.end().catch(() => {});
  }
  console.log(linhas.join("\n")); console.log(falhas ? `\nFALHOU: ${falhas}` : `\nTodas passaram: ${linhas.length}`);
  if (falhas) console.log("\nLogs PostgREST (últimos):\n" + logs.slice(-2000));
  process.exitCode = falhas ? 1 : 0;
})().catch((e) => { console.error("erro fatal:", e.message); process.exit(1); });
