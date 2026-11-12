// Testes de regressao da protecao de decisoes humanas (prime_liquidacao_suspender
// e prime_liquidacao_reavaliar_pendentes), contra a migration pendente.
//
// Roda em PGlite (Postgres embutido): sem Docker, sem servico, sem producao.
// SAIDA: exit 0 so se TODAS as asserções passarem. Divergencia = exit 1.
//
// LIMITACOES (declaradas, nao escondidas):
//  - Nao valida RLS nem grants reais: o teste roda como superusuario local.
//  - Nao valida concorrencia de verdade: PGlite e um unico processo. A serializacao
//    e garantida por FOR UPDATE no codigo; o teste de concorrencia de duas sessoes
//    fica como roteiro manual em Postgres isolado (ver docs da PR).
//  - Stubs: recalcular_situacao_aluno e prime_liquidacao_evidencias sao substituidos
//    por funcoes de teste. O corpo das duas funcoes testadas e o da migration.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const MIGRATION = new URL(
  "../../aguardando_aprovacao/20261112230000_prime_protege_decisao_humana.sql.pendente",
  import.meta.url
);

const db = new PGlite();
const falhas = [];
let ok = 0;
async function caso(nome, fn) {
  try {
    await fn();
    ok++;
    console.log(`ok   ${nome}`);
  } catch (e) {
    falhas.push({ nome, erro: e.message });
    console.log(`FAIL ${nome}\n     ${e.message.split("\n")[0]}`);
  }
}

// ---------- esquema minimo (so as colunas que as duas funcoes usam) ----------
await db.exec(`
  create table acordos_titulos (
    id uuid primary key, aluno_id text, cpf text, documento text, vencimento date,
    situacao text, status text, valor_cobranca_ajustado numeric, saldo_corrigido numeric,
    valor_em_aberto numeric, valor_original numeric, atualizado_em timestamptz);
  create table prime_conferencia_decisao (
    titulo_id uuid primary key, decisao text not null, motivo text, decidido_por text,
    decidido_em timestamptz, motivo_entrada text, aluno_id text, cpf text, documento text,
    valor numeric, evidencia jsonb, evidencia_chave text, corroboracao text, subgrupo text,
    acordo_id uuid, acordo_numero text, revisao_obrigatoria boolean, operador_no_momento text,
    detectado_em timestamptz, situacao_anterior text, status_anterior text);
  create table casos (aluno_id text, operador_email text, encerrado_operacional boolean,
    caso_atualizado_em timestamptz);
  create table acordos (id uuid primary key, numero_acordo int);
  create table aluno_movimentacoes (id bigserial primary key, aluno_id text, tipo text,
    descricao text, status_anterior text, status_novo text, registrado_por_nome text,
    registrado_por_email text, registrado_em timestamptz, valor_movimentacao numeric);
  create table auditoria (id bigserial primary key, usuario text, acao text, tabela_afetada text,
    registro_id uuid, detalhes jsonb, created_at timestamp default now());
  create table prime_liquidacao_classificacao (id bigserial primary key, titulo_id uuid,
    aluno_id text, documento text, evidencia_chave text, data_liquidacao_prime date,
    portador int, classificacao text, nivel_evidencia text, motivo text, evidencia jsonb,
    origem_decisao text, decidido_por text, resultado_titulo text, pagamento_id uuid,
    acordo_id uuid, valor_bruto_prime numeric, valor_pago_prime numeric);
  create table ev_stub (titulo_id uuid primary key, ev jsonb);

  -- stubs
  create function recalcular_situacao_aluno(p_aluno text, p_origem text) returns void
    language sql as $$ select $$;
  create function prime_liquidacao_evidencias(p_titulo uuid) returns jsonb
    language sql stable as $$ select ev from ev_stub where titulo_id = p_titulo $$;
`);

// ---------- migration sob teste (o arquivo real, sem copia) ----------
await db.exec(readFileSync(MIGRATION, "utf8"));

// ---------- helpers ----------
const T = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const HUMANO = "gestao@teste.local";

