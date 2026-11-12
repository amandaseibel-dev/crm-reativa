// Testes de regressao: autoria humana x autoria da rotina em prime_liquidacao_suspender
// e prime_liquidacao_reavaliar_pendentes.
//
// Uso:
//   node protecao.test.mjs              -> testa a MIGRATION corrigida (deve passar tudo)
//   node protecao.test.mjs --baseline   -> testa a versao ANTERIOR (deve FALHAR nos casos
//                                          de autoria; prova que os testes discriminam)
//
// Roda em PGlite (Postgres embutido): sem Docker, sem servico, sem producao.
// Sai com codigo 1 se qualquer caso falhar. Os casos marcados SKIP exigem Postgres real
// e NAO contam como aprovados.
//
// LIMITACOES:
//  - sem RLS, sem grants reais, sem roles (PGlite roda como superusuario);
//  - sem concorrencia real: PGlite e um processo. Ver SKIP abaixo.
//  - stubs: recalcular_situacao_aluno e prime_liquidacao_evidencias.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const BASELINE = process.argv.includes("--baseline");
const ARQ = BASELINE
  ? new URL("./baseline_funcoes_20260918230000.sql", import.meta.url)
  : new URL("../../aguardando_aprovacao/20261112230000_prime_protege_decisao_humana.sql.pendente", import.meta.url);
const CODIGO_FUNCOES = readFileSync(ARQ, "utf8");

const AUTOR_ROTINA = "prime_liquidacao@rotina";
const GESTAO = "gestao@teste.local";

const db = new PGlite();
const falhas = [];
let ok = 0;
const pulados = [];
async function caso(nome, fn) {
  try { await fn(); ok++; console.log(`ok   ${nome}`); }
  catch (e) { falhas.push({ nome, erro: e.message.split("\n")[0] }); console.log(`FAIL ${nome}\n     ${e.message.split("\n")[0]}`); }
}
function skip(nome, motivo) { pulados.push({ nome, motivo }); console.log(`SKIP ${nome}\n     ${motivo}`); }

// ---------- esquema minimo ----------
// Roles existem so para o GRANT/REVOKE do arquivo rodar. NAO testam permissao real.
await db.exec(`
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
  end $$;
`);
await db.exec(`
  create table acordos_titulos (id uuid primary key, aluno_id text, cpf text, documento text, vencimento date,
    situacao text, status text, valor_cobranca_ajustado numeric, saldo_corrigido numeric,
    valor_em_aberto numeric, valor_original numeric, atualizado_em timestamptz);
  create table prime_conferencia_decisao (titulo_id uuid primary key, decisao text not null, motivo text,
    decidido_por text, decidido_em timestamptz, motivo_entrada text, aluno_id text, cpf text, documento text,
    valor numeric, evidencia jsonb, evidencia_chave text, corroboracao text, subgrupo text, acordo_id uuid,
    acordo_numero text, revisao_obrigatoria boolean, operador_no_momento text, detectado_em timestamptz,
    situacao_anterior text, status_anterior text);
  create table casos (aluno_id text, operador_email text, encerrado_operacional boolean, caso_atualizado_em timestamptz);
  create table acordos (id uuid primary key, numero_acordo int);
  create table aluno_movimentacoes (id bigserial primary key, aluno_id text, tipo text, descricao text,
    status_anterior text, status_novo text, registrado_por_nome text, registrado_por_email text,
    registrado_em timestamptz, valor_movimentacao numeric);
  create table auditoria (id bigserial primary key, usuario text, acao text, tabela_afetada text,
    registro_id uuid, detalhes jsonb, created_at timestamp default now());
  create table prime_liquidacao_classificacao (id bigserial primary key, titulo_id uuid, aluno_id text,
    documento text, evidencia_chave text, data_liquidacao_prime date, portador int, classificacao text,
    nivel_evidencia text, motivo text, evidencia jsonb, origem_decisao text, decidido_por text,
    resultado_titulo text, pagamento_id uuid, acordo_id uuid, valor_bruto_prime numeric, valor_pago_prime numeric);
  create table ev_stub (titulo_id uuid primary key, ev jsonb);
  create function recalcular_situacao_aluno(p_aluno text, p_origem text) returns void language sql as $$ select $$;
  create function prime_liquidacao_evidencias(p_titulo uuid) returns jsonb
    language sql stable as $$ select ev from ev_stub where titulo_id = p_titulo $$;
`);
await db.exec(CODIGO_FUNCOES);

