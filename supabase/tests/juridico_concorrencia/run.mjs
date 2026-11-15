// Teste de CONCORRENCIA REAL do Juridico: Postgres 17, DUAS conexoes, banco descartavel.
//
// O que prova (que o PGlite, sessao unica, nao consegue provar):
//  1. NOWAIT de aluno, de acordos e de parcelas: com a trava ocupada por outra sessao, a
//     aprovacao falha RAPIDO com 40001, sem esperar, sem deadlock e sem nenhuma alteracao
//     parcial (caso, aluno, historico e acordo ficam como estavam).
//  2. Depois que a outra sessao solta a trava, a MESMA aprovacao passa (nova tentativa).
//  3. Troca simultanea de parcelas vencidas do mesmo acordo: as duas atualizacoes terminam
//     sem erro (uma espera a outra), e a marca PARCELA_QUEBROU existe. NAO prova ausencia de deadlock
//     em ordem inversa (duas parcelas em ordens opostas): isso e comportamento pre-existente, nao coberto.
//
// Ambiente: monta o schema e as funcoes do fixture confirmacao_d2 (corpo de producao) mais o
// portao canonico, aplica a migration do Juridico e roda. Dados FICTICIOS.
// Uso: PGHOST PGPORT PGUSER PGPASSWORD node supabase/tests/juridico_concorrencia/run.mjs
import pg from "pg";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const FIX = resolve(AQUI, "../fixtures/confirmacao_d2");
const MIG = resolve(AQUI, "../../migrations/20261112180000_juridico_encaminhamento.sql");
const ler = (p) => readFileSync(p, "utf8");
const GESTAO = "amanda.seibel@aelbra.com.br";
const jwt = (email) => JSON.stringify({ email, role: "authenticated" });
const TERMOS = `create table if not exists public.termos_acordo (
  id uuid default gen_random_uuid() primary key, aluno_id text, status text,
  arquivo_nome text, arquivo_url text, etapa_assinatura text,
  arquivo_final_nome text, arquivo_final_url text, criado_em timestamptz default now());`;

const cfg = {
  host: process.env.PGHOST || "localhost",
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "postgres",
  password: process.env.PGPASSWORD || "postgres",
};
const DB = `juridico_conc_${process.pid}`;
const DIA0 = Date.UTC(2026, 8, 21);
const deslocamento = () => {
  const h = new Date();
  return Math.round((Date.UTC(h.getUTCFullYear(), h.getUTCMonth(), h.getUTCDate()) - DIA0) / 86400000);
};
const deslocar = (v, d) => {
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) {
    const t = new Date(Date.UTC(+v.slice(0, 4), +v.slice(5, 7) - 1, +v.slice(8, 10)) + d * 86400000);
    return t.toISOString().slice(0, 10) + v.slice(10);
  }
  if (Array.isArray(v)) return v.map((x) => deslocar(x, d));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deslocar(x, d)]));
  return v;
};
const rnd = () => Math.floor(Math.random() * 9e8) + 1e8;
const abertos = [];
const cliente = async (database = DB) => {
  const c = new pg.Client({ ...cfg, database });
  abertos.push(c);
  await c.connect();
  await c.query("set timezone = 'UTC'");
  return c;
};

async function criarBanco() {
  const admin = new pg.Client({ ...cfg, database: "postgres" });
  await admin.connect();
  await admin.query(`drop database if exists ${DB}`);
  await admin.query(`create database ${DB}`);
  await admin.end();
}

// Mesma ordem de montagem da fixture de producao usada pelos testes PGlite.
async function montar(c) {
  await c.query("create extension if not exists unaccent");
  // Roles sao globais ao cluster: o fixture os cria sem IF NOT EXISTS. Tolerar repeticao
  // (cluster local reaproveitado) sem mudar nenhuma funcao.
  const funcs = ler(resolve(FIX, "funcs.sql")).replace(
    /create role (\w+) nologin;/g,
    "do $r$ begin create role $1 nologin; exception when duplicate_object then null; end $r$;");
  await c.query(funcs);
  const dados = deslocar(JSON.parse(ler(resolve(FIX, "dados.json"))), deslocamento());
  for (const [tabela, linhas] of Object.entries(dados)) {
    for (const l of linhas) {
      await c.query(`insert into public.${tabela} select * from jsonb_populate_record(null::public.${tabela}, $1::jsonb)`, [JSON.stringify(l)]);
    }
  }
  await c.query(ler(resolve(FIX, "triggers.sql")));
  await c.query("insert into public.usuarios (nome, email, perfil, ativo) values ('Gestao Teste', $1, 'gestao', true)", [GESTAO]);
  await c.query("update public.fluxo_pagamentos_config set ligado = false where etapa in ('reconstruir_parcela_paga_antes','recuperar_acordo_avista')");
  const portao = await import(pathToFileURL(resolve(FIX, "../portao_bloqueio_administrativo.js")).href);
  await c.query(portao.PORTAO_BLOQUEIO_ADMINISTRATIVO);
  await c.query(TERMOS);
  await c.query(ler(MIG));
}

