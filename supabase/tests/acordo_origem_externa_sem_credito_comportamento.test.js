// ACORDO A VISTA COM OPERADOR DE ORIGEM EXTERNA -- SEM CREDITO INDIVIDUAL.
//
// Migration REAL em PGlite, sobre a bancada com os corpos de producao (previa,
// registrador, motor, recuperacao automatica, gatilho de heranca do responsavel
// conferido por md5) e as duas migrations de 18/09 que vem antes desta.
//
// NENHUM DADO REAL.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { novoBanco, um, boletoDe, comoGestao } from "./fixtures/parcela_paga_antes_20260917/bancada.js";

const AQUI = dirname(fileURLToPath(import.meta.url));
const ler = (p) => readFileSync(resolve(AQUI, "..", "..", p), "utf8");
const ANTES = [
  ler("supabase/migrations/20260918120000_vinculo_titulo_ignora_historico_inativo.sql"),
  ler("supabase/migrations/20260918140000_previa_ignora_cadastro_duplicado_mesclado.sql"),
];
const MIGRATION = ler("supabase/migrations/20260918160000_acordo_origem_externa_sem_credito.sql");
const ROLLBACK = ler("supabase/rollbacks/20260918160000_acordo_origem_externa_sem_credito.rollback.sql");

function blocoDe(texto, nome) {
  const ini = texto.search(new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${nome}\\s*\\(`, "i"));
  const resto = texto.slice(ini);
  const tag = /\bas\s+(\$[A-Za-z_]*\$)/i.exec(resto);
  const fim = resto.indexOf(tag[1], tag.index + tag[0].length);
  return resto.slice(0, resto.indexOf(";", fim + tag[1].length) + 1);
}
const HERDA_ANTIGA = blocoDe(ROLLBACK, "_acordo_herda_responsavel_do_aluno");

const DONO = "cobranca08@aelbra.com.br";
const CADASTRADO = "cobranca12@aelbra.com.br";
const ORIGEM = "OSVALDINA.ALVES";
const A = (n) => `00000000-0000-4000-8000-0000000${String(n).padStart(5, "0")}`;
const T = (n) => `00000000-0000-4000-a000-0000000${String(n).padStart(5, "0")}`;
const P = (n) => `00000000-0000-4000-9000-0000000${String(n).padStart(5, "0")}`;

async function banco({ nova = true, ligada = false } = {}) {
  const db = await novoBanco({ patch: true, encerrar: true, avista: true, etapaAvistaLigada: ligada });
  await db.exec(`alter table public.alunos add column if not exists observacao text`);
  await db.exec(`create unique index if not exists ux_titulo_vinculo_ativo on public.acordo_titulo_vinculo (titulo_id) where ativo`);
  for (const m of ANTES) await db.exec(m);
  if (nova) await db.exec(MIGRATION);
  await db.query(`insert into public.usuarios (nome, email, perfil, ativo) values ('Natali', $1, 'operador', true), ('Rafa', $2, 'operador', true)`, [DONO, CADASTRADO]);
  return db;
}

// aluno com dono na carteira (cobranca08), uma mensalidade em aberto
async function aluno(db, n) {
  const numero = String(n);
  const cpf = `8${numero}00000`.slice(0, 11).padEnd(11, "0");
  const matricula = `20250${numero}`;
  const nome = `ALUNO EXTERNO ${numero}`;
  await db.query(`insert into public.alunos (id, nome, cpf, cpf_mascarado, matricula, unidade, status_atual, saldo_total,
                    responsavel_atual_email, responsavel_atual_nome)
                  values ($1, $2, $3, '***', $4, 'PALMAS', 'AGUARDANDO_BAIXA', 515.81, $5, 'Natali')`, [A(n), nome, cpf, matricula, DONO]);
  await db.query(`insert into public.prime_contratos (cpf, registration) values ($1, $2)`, [cpf, matricula]);
  await db.query(`insert into public.acordos_titulos (id, aluno_id, documento, vencimento, valor_original, saldo_corrigido,
                    situacao, status, tipo_boleto)
                  values ($1, $2, $3, '2026-08-05', 515.81, 515.81, 'ABERTO', 'em_aberto', 'Cursos de Graduação')`, [T(n), A(n), `doc${numero}`]);
  return { id: A(n), nome, matricula, titulo: T(n) };
}

// operadorEmail null + nome = origem externa (como o arquivo traz o 71803)
async function pagar(db, n, al, { operadorEmail = null, operadorNome = ORIGEM } = {}) {
  await db.query(`insert into public.pagamentos (id, numero_parcela_completo, dados, titulo_numero, valor_pago, valor_honorario,
                    data_pagamento, operador_email, operador_nome, aluno_nome, matricula)
                  values ($1, $2, $3, $4, 581.64, 43.08, '2026-09-11', $5, $6, $7, $8)`,
    [P(n), boletoDe(n, 1), JSON.stringify({ vencimento: "2026-09-14", valor_original: 581.64 }), String(n),
      operadorEmail, operadorNome, al.nome, al.matricula]);
  return P(n);
}

const autorizar = async (db, pid, motivo = "operador da origem nao e do CRM; sem credito individual") => {
  await comoGestao(db);
  return um(db, `select public.pagamento_autorizar_origem_externa($1, $2)`, [pid, motivo]);
};
const registrar = async (db, pid, titulo) => {
  await comoGestao(db);
  return um(db, `select public.acordo_avista_registrar($1, $2::uuid[], true)`, [pid, [titulo]]);
};
const previa = (db, pid) => um(db, `select public.acordo_avista_previa($1, null)`, [pid]);

const cadeia = (db, pid, al) => um(db, `select jsonb_build_object(
    'pag', (select status_conciliacao from public.pagamentos where id = $1),
    'parcela', (select q.status from public.parcelas q where q.origem_baixa_ref = $1::text),
    'acordo', (select a.status from public.parcelas q join public.acordos a on a.id = q.acordo_id where q.origem_baixa_ref = $1::text),
    'resp_acordo', (select coalesce(a.operador_responsavel_email, '(nulo)') from public.parcelas q join public.acordos a on a.id = q.acordo_id where q.origem_baixa_ref = $1::text),
    'mens', (select situacao from public.acordos_titulos where id = $3),
    'vinc', (select count(*)::int from public.acordo_titulo_vinculo where titulo_id = $3 and ativo),
    'resp_aluno', (select responsavel_atual_email from public.alunos where id = $2))`, [pid, al.id, al.titulo]);

describe("a regra continua a mesma sem autorização", () => {
  it("A. operador cadastrado continua funcionando igual: crédito e responsável = operador do pagamento", async () => {
    const db = await banco();
    const al = await aluno(db, 71001);
    const pid = await pagar(db, 71001, al, { operadorEmail: CADASTRADO, operadorNome: "Rafa" });
    const r = await registrar(db, pid, al.titulo);
    expect(r).toMatchObject({ ok: true, gravou: true });
    expect(r.origem_externa).toBeNull();
    const c = await cadeia(db, pid, al);
    expect(c).toMatchObject({ pag: "BAIXADO", parcela: "PAGO", acordo: "QUITADO", resp_acordo: CADASTRADO, mens: "PAGO", vinc: 1 });
    expect(await um(db, `select detalhes->>'credito_individual' from public.auditoria where acao = 'RECUPERACAO_ACORDO_PAGO_SEM_IMPORTACAO'`)).toBe("OPERADOR_DO_PAGAMENTO");
    await db.close();
  });

  it("B. operador não cadastrado, sem autorização: continua bloqueado", async () => {
    const db = await banco();
    const al = await aluno(db, 71803);
    const pid = await pagar(db, 71803, al);
    const p = await previa(db, pid);
    expect(p.aprovado).toBe(false);
    expect(p.bloqueios).toEqual(["OPERADOR_CADASTRADO"]);
    const r = await registrar(db, pid, al.titulo);
    expect(r).toMatchObject({ ok: false, gravou: false });
    expect(await um(db, `select count(*)::int from public.acordos`)).toBe(0);
    await db.close();
  });
});

describe("com a autorização explícita da gestão para o pagamento", () => {
  it("C, D, E e F. registra o acordo sem crédito, sem herdar o dono do aluno, com a origem na auditoria", async () => {
    const db = await banco();
    const al = await aluno(db, 71803);
    const pid = await pagar(db, 71803, al);
    expect(await autorizar(db, pid)).toMatchObject({ ok: true, operador_origem: ORIGEM, credito_individual: "NAO_ATRIBUIDO" });

    const p = await previa(db, pid);
    expect(p.aprovado).toBe(true);
    expect(p.origem_externa).toMatchObject({ operador_origem: ORIGEM, credito_individual: "NAO_ATRIBUIDO", autorizado_por: "amanda.seibel@aelbra.com.br" });

    const r = await registrar(db, pid, al.titulo);
    expect(r).toMatchObject({ ok: true, gravou: true });
    // C: registrado, cadeia completa. D: sem credito individual. E: nao herdou o dono.
    expect(await cadeia(db, pid, al)).toEqual({ pag: "BAIXADO", parcela: "PAGO", acordo: "QUITADO", resp_acordo: "(nulo)",
      mens: "PAGO", vinc: 1, resp_aluno: DONO });
    const acordo = await um(db, `select jsonb_build_object('email', operador_responsavel_email, 'nome', operador_responsavel_nome, 'obs', observacao) from public.acordos`);
    expect(acordo.email).toBeNull();
    expect(acordo.nome).toBeNull();
    expect(acordo.obs).toContain(`ORIGEM EXTERNA: ${ORIGEM}`);
    expect(acordo.obs).toContain("CREDITO INDIVIDUAL NAO ATRIBUIDO");
    // F: a auditoria guarda a origem, o credito nao atribuido e quem autorizou
    const aud = await um(db, `select detalhes from public.auditoria where acao = 'RECUPERACAO_ACORDO_PAGO_SEM_IMPORTACAO'`);
    expect(aud.credito_individual).toBe("NAO_ATRIBUIDO");
    expect(aud.origem_externa).toMatchObject({ operador_origem: ORIGEM, autorizado_por: "amanda.seibel@aelbra.com.br" });
    expect(await um(db, `select count(*)::int from public.auditoria where acao = 'ORIGEM_EXTERNA_AUTORIZADA'`)).toBe(1);
    expect(await um(db, `select acordo_id is not null and usado_em is not null from public.pagamento_origem_externa_autorizada`)).toBe(true);
    // e ninguem foi cadastrado
    expect(await um(db, `select count(*)::int from public.usuarios where email ilike '%osvald%' or nome ilike '%osvald%'`)).toBe(0);
    await db.close();
  });

  it("E (mutação: gatilho de herança de hoje). O mesmo registro herdaria o dono -- o registrador aborta", async () => {
    const db = await banco();
    await db.exec(HERDA_ANTIGA);
    const al = await aluno(db, 71803);
    const pid = await pagar(db, 71803, al);
    await autorizar(db, pid);
    await comoGestao(db);
    await expect(db.query(`select public.acordo_avista_registrar($1, $2::uuid[], true)`, [pid, [al.titulo]]))
      .rejects.toThrow(/o estado final difere do simulado/);
    expect(await um(db, `select count(*)::int from public.acordos`)).toBe(0);
    await db.close();
  });

  it("G. outro pagamento com a mesma origem não usa a autorização do primeiro", async () => {
    const db = await banco();
    const al1 = await aluno(db, 71803);
    const pid1 = await pagar(db, 71803, al1);
    await autorizar(db, pid1);
    const al2 = await aluno(db, 71804);
    const pid2 = await pagar(db, 71804, al2);
    const p2 = await previa(db, pid2);
    expect(p2.aprovado).toBe(false);
    expect(p2.bloqueios).toContain("OPERADOR_CADASTRADO");
    expect(p2.origem_externa).toBeNull();
    await db.close();
  });

  it("G2. a autorização só vale para o nome de origem do próprio pagamento, e só a gestão autoriza", async () => {
    const db = await banco();
    const al = await aluno(db, 71803);
    const pid = await pagar(db, 71803, al);
    await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ email: "cobranca99@aelbra.com.br", role: "authenticated" })]);
    await expect(db.query(`select public.pagamento_autorizar_origem_externa($1, 'tentativa de operador')`, [pid]))
      .rejects.toThrow(/decisão da gestão financeira/);
    // operador que existe no CRM nao usa a excecao
    const al2 = await aluno(db, 71805);
    const pid2 = await pagar(db, 71805, al2, { operadorEmail: null, operadorNome: "Rafa" });
    expect(await autorizar(db, pid2)).toMatchObject({ ok: false, erro: "OPERADOR_EXISTE_NO_CRM" });
    // linha com outro nome nao abre a previa
    await db.query(`insert into public.pagamento_origem_externa_autorizada (pagamento_id, operador_origem, motivo, autorizado_por)
                    values ($1, 'OUTRO.NOME', 'teste de nome diferente', 'x')`, [pid]);
    expect((await previa(db, pid)).bloqueios).toContain("OPERADOR_CADASTRADO");
    await db.close();
  });

  it("G3. a chave de 'sem crédito' acesa por fora não impede a herança", async () => {
    const db = await banco();
    const al = await aluno(db, 71806);
    await db.exec(`select set_config('reativa.acordo_sem_credito', 'on', false)`);
    await db.query(`insert into public.acordos (aluno_id, numero_ulbra, status, valor_total, qtd_parcelas) values ($1, '99999', 'ATIVO', 10, 1)`, [al.id]);
    expect(await um(db, `select operador_responsavel_email from public.acordos where numero_ulbra = '99999'`)).toBe(DONO);
    await db.close();
  });
});

describe("recuperação automática", () => {
  it("H. sem autorização, a rodada não passa pela exceção: o motivo continua OPERADOR_CADASTRADO", async () => {
    const db = await banco({ ligada: true });
    const al = await aluno(db, 71803);
    const pid = await pagar(db, 71803, al);
    expect(await um(db, `select status_conciliacao from public.pagamentos where id = $1`, [pid])).toBe("AGUARDANDO_ACORDO");
    expect(await um(db, `select motivo from public.fila_pagamento_sem_vinculo where pagamento_id = $1`, [pid])).toMatch(/^ACORDO_AVISTA_OPERADOR_CADASTRADO: /);
    const r = await um(db, `select public.acordo_avista_recuperar_pendentes(25)`);
    expect(r).toMatchObject({ recuperados: 0 });
    expect(await um(db, `select count(*)::int from public.acordos`)).toBe(0);
    await db.close();
  });
});

describe("rollback", () => {
  it("devolve os corpos de produção e remove a autorização", async () => {
    const db = await banco();
    await db.exec(ROLLBACK);
    const md5 = await um(db, `select jsonb_object_agg(proname, md5(prosrc)) from pg_proc
      where proname in ('acordo_avista_previa', 'acordo_avista_registrar', '_acordo_herda_responsavel_do_aluno')`);
    expect(md5).toEqual({
      acordo_avista_previa: "ad10fff928bb97a4eb75e1218a20cece",
      acordo_avista_registrar: "2613270d8d177c29a66230be6dbfbb3a",
      _acordo_herda_responsavel_do_aluno: "054ac6e1e6de2da7f78676591f915cc9",
    });
    expect(await um(db, `select to_regclass('public.pagamento_origem_externa_autorizada') is null`)).toBe(true);
    await db.close();
  });
});