// ---------- helpers ----------
const T = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
async function titulo(n, situacao = "ABERTO") {
  await db.query(
    `insert into acordos_titulos (id, aluno_id, cpf, documento, vencimento, situacao, status, valor_original, atualizado_em)
     values ($1, $2, '12345678901', $3, '2026-08-01', $4, 'em_aberto', 100, now())`,
    [T(n), `aluno-${n}`, `DOC${n}`, situacao]);
}
async function decisao(n, dec, quem, em = "2026-09-18 10:00:00+00", subgrupo = "C_SEM_PROVA") {
  await db.query(
    `insert into prime_conferencia_decisao (titulo_id, decisao, decidido_por, decidido_em, aluno_id, documento, subgrupo, detectado_em)
     values ($1, $2, $3, $4, $5, $6, $7, now())`,
    [T(n), dec, quem, quem === null ? null : em, `aluno-${n}`, `DOC${n}`, subgrupo]);
}
async function estado(n) {
  const d = (await db.query(`select decisao, decidido_por, decidido_em::text as decidido_em from prime_conferencia_decisao where titulo_id = $1`, [T(n)])).rows[0] ?? null;
  const t = (await db.query(`select situacao from acordos_titulos where id = $1`, [T(n)])).rows[0];
  return { d, situacao: t.situacao };
}
async function suspender(n, quem = "rotina") {
  const r = await db.query(
    `select prime_liquidacao_suspender($1, 'C_SEM_PROVA', 'PRIME_ORIGEM_NAO_COMPROVADA', 'NENHUMA', 'teste',
       '{"prime":{"liquidado_em":"2026-09-01","cpf_confere":true}}'::jsonb, null, null, $2) as r`, [T(n), quem]);
  return r.rows[0].r;
}
async function reavaliar(quem = "rotina") {
  return (await db.query(`select prime_liquidacao_reavaliar_pendentes($1) as r`, [quem])).rows[0].r;
}
async function evidencia(n, ev) {
  await db.query(`insert into ev_stub values ($1, $2::jsonb)`, [T(n), JSON.stringify(ev)]);
}
const auditoriaBloq = async (n) => Number((await db.query(
  `select count(*)::int n from auditoria where registro_id = $1 and acao = 'PRIME_SUSPENSAO_BLOQUEADA_DECISAO_HUMANA'`, [T(n)])).rows[0].n);

console.log(`\nversao testada: ${BASELINE ? "BASELINE (anterior)" : "CORRIGIDA (migration pendente)"}\n`);

// ==========================================================================
// SUSPENDER: fluxo legitimo (deve funcionar nas duas versoes)
// ==========================================================================
await caso("suspender: titulo sem decisao vira PENDENTE da rotina e vai para EM_CONFIRMACAO", async () => {
  await titulo(1);
  const r = await suspender(1);
  assert.equal(r.ok, true, JSON.stringify(r));
  const e = await estado(1);
  assert.equal(e.d.decisao, "PENDENTE");
  assert.equal(e.situacao, "EM_CONFIRMACAO");
});

await caso("suspender: PENDENTE da rotina pode ser reprocessada", async () => {
  const r = await suspender(1);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal((await estado(1)).d.decisao, "PENDENTE");
});

await caso("suspender: situacao NEGOCIADO continua recusada, sem tocar", async () => {
  await titulo(2, "NEGOCIADO");
  const r = await suspender(2);
  assert.equal(r.erro, "NAO_ESTA_ABERTO");
  assert.equal((await estado(2)).d, null);
});

await caso("suspender: REJEITADO da ROTINA pode ser reaberto por nova liquidacao valida", async () => {
  await titulo(13);
  await decisao(13, "REJEITADO", AUTOR_ROTINA);
  const r = await suspender(13);
  assert.equal(r.ok, true, `rejeicao da rotina nao e humana: ${JSON.stringify(r)}`);
  const e = await estado(13);
  assert.equal(e.d.decisao, "PENDENTE");
  assert.equal(e.situacao, "EM_CONFIRMACAO");
});