// Aluno ficticio com caso EM_ANALISE num lote. `acordo`: null | "EM_DIA" (com termo e aprovacao
// especifica do acordo ativo, feitas pela gestao antes de qualquer trava do teste).
async function criarAlunoComCaso(c, { acordo = null } = {}) {
  const n = rnd();
  const al = (await c.query(
    `insert into alunos(nome,cpf,matricula,curso,situacao_academica,semestre_divida,status_atual,status_jornada,status_acionamento,responsavel_atual_email)
     values ($1,$2,$3,'Direito','Formado','2025/1','CONTATAR','CONTATAR','CONTATAR','op1@x') returning id`,
    [`Aluno Concorrencia ${n}`, String(70000000000 + n), String(9000 + (n % 999))])).rows[0].id;
  const cpf = String(70000000000 + n);
  for (let i = 0; i < 2; i++) {
    await c.query(
      "insert into acordos_titulos(id,aluno_id,cpf,documento,vencimento,valor_original,saldo_corrigido,situacao,tipo_boleto) values (gen_random_uuid(),$1,$2,$3,'2025-06-10',500,500,'ABERTO','Cursos de Graduação Presencial')",
      [al, cpf, `DOC${n}-${i}`]);
  }
  let ac = null, parcelas = [];
  if (acordo) {
    ac = (await c.query(
      "insert into acordos(id,aluno_id,cpf,status,valor_total,saldo,qtd_parcelas,numero_acordo) values (gen_random_uuid(),$1,$2,'ATIVO',600,600,2,$3) returning id",
      [al, cpf, n])).rows[0].id;
    parcelas = (await c.query(
      `insert into parcelas(id,acordo_id,numero,valor,vencimento,status,boleto) values
         (gen_random_uuid(),$1,1,300,'2025-08-10','A_VENCER',$2),
         (gen_random_uuid(),$1,2,300,'2099-01-10','A_VENCER',$3) returning id`,
      [ac, String(800000000 + n), String(800000001 + n)])).rows.map((r) => r.id);
    await c.query("insert into termos_acordo(aluno_id,status,etapa_assinatura,arquivo_final_url,arquivo_url) values ($1,'VALIDADO','COMPLETO','https://x/f.pdf','https://x/t.pdf')", [al]);
  }
  const lote = (await c.query(
    "insert into juridico_lotes(protocolo,qtd_solicitada,criado_por) values ($1,1,$2) returning id",
    [`JUR-TESTE-${n}`, GESTAO])).rows[0].id;
  const caso = (await c.query(
    `insert into juridico_casos(lote_id,aluno_id,criado_por,acordos_na_geracao)
     values ($1,$2,$3,coalesce((select array_agg(a.id) from acordos a where a.aluno_id=$2 and upper(a.status)='ATIVO' and a.duplicado_de is null),'{}'::uuid[]))
     returning id`, [lote, al, GESTAO])).rows[0].id;
  return { al, cpf, caso, ac, parcelas };
}

async function comoGestao(c) {
  await c.query("select set_config('test.jwt', $1, false)", [jwt(GESTAO)]);
  // Se alguma trava deixasse de ser NOWAIT, a aprovacao ESPERARIA: o limite faz o teste
  // falhar com 55P03 em vez de travar a CI.
  await c.query("set lock_timeout = '5s'");
}
// Estado observavel que uma aprovacao falha NAO pode alterar.
async function foto(c, { al, caso }) {
  const r = (await c.query(
    `select jc.status, jc.acordos_assinatura,
            (select count(*)::int from juridico_historico h where h.caso_id=jc.id) hist,
            al.status_atual, al.status_jornada, al.responsavel_atual_email
       from juridico_casos jc join alunos al on al.id=jc.aluno_id where jc.id=$1`, [caso])).rows[0];
  return r;
}

const resultados = [];
async function caso(nome, fn) {
  try {
    await fn();
    resultados.push(`OK    ${nome}`);
  } catch (e) {
    resultados.push(`FALHA ${nome}\n      ${e.message}`);
    process.exitCode = 1;
  }
}