async function titulo(n, situacao = "ABERTO", vencimento = "2026-08-01") {
  await db.query(
    `insert into acordos_titulos (id, aluno_id, cpf, documento, vencimento, situacao, status, valor_original, atualizado_em)
     values ($1, $2, '12345678901', $3, $4, $5, 'em_aberto', 100, now())`,
    [T(n), `aluno-${n}`, `DOC${n}`, vencimento, situacao]
  );
}
async function decisao(n, decisao, decidido_por = null, decidido_em = null) {
  await db.query(
    `insert into prime_conferencia_decisao (titulo_id, decisao, decidido_por, decidido_em, aluno_id, documento, subgrupo, detectado_em)
     values ($1, $2, $3, $4, $5, $6, 'C_SEM_PROVA', now())`,
    [T(n), decisao, decidido_por, decidido_em, `aluno-${n}`, `DOC${n}`]
  );
}
async function estado(n) {
  const d = (await db.query(`select decisao, decidido_por, decidido_em::text as decidido_em from prime_conferencia_decisao where titulo_id = $1`, [T(n)])).rows[0] ?? null;
  const t = (await db.query(`select situacao from acordos_titulos where id = $1`, [T(n)])).rows[0];
  return { d, situacao: t.situacao };
}
async function suspender(n, { subgrupo = "C_SEM_PROVA", classe = "PRIME_ORIGEM_NAO_COMPROVADA", quem = "rotina" } = {}) {
  const r = await db.query(
    `select prime_liquidacao_suspender($1, $2, $3, 'NENHUMA', 'teste', '{"prime":{"liquidado_em":"2026-09-01","cpf_confere":true}}'::jsonb, null, null, $4) as r`,
    [T(n), subgrupo, classe, quem]
  );
  return r.rows[0].r;
}
const auditoriaBloqueios = async (n) =>
  Number((await db.query(`select count(*)::int as n from auditoria where registro_id = $1 and acao = 'PRIME_SUSPENSAO_BLOQUEADA_DECISAO_HUMANA'`, [T(n)])).rows[0].n);

// ==========================================================================
// SUSPENDER: fluxo legitimo preservado
// ==========================================================================
await caso("suspender: titulo sem decisao vira PENDENTE e vai para EM_CONFIRMACAO", async () => {
  await titulo(1);
  const r = await suspender(1);
  assert.equal(r.ok, true, JSON.stringify(r));
  const e = await estado(1);
  assert.equal(e.d.decisao, "PENDENTE");
  assert.equal(e.situacao, "EM_CONFIRMACAO");
  const mov = (await db.query(`select count(*)::int n from aluno_movimentacoes where aluno_id = 'aluno-1' and tipo = 'TITULO_EM_CONFIRMACAO_PRIME'`)).rows[0].n;
  assert.equal(mov, 1, "deve gravar a movimentacao legitima uma vez");
});

await caso("suspender: PENDENTE criada pela rotina (sem decidido_por) pode ser reprocessada", async () => {
  const r = await suspender(1);
  assert.equal(r.ok, true, JSON.stringify(r));
  const e = await estado(1);
  assert.equal(e.d.decisao, "PENDENTE");
  assert.equal(e.d.decidido_por, null);
});

await caso("suspender: situacao NEGOCIADO continua retornando NAO_ESTA_ABERTO, sem tocar", async () => {
  await titulo(2, "NEGOCIADO");
  const r = await suspender(2);
  assert.equal(r.erro, "NAO_ESTA_ABERTO");
  assert.equal((await estado(2)).d, null);
});

// ==========================================================================
// SUSPENDER: decisoes humanas NAO podem ser sobrescritas
// ==========================================================================
const humanas = [
  ["VINCULADO", 3],
  ["REJEITADO", 4],
  ["ENCERRADO_ADMINISTRATIVO", 5],
  ["CONFIRMADO", 6],
  ["DEVOLVIDO", 7],
];
for (const [dec, n] of humanas) {
  await caso(`suspender: decisao humana ${dec} preserva decisao, autor, data e situacao`, async () => {
    await titulo(n);
    await decisao(n, dec, HUMANO, "2026-09-18 17:57:39+00");
    const antes = await estado(n);
    const r = await suspender(n);
    assert.equal(r.ok, false, `devia bloquear: ${JSON.stringify(r)}`);
    assert.equal(r.bloqueado, "DECISAO_HUMANA_PRESERVADA");
    const depois = await estado(n);
    assert.equal(depois.d.decisao, dec, "decisao nao pode mudar");
    assert.equal(depois.d.decidido_por, HUMANO, "autor deve ser preservado");
    assert.equal(depois.d.decidido_em, antes.d.decidido_em, "data deve ser preservada");
    assert.equal(depois.situacao, "ABERTO", "titulo nao pode sair da cobranca");
    assert.equal(await auditoriaBloqueios(n), 1, "tentativa bloqueada deve ser registrada");
    const mov = (await db.query(`select count(*)::int n from aluno_movimentacoes where aluno_id = $1`, [`aluno-${n}`])).rows[0].n;
    assert.equal(mov, 0, "nao grava movimentacao quando bloqueia");
  });
}