// ==========================================================================
// SUSPENDER: autoria HUMANA nunca e sobrescrita
// ==========================================================================
for (const [dec, n] of [["VINCULADO", 3], ["REJEITADO", 4], ["ENCERRADO_ADMINISTRATIVO", 5], ["CONFIRMADO", 6], ["DEVOLVIDO", 7]]) {
  await caso(`suspender: decisao HUMANA ${dec} preserva decisao, autor, data e situacao`, async () => {
    await titulo(n);
    await decisao(n, dec, GESTAO);
    const antes = await estado(n);
    const r = await suspender(n);
    assert.equal(r.bloqueado, "DECISAO_HUMANA_PRESERVADA", `devia bloquear: ${JSON.stringify(r)}`);
    const depois = await estado(n);
    assert.equal(depois.d.decisao, dec);
    assert.equal(depois.d.decidido_por, GESTAO);
    assert.equal(depois.d.decidido_em, antes.d.decidido_em);
    assert.equal(depois.situacao, "ABERTO");
    assert.equal(await auditoriaBloq(n), 1);
  });
}

await caso("suspender: REJEITADO com autor HUMANO (e-mail) e tratado como humano", async () => {
  await titulo(14);
  await decisao(14, "REJEITADO", GESTAO);
  const r = await suspender(14);
  assert.equal(r.bloqueado, "DECISAO_HUMANA_PRESERVADA");
  assert.equal((await estado(14)).d.decidido_por, GESTAO);
});

await caso("suspender: PENDENTE com autor HUMANO e tratada como humana", async () => {
  await titulo(8);
  await decisao(8, "PENDENTE", GESTAO);
  const r = await suspender(8);
  assert.equal(r.bloqueado, "DECISAO_HUMANA_PRESERVADA");
  assert.equal((await estado(8)).d.decidido_por, GESTAO);
});

await caso("suspender: REJEITADO SEM autor (estado desconhecido) e tratado como humano", async () => {
  await titulo(15);
  await decisao(15, "REJEITADO", null);
  const r = await suspender(15);
  assert.equal(r.bloqueado, "DECISAO_HUMANA_PRESERVADA", `estado desconhecido deve ser conservador: ${JSON.stringify(r)}`);
});

await caso("suspender: decisao com valor DESCONHECIDO e tratada como humana", async () => {
  await titulo(16);
  await decisao(16, "ESTADO_NOVO_QUE_A_ROTINA_NAO_CONHECE", GESTAO);
  const r = await suspender(16);
  assert.equal(r.bloqueado, "DECISAO_HUMANA_PRESERVADA");
});

await caso("suspender: tentativas repetidas no mesmo dia geram UMA auditoria por titulo", async () => {
  for (let i = 0; i < 5; i++) await suspender(3);
  assert.equal(await auditoriaBloq(3), 1);
});

await caso("suspender: chamador sem e-mail (p_quem nulo) nao quebra", async () => {
  await titulo(17);
  const r = await suspender(17, null);
  assert.ok(r.ok === true || r.bloqueado === undefined, JSON.stringify(r));
});

// ==========================================================================
// REAVALIAR
// ==========================================================================
await caso("reavaliar: reverte PENDENTE da rotina quando a Prime reverte a liquidacao", async () => {
  await titulo(10, "EM_CONFIRMACAO");
  await decisao(10, "PENDENTE", null);
  await evidencia(10, { prime: { liquidado_em: null, portador: 195 }, evidencia_chave: "k10" });
  const r = await reavaliar();
  assert.equal(r.revertidas_pela_prime, 1, JSON.stringify(r));
  const e = await estado(10);
  assert.equal(e.situacao, "ABERTO");
  assert.equal(e.d.decisao, "REJEITADO");
});

await caso("reavaliar: a reversao grava a AUTORIA DA ROTINA, nunca o e-mail de quem chamou", async () => {
  await titulo(18, "EM_CONFIRMACAO");
  await decisao(18, "PENDENTE", null);
  await evidencia(18, { prime: { liquidado_em: null, portador: 195 }, evidencia_chave: "k18" });
  await reavaliar(GESTAO);
  const e = await estado(18);
  assert.equal(e.d.decisao, "REJEITADO");
  assert.equal(e.d.decidido_por, AUTOR_ROTINA, "rejeicao automatica nao pode parecer humana");
});