async function main() {
  await criarBanco();
  const setup = await cliente();
  await montar(setup);
  await setup.end();

  // ---- 1. NOWAIT do ALUNO -------------------------------------------------------------
  await caso("NOWAIT aluno: aprovacao falha rapido com 40001, sem alteracao parcial, e a nova tentativa passa", async () => {
    const s = await cliente(); await comoGestao(s);
    const H = await cliente(); // detem a trava do aluno
    const x = await criarAlunoComCaso(s);
    const antes = await foto(s, x);
    await H.query("begin");
    await H.query("select 1 from alunos where id=$1 for update", [x.al]);
    const t0 = Date.now();
    let err = null;
    try { await s.query("select public.juridico_caso_aprovar($1)", [x.caso]); } catch (e) { err = e; }
    const dt = Date.now() - t0;
    assert.ok(err, "a aprovacao devia falhar com a trava ocupada");
    assert.equal(err.code, "40001");
    assert.match(err.message, /Tente novamente/);
    assert.ok(dt < 2000, `falha devia ser imediata (espera nao permitida), levou ${dt} ms`);
    assert.deepEqual(await foto(s, x), antes, "nenhuma alteracao parcial");
    await H.query("rollback");
    const ok = (await s.query("select public.juridico_caso_aprovar($1) j", [x.caso])).rows[0].j;
    assert.equal(ok.status, "APROVADO");
    await H.end(); await s.end();
  });

  // ---- 2. NOWAIT de ACORDO ------------------------------------------------------------
  await caso("NOWAIT acordos: aprovacao falha rapido com 40001 e nao altera nada", async () => {
    const s = await cliente(); await comoGestao(s);
    const H = await cliente();
    const x = await criarAlunoComCaso(s, { acordo: "EM_DIA" });
    await s.query("select public.juridico_caso_aprovar_acordo_ativo($1,'pedido do juridico',$2)", [x.caso, [x.ac]]);
    const antes = await foto(s, x);
    await H.query("begin");
    await H.query("select 1 from acordos where id=$1 for update", [x.ac]);
    let err = null;
    const t0 = Date.now();
    try { await s.query("select public.juridico_caso_aprovar($1)", [x.caso]); } catch (e) { err = e; }
    // sem o limite de tempo, uma trava que ESPERA passaria: o lock_timeout converteria a espera em 40001
    assert.ok(Date.now() - t0 < 2000, "acordos: a aprovacao esperou a trava em vez de falhar rapido");
    assert.ok(err); assert.equal(err.code, "40001");
    assert.deepEqual(await foto(s, x), antes);
    await H.query("rollback");
    assert.equal((await s.query("select public.juridico_caso_aprovar($1) j", [x.caso])).rows[0].j.status, "APROVADO");
    await H.end(); await s.end();
  });

  // ---- 3. NOWAIT de PARCELA -----------------------------------------------------------
  await caso("NOWAIT parcelas: aprovacao falha rapido com 40001, sem alteracao parcial", async () => {
    const s = await cliente(); await comoGestao(s);
    const H = await cliente();
    const x = await criarAlunoComCaso(s, { acordo: "EM_DIA" });
    await s.query("select public.juridico_caso_aprovar_acordo_ativo($1,'pedido do juridico',$2)", [x.caso, [x.ac]]);
    const antes = await foto(s, x);
    await H.query("begin");
    await H.query("select 1 from parcelas where id=$1 for update", [x.parcelas[0]]);
    let err = null;
    const t0 = Date.now();
    try { await s.query("select public.juridico_caso_aprovar($1)", [x.caso]); } catch (e) { err = e; }
    // sem o limite de tempo, uma trava que ESPERA passaria: o lock_timeout converteria a espera em 40001
    assert.ok(Date.now() - t0 < 2000, "parcelas: a aprovacao esperou a trava em vez de falhar rapido");
    assert.ok(err); assert.equal(err.code, "40001");
    assert.deepEqual(await foto(s, x), antes);
    await H.query("rollback");
    assert.equal((await s.query("select public.juridico_caso_aprovar($1) j", [x.caso])).rows[0].j.status, "APROVADO");
    await H.end(); await s.end();
  });

  // ---- 4. TROCA SIMULTANEA DE PARCELAS VENCIDAS ---------------------------------------
  await caso("troca simultanea de parcelas vencidas do mesmo acordo: sem erro, com marca", async () => {
    const s = await cliente(); await comoGestao(s);
    const H1 = await cliente(), H2 = await cliente();
    const x = await criarAlunoComCaso(s, { acordo: "EM_DIA" });
    await s.query("select public.juridico_caso_aprovar_acordo_ativo($1,'pedido do juridico',$2)", [x.caso, [x.ac]]);
    await s.query("select public.juridico_caso_aprovar($1)", [x.caso]);
    await H1.query("begin");
    await H1.query("update parcelas set status='VENCIDA' where id=$1", [x.parcelas[0]]);
    console.error("  t4: H1 updated"); // H1 segura aluno/acordo pelo gatilho
    // H2 quer a OUTRA parcela do mesmo acordo: espera H1 e termina sem erro (nao prova ausencia de deadlock em ordem inversa)
    // PID obtido ANTES de H2 bloquear (uma consulta enfileirada atras do UPDATE travaria o teste)
    const pidH2 = (await H2.query("select pg_backend_pid() p")).rows[0].p;
    const h2 = H2.query("update parcelas set status='VENCIDA' where id=$1", [x.parcelas[1]]);
    // Sincronizacao VERIFICAVEL: a H2 precisa aparecer ESPERANDO uma trava (pg_stat_activity)
    // enquanto a H1 segura a linha. Monitor proprio, com limite de 5 s.
    const M = await cliente();
    let esperando = false;
    for (let k = 0; k < 100 && !esperando; k++) {
      const r = await M.query("select wait_event_type t from pg_stat_activity where pid=$1", [pidH2]);
      esperando = r.rows[0]?.t === "Lock";
      if (!esperando) await new Promise((r2) => setTimeout(r2, 50));
    }
    await M.end();
    assert.ok(esperando, "H2 devia aparecer esperando uma trava (Lock) enquanto a H1 segura a linha");
    await H1.query("commit");
    await h2;
    console.error("  t4: h2 ok"); // resolve sem erro
    const st = (await s.query("select status from parcelas where acordo_id=$1 order by numero", [x.ac])).rows.map((r) => r.status);
    assert.deepEqual(st, ["VENCIDA", "VENCIDA"]);
    const marcas = (await s.query("select count(*)::int n from juridico_historico where caso_id=$1 and evento='PARCELA_QUEBROU'", [x.caso])).rows[0].n;
    // Cada transacao gravou a quebra vista no SEU snapshot: 1 ou 2 marcas, ambas reais. Nunca 0.
    assert.ok(marcas >= 1 && marcas <= 2, `marcas de quebra fora do esperado: ${marcas}`);
    await H1.end(); await H2.end(); await s.end();
  });

  // ---- 5. CASCATA: o update do aluno para JURIDICO atualiza casos; casos travados -----------
  await caso("casos do aluno travados por outra sessao: aprovacao recusada em tempo limitado, sem alteracao", async () => {
    const s5 = await cliente(); await comoGestao(s5);
    const H = await cliente();
    const x = await criarAlunoComCaso(s5);
    await s5.query("insert into casos(id,aluno_id,nome,cpf_limpo,cpf,operador_email,operador_nome,status_atual,status_acionamento) values (gen_random_uuid(),$1,'Aluno Conc',$2,$2,'op1@x','Op Um','CONTATAR','CONTATAR')", [x.al, x.cpf]);
    const antes = await foto(s5, x);
    await H.query("begin");
    await H.query("select 1 from casos where aluno_id=$1 for update", [x.al]);
    const t0 = Date.now();
    let err = null;
    try { await s5.query("select public.juridico_caso_aprovar($1)", [x.caso]); } catch (e) { err = e; }
    const dt = Date.now() - t0;
    assert.ok(err, "a aprovacao devia ser recusada com casos travados");
    assert.equal(err.code, "40001");
    assert.match(err.message, /Nada foi gravado/);
    assert.ok(dt >= 2500 && dt < 10000, `espera limitada (~3 s), medida ${dt} ms`);
    assert.deepEqual(await foto(s5, x), antes, "nenhuma alteracao parcial (aluno volta ao estado anterior)");
    await H.query("rollback");
    assert.equal((await s5.query("select public.juridico_caso_aprovar($1) j", [x.caso])).rows[0].j.status, "APROVADO");
    await H.end(); await s5.end();
  });

  // Fecha TODAS as conexoes, inclusive as de cenarios que falharam (senao o processo nao sai).
  await Promise.allSettled(abertos.map((c) => c.end()));
  console.log(resultados.join("\n"));
  const falhas = resultados.filter((r) => r.startsWith("FALHA")).length;
  console.log(`\n${resultados.length - falhas}/${resultados.length} cenarios passaram`);
  process.exit(falhas ? 1 : 0);
}

main().catch((e) => { console.error("ERRO FATAL:", e); process.exit(1); });