await caso("suspender: PENDENTE COM decidido_por tambem e tratada como decisao humana", async () => {
  await titulo(8);
  await decisao(8, "PENDENTE", HUMANO, "2026-09-18 10:00:00+00");
  const r = await suspender(8);
  assert.equal(r.bloqueado, "DECISAO_HUMANA_PRESERVADA");
  assert.equal((await estado(8)).d.decidido_por, HUMANO);
});

await caso("suspender: tentativas repetidas no mesmo dia geram UMA linha de auditoria por titulo", async () => {
  for (let i = 0; i < 5; i++) await suspender(3);
  assert.equal(await auditoriaBloqueios(3), 1, "dedupe por titulo/dia");
});

// ==========================================================================
// REAVALIAR: so mexe em PENDENTE sem decidido_por
// ==========================================================================
await caso("reavaliar: reverte PENDENTE criada pela rotina quando a Prime reverte a liquidacao", async () => {
  await titulo(10, "EM_CONFIRMACAO");
  await decisao(10, "PENDENTE", null, null);
  await db.query(`insert into ev_stub values ($1, '{"prime":{"liquidado_em":null,"portador":195},"evidencia_chave":"k10"}'::jsonb)`, [T(10)]);
  const r = (await db.query(`select prime_liquidacao_reavaliar_pendentes('rotina') as r`)).rows[0].r;
  assert.equal(r.revertidas_pela_prime, 1, JSON.stringify(r));
  const e = await estado(10);
  assert.equal(e.situacao, "ABERTO");
  assert.equal(e.d.decisao, "REJEITADO");
});

await caso("reavaliar: NAO reabre titulo com decisao humana (PENDENTE com decidido_por)", async () => {
  await titulo(11, "EM_CONFIRMACAO");
  await decisao(11, "PENDENTE", HUMANO, "2026-09-18 10:00:00+00");
  await db.query(`insert into ev_stub values ($1, '{"prime":{"liquidado_em":null,"portador":195},"evidencia_chave":"k11"}'::jsonb)`, [T(11)]);
  const r = (await db.query(`select prime_liquidacao_reavaliar_pendentes('rotina') as r`)).rows[0].r;
  const e = await estado(11);
  assert.equal(e.situacao, "EM_CONFIRMACAO", "situacao nao pode voltar para ABERTO");
  assert.equal(e.d.decisao, "PENDENTE");
  assert.equal(e.d.decidido_por, HUMANO);
  assert.ok(r.ignoradas_decisao_humana >= 1, "deve contar a linha deixada de fora");
});

await caso("reavaliar: NAO altera decisao humana REJEITADO", async () => {
  await titulo(12, "EM_CONFIRMACAO");
  await decisao(12, "REJEITADO", HUMANO, "2026-09-18 10:00:00+00");
  await db.query(`insert into ev_stub values ($1, '{"prime":{"liquidado_em":null,"portador":195},"evidencia_chave":"k12"}'::jsonb)`, [T(12)]);
  await db.query(`select prime_liquidacao_reavaliar_pendentes('rotina')`);
  const e = await estado(12);
  assert.equal(e.d.decisao, "REJEITADO");
  assert.equal(e.d.decidido_por, HUMANO);
  assert.equal(e.situacao, "EM_CONFIRMACAO");
});

// ==========================================================================
// RESUMO
// ==========================================================================
console.log(`\n${ok} ok, ${falhas.length} falha(s)`);
await db.close();
if (falhas.length) {
  console.log(JSON.stringify(falhas, null, 2));
  process.exit(1);
}