await caso("reavaliar: NAO reabre titulo com decisao HUMANA (PENDENTE com autor humano)", async () => {
  await titulo(11, "EM_CONFIRMACAO");
  await decisao(11, "PENDENTE", GESTAO);
  await evidencia(11, { prime: { liquidado_em: null, portador: 195 }, evidencia_chave: "k11" });
  await reavaliar();
  const e = await estado(11);
  assert.equal(e.situacao, "EM_CONFIRMACAO", "situacao nao pode voltar para ABERTO");
  assert.equal(e.d.decisao, "PENDENTE");
  assert.equal(e.d.decidido_por, GESTAO);
});

await caso("reavaliar: NAO altera decisao humana REJEITADO", async () => {
  await titulo(12, "EM_CONFIRMACAO");
  await decisao(12, "REJEITADO", GESTAO);
  await evidencia(12, { prime: { liquidado_em: null, portador: 195 }, evidencia_chave: "k12" });
  await reavaliar();
  const e = await estado(12);
  assert.equal(e.d.decisao, "REJEITADO");
  assert.equal(e.d.decidido_por, GESTAO);
  assert.equal(e.situacao, "EM_CONFIRMACAO");
});

await caso("reavaliar: informa quantas linhas humanas ficaram de fora", async () => {
  const r = await reavaliar();
  assert.ok("ignoradas_decisao_humana" in r, `chave ausente: ${JSON.stringify(r)}`);
  assert.ok(r.ignoradas_decisao_humana >= 1);
});

// ==========================================================================
// ESTRUTURA (verificacoes do arquivo; nao substituem teste de concorrencia)
// ==========================================================================
await caso("estrutura: ordem de travas titulo -> decisao no suspender", async () => {
  const s = CODIGO_FUNCOES;
  const i = s.indexOf("function public.prime_liquidacao_suspender");
  const fn = s.slice(i);
  const a = fn.indexOf("from public.acordos_titulos t where t.id = p_titulo_id for update");
  const b = fn.indexOf("from public.prime_conferencia_decisao d where d.titulo_id = p_titulo_id for update");
  assert.ok(a > 0 && b > a, "titulo deve ser travado antes da decisao");
});

await caso("estrutura: reavaliar trava titulo antes da decisao e percorre por titulo_id", async () => {
  const s = CODIGO_FUNCOES;
  const i = s.indexOf("function public.prime_liquidacao_reavaliar_pendentes");
  const fn = s.slice(i);
  const a = fn.indexOf("from public.acordos_titulos t where t.id = d.titulo_id for update");
  const b = fn.indexOf("from public.prime_conferencia_decisao x\n     where x.titulo_id = d.titulo_id for update");
  assert.ok(a > 0 && b > a, "ordem titulo -> decisao");
  assert.ok(/order by x\.titulo_id/.test(fn), "desempate por titulo_id");
});

await caso("estrutura: ACL restaurada (EXECUTE so para service_role)", async () => {
  const s = CODIGO_FUNCOES;
  assert.ok(/revoke all on function public\.prime_liquidacao_suspender[\s\S]*from public, anon, authenticated/.test(s));
  assert.ok(/grant execute on function public\.prime_liquidacao_suspender[\s\S]*to service_role/.test(s));
  assert.ok(/grant execute on function public\.prime_liquidacao_reavaliar_pendentes[\s\S]*to service_role/.test(s));
});

// ==========================================================================
// SKIP: exigem Postgres real (nao existe neste ambiente)
// ==========================================================================
skip("concorrencia: suspender x decisao humana, duas sessoes (roteiro em docs)",
  "exige Postgres real com duas sessoes; PGlite e processo unico. NAO contado como aprovado.");
skip("concorrencia: reavaliar x encerramento administrativo, ordem de travas",
  "exige Postgres real com duas sessoes. NAO contado como aprovado.");
skip("grants e RLS reais por perfil (anon, authenticated, service_role)",
  "exige Postgres com roles do Supabase. NAO contado como aprovado.");

// ==========================================================================
console.log(`\n${ok} ok, ${falhas.length} falha(s), ${pulados.length} SKIP (nao aprovados)`);
await db.close();
if (falhas.length) {
  console.log(JSON.stringify(falhas, null, 2));
  process.exit(1);
}
