// COMPORTAMENTO do encerramento de pendencia de conciliacao
// (migration 20260917210000), em PGlite, com o motor e os gatilhos de producao.
//
// Duas saidas: a automatica, para PARCELA_JA_PAGA cujo dinheiro JA esta
// refletido, e a manual da gestao, para a linha sem acao tecnica segura.
// Nenhuma das duas pode tocar parcela, acordo, pagamento ou saldo.
import { describe, it, expect } from "vitest";
import {
  novoBanco, comoGestao, um, foto, boletoDe, MIGRATION_ENCERRAR, ROLLBACK_ENCERRAR,
} from "./fixtures/parcela_paga_antes_20260917/bancada.js";

const T = 120000;
const OPERADOR = "cobranca12@aelbra.com.br";
const ALUNO = "00000000-0000-4000-8000-000000042884";
const ATUAL = "00000000-0000-4000-9000-000000042884";
const linhas = async (db, sql, p = []) => (await db.query(sql, p)).rows;
const fila = (db, id) => linhas(db, `select decisao, decidido_por, observacao, status_conciliacao from public.fila_pagamento_sem_vinculo where pagamento_id = $1`, [id]).then((r) => r[0]);
const pagamento = (db, id) => linhas(db, `select status_conciliacao, conciliacao_motivo from public.pagamentos p where p.id = $1`, [id]).then((r) => r[0]);
const previa = (db, id) => um(db, `select public.conciliacao_ja_paga_previa($1)`, [id]);
const encerrarJaPaga = (db, id, confirmar = false) => um(db, `select public.conciliacao_ja_paga_encerrar($1, $2)`, [id, confirmar]);
const pendentes = (db) => um(db, `select public.conciliacao_ja_paga_encerrar_pendentes(50)`);

// TABELAS QUE NAO PODEM MUDAR: se qualquer encerramento tocar uma delas, a
// foto muda e o teste cai.
const FINANCEIRO = ["parcelas", "acordos", "pagamentos", "acordos_titulos", "baixas_pagamento", "alunos"];
async function fotoFinanceira(db) {
  const out = {};
  for (const t of FINANCEIRO) {
    out[t] = await um(db, `select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from public.${t} x`);
  }
  return out;
}

// O caso real (42884): 4 parcelas, as tres primeiras pagas por baixa antiga sem
// referencia, dois pagamentos legados e o pagamento de hoje, do boleto 0005.
// O motor responde PARCELA_JA_PAGA.
async function cenario(db, o = {}) {
  const parcelas = o.parcelas ?? [
    { sufixo: 3, valor: 103.51, venc: "2026-07-11", status: "PAGO", pago_em: "2026-09-01" },
    { sufixo: 4, valor: 103.51, venc: "2026-08-11", status: "PAGO", pago_em: "2026-09-01" },
    { sufixo: 5, valor: 103.51, venc: "2026-09-11", status: "PAGO", pago_em: "2026-09-01" },
    { sufixo: 6, valor: 103.52, venc: "2026-10-11", status: "A_VENCER" },
  ];
  const legados = o.legados ?? [
    { sufixo: 3, valor: 107.48, data: "2026-09-01" },
    { sufixo: 4, valor: 106.35, data: "2026-09-01" },
  ];
  await db.query(`insert into public.usuarios (nome, email, perfil, ativo) values ('Operadora', $1, 'operador', true)`, [OPERADOR]);
  await db.query(`insert into public.alunos (id, nome, cpf, cpf_mascarado, matricula, unidade, status_atual, responsavel_atual_email, saldo_total)
                  values ($1, 'ALUNA DE TESTE', '70000042884', '***', '2026042884', 'CANOAS', 'ACORDO_FECHADO', $2, 0)`, [ALUNO, OPERADOR]);
  const acordoId = await um(db, `insert into public.acordos (aluno_id, cpf, valor_total, qtd_parcelas, status, saldo, observacao,
                     criado_por_email, criado_por_nome, numero_ulbra, operador_responsavel_email, criado_em)
                   values ($1, '70000042884', 414.05, 4, 'ATIVO', 414.05, 'Importado do Relatorio de Titulos em Aberto (Acordo) — lote teste',
                     'importacao@sistema', 'Importacao Acordos', '42884', $2, '2026-07-20 12:00:00+00') returning id`, [ALUNO, OPERADOR]);
  for (const p of parcelas) {
    await db.query(`insert into public.parcelas (acordo_id, numero, valor, vencimento, status, boleto, boleto_confiavel, pago_em, confirmado_por_email, observacao)
                    values ($1, $2, $3, $4, $5, $6, true, $7, $8, 'reparo 08/09/2026: baixa movida da parcela aberta mais antiga')`,
      [acordoId, p.sufixo - 2, p.valor, p.venc, p.status, p.boleto === null ? null : boletoDe("42884", p.sufixo),
        p.pago_em ?? null, p.status === "PAGO" ? "rotina@sistema" : null]);
  }
  // pagamentos legados: entraram antes da regra de conciliacao (14/09/2026)
  await db.exec(`alter table public.pagamentos disable trigger trg_pagamento_conciliar;
                 alter table public.pagamentos disable trigger pagamentos_baixar_lote;`);
  for (const g of legados) {
    await db.query(`insert into public.pagamentos (id, numero_parcela_completo, dados, titulo_numero, valor_pago, data_pagamento, operador_email, aluno_id)
                    values (gen_random_uuid(), $1, $2, '42884', $3, $4, $5, $6)`,
      [boletoDe("42884", g.sufixo), JSON.stringify({ vencimento: g.venc ?? "2026-08-11", valor_original: 103.51 }), g.valor, g.data, OPERADOR, ALUNO]);
  }
  await db.exec(`alter table public.pagamentos enable trigger trg_pagamento_conciliar;
                 alter table public.pagamentos enable trigger pagamentos_baixar_lote;`);

  await db.query(`insert into public.pagamentos (id, numero_parcela_completo, dados, titulo_numero, valor_pago, data_pagamento, operador_email, aluno_id, aluno_nome, matricula)
                  values ($1, $2, $3, '42884', $4, '2026-09-11', $5, $6, 'ALUNA DE TESTE', '2026042884')`,
    [ATUAL, boletoDe("42884", o.sufixoAtual ?? 5), JSON.stringify({ vencimento: "2026-09-11", valor_original: 103.51 }),
      o.valorAtual ?? 103.51, OPERADOR, ALUNO]);
  return acordoId;
}

describe("encerramento automático de PARCELA_JA_PAGA", () => {
  it("o cenário reproduz a fila de hoje e a prévia aprova as 8 evidências", async () => {
    const db = await novoBanco({ encerrar: true });
    await cenario(db);
    expect((await pagamento(db, ATUAL)).status_conciliacao).toBe("PARCELA_JA_PAGA");

    const antes = await foto(db);
    const r = await previa(db, ATUAL);
    expect(await foto(db)).toEqual(antes);
    expect(r).toMatchObject({ origem: "PARCELA_JA_PAGA_CONFERIDA", aprovado: true, bloqueios: [] });
    expect(r.validacoes).toHaveLength(8);
    expect(r.validacoes.every((v) => v.ok)).toBe(true);
    expect(r.evidencia).toMatchObject({ pagamentos_do_boleto: 1, parcela_paga: 1, parcelas_pagas_no_acordo: 3,
      pagamentos_no_acordo: 3, pagas_sem_boleto: 0, pagas_sem_pagamento_proprio: 0, pagamentos_sem_parcela_paga: 0 });
  }, T);

  it("confirmado, fecha SÓ a linha da fila: nada financeiro muda", async () => {
    const db = await novoBanco({ encerrar: true });
    await cenario(db);
    const financeiroAntes = await fotoFinanceira(db);

    const r = await encerrarJaPaga(db, ATUAL, true);
    expect(r).toMatchObject({ ok: true, modo: "CONFIRMADO", gravou: true });
    expect(await fotoFinanceira(db)).toEqual(financeiroAntes);

    expect(await fila(db, ATUAL)).toMatchObject({ decisao: "RESOLVIDO_AUTOMATICO", decidido_por: "conciliacao@sistema" });
    expect((await fila(db, ATUAL)).observacao).toMatch(/parcela ja paga conferida/);
    // o estado do pagamento nao e reescrito: continua dizendo o que o motor viu
    expect((await pagamento(db, ATUAL)).status_conciliacao).toBe("PARCELA_JA_PAGA");

    const aud = await linhas(db, `select usuario, acao, tabela_afetada, registro_id, detalhes from public.auditoria`);
    expect(aud).toHaveLength(1);
    expect(aud[0]).toMatchObject({ usuario: "conciliacao@sistema", acao: "CONCILIACAO_JA_PAGA_CONFERIDA",
      tabela_afetada: "fila_pagamento_sem_vinculo", registro_id: ATUAL });
    expect(aud[0].detalhes).toMatchObject({ sem_efeito_financeiro: true, antes: { aprovado: true } });
  }, T);

  it("simular não grava; encerrar duas vezes não grava de novo", async () => {
    const db = await novoBanco({ encerrar: true });
    await cenario(db);
    const antes = await foto(db);
    expect(await encerrarJaPaga(db, ATUAL, false)).toMatchObject({ modo: "SIMULACAO", gravou: false, aprovado: true });
    expect(await foto(db)).toEqual(antes);

    await encerrarJaPaga(db, ATUAL, true);
    const depois = await foto(db);
    const r2 = await encerrarJaPaga(db, ATUAL, true);
    expect(r2).toMatchObject({ modo: "RECUSADO", gravou: false });
    expect(r2.bloqueios).toContain("PENDENCIA_ABERTA_JA_PAGA");
    expect(await foto(db)).toEqual(depois);
    expect(await pendentes(db)).toMatchObject({ avaliados: 0, encerradas: 0 });
  }, T);

  it("encerrada, some da fila ativa e não volta pelo reprocessamento", async () => {
    const db = await novoBanco({ encerrar: true });
    await cenario(db);
    await db.query(`update public.pagamentos set aluno_id = null where id = $1`, [ATUAL]);
    await comoGestao(db);
    expect(await um(db, `select count(*)::int from public.pagamentos_sem_aluno(null, true)`)).toBe(1);

    await encerrarJaPaga(db, ATUAL, true);
    // mesmo sem aluno vinculado, a linha decidida sai da fila ativa
    expect(await um(db, `select count(*)::int from public.pagamentos_sem_aluno(null, true)`)).toBe(0);

    const depois = await foto(db);
    expect(await um(db, `select public.conciliacao_reprocessar(true, 5000)`)).toMatchObject({ avaliados: 0 });
    expect(await foto(db)).toEqual(depois);
  }, T);
});

// Cada evidencia que falha deixa a pendencia aberta, sem escrita nenhuma.
const RECUSAS = [
  ["UNICO_PAGAMENTO_DO_BOLETO", "segundo pagamento com o mesmo boleto", async (db) => {
    await db.exec(`alter table public.pagamentos disable trigger trg_pagamento_conciliar;
                   alter table public.pagamentos disable trigger pagamentos_baixar_lote;`);
    await db.query(`insert into public.pagamentos (id, numero_parcela_completo, dados, titulo_numero, valor_pago, data_pagamento, operador_email)
                    values (gen_random_uuid(), $1, '{}'::jsonb, '42884', 103.51, '2026-09-12', $2)`, [boletoDe("42884", 5), OPERADOR]);
    await db.exec(`alter table public.pagamentos enable trigger trg_pagamento_conciliar;
                   alter table public.pagamentos enable trigger pagamentos_baixar_lote;`);
  }],
  ["PARCELA_DO_BOLETO_PAGA", "a parcela do boleto não está mais PAGO", (db) =>
    db.query(`update public.parcelas set status = 'A_VENCER', pago_em = null where boleto = $1`, [boletoDe("42884", 5)])],
  ["VALOR_REFLETIDO_NA_PARCELA", "pago muito acima do valor da parcela", null, { valorAtual: 130 }],
  ["ACORDO_FECHA_PAGAMENTO_A_PAGAMENTO", "parcela paga sem pagamento (baixa a mais)", (db) =>
    db.query(`update public.parcelas set status = 'PAGO', pago_em = '2026-09-01' where boleto = $1`, [boletoDe("42884", 6)])],
  ["ACORDO_FECHA_PAGAMENTO_A_PAGAMENTO", "pagamento sem parcela paga (dinheiro sem destino)", (db) =>
    db.query(`update public.parcelas set status = 'VENCIDA', pago_em = null where boleto = $1`, [boletoDe("42884", 4)])],
  ["ACORDO_FECHA_PAGAMENTO_A_PAGAMENTO", "parcela paga sem boleto", async (db) => {
    const acordo = await um(db, `select id from public.acordos where numero_ulbra = '42884'`);
    await db.query(`insert into public.parcelas (acordo_id, numero, valor, vencimento, status, boleto, pago_em)
                    values ($1, 9, 103.51, '2026-06-11', 'PAGO', null, '2026-06-11')`, [acordo]);
  }],
  ["ACORDO_FECHA_PAGAMENTO_A_PAGAMENTO", "uma paga a mais e um pagamento sem destino: as contagens se anulam", async (db) => {
    await db.query(`update public.parcelas set status = 'VENCIDA', pago_em = null where boleto = $1`, [boletoDe("42884", 4)]);
    await db.query(`update public.parcelas set status = 'PAGO', pago_em = '2026-09-01' where boleto = $1`, [boletoDe("42884", 6)]);
  }],
  ["REFERENCIA_ANTIGA_DESLOCADA", "a baixa já é deste pagamento", (db) =>
    db.query(`update public.parcelas set origem_baixa_ref = $1 where boleto = $2`, [ATUAL, boletoDe("42884", 5)])],
  ["SEM_BAIXA_DEVOLVIDA", "baixa devolvida na parcela", (db) =>
    db.query(`insert into public.baixas_pagamento (parcela_id, baixado_por_email, baixado_em, devolvido_em)
              select id, 'gestao', now(), now() from public.parcelas where boleto = $1`, [boletoDe("42884", 5)])],
  ["PENDENCIA_ABERTA_JA_PAGA", "a fila já tem decisão", (db) =>
    db.query(`update public.fila_pagamento_sem_vinculo set decisao = 'ENCERRADO_GESTAO', decidido_por = 'gestao' where pagamento_id = $1`, [ATUAL])],
  ["PENDENCIA_ABERTA_JA_PAGA", "pagamento estornado", (db) =>
    db.query(`update public.pagamentos set dados = dados || '{"estornado_em": "2026-09-17"}'::jsonb where id = $1`, [ATUAL])],
];

describe("evidência que falha: a pendência fica aberta", () => {
  it.each(RECUSAS)("%s — %s", async (codigo, _nome, preparar, opcoes) => {
    const db = await novoBanco({ encerrar: true });
    await cenario(db, opcoes ?? {});
    if (preparar) await preparar(db);

    const antes = await foto(db);
    const r = await encerrarJaPaga(db, ATUAL, true);
    expect(r).toMatchObject({ ok: false, modo: "RECUSADO", gravou: false });
    expect(r.bloqueios).toContain(codigo);
    expect(await foto(db)).toEqual(antes);
    expect(await pendentes(db)).toMatchObject({ encerradas: 0 });
    expect(await foto(db)).toEqual(antes);
  }, T);
});

describe("lote e rodada horária", () => {
  it("o lote encerra o que a prova aprova e conta o que recusa", async () => {
    const db = await novoBanco({ encerrar: true });
    await cenario(db);
    // um segundo caso, este com baixa a mais: nao pode ser encerrado
    await db.query(`update public.parcelas set status = 'PAGO', pago_em = '2026-09-01' where boleto = $1`, [boletoDe("42884", 6)]);
    const r = await pendentes(db);
    expect(r).toMatchObject({ avaliados: 1, encerradas: 0, erros: 0 });
    expect(r.recusados_por_motivo).toMatchObject({ ACORDO_FECHA_PAGAMENTO_A_PAGAMENTO: 1 });

    await db.query(`update public.parcelas set status = 'A_VENCER', pago_em = null where boleto = $1`, [boletoDe("42884", 6)]);
    expect(await pendentes(db)).toMatchObject({ avaliados: 1, encerradas: 1, erros: 0 });
  }, T);

  it("etapa desligada não encerra; ligada, encerra na rodada", async () => {
    const db = await novoBanco({ encerrar: true });
    await cenario(db);
    const r1 = await um(db, `select public.fluxo_pagamentos_rodar('cron')`);
    expect(r1.etapas).not.toHaveProperty("encerrar_ja_paga_conferida");
    expect((await fila(db, ATUAL)).decisao).toBeNull();

    await db.query(`update public.fluxo_pagamentos_config set ligado = true where etapa = 'encerrar_ja_paga_conferida'`);
    const financeiroAntes = await fotoFinanceira(db);
    const r2 = await um(db, `select public.fluxo_pagamentos_rodar('cron')`);
    expect(r2.etapas.encerrar_ja_paga_conferida).toMatchObject({ avaliados: 1, encerradas: 1 });
    expect(r2.erro).toBeNull();
    expect((await fila(db, ATUAL)).decisao).toBe("RESOLVIDO_AUTOMATICO");
    expect(await fotoFinanceira(db)).toEqual(financeiroAntes);
  }, T);
});

describe("encerrar pendência pela gestão", () => {
  async function pendenciaAguardandoAcordo(db) {
    await db.query(`insert into public.usuarios (nome, email, perfil, ativo) values ('Operadora', $1, 'operador', true)`, [OPERADOR]);
    const pid = "00000000-0000-4000-9000-000000099999";
    await db.query(`insert into public.pagamentos (id, numero_parcela_completo, dados, titulo_numero, valor_pago, data_pagamento, operador_email, aluno_nome, matricula)
                    values ($1, '50999990001', $2, '99999', 500, '2026-09-16', $3, 'ALGUEM', '2026000001')`,
      [pid, JSON.stringify({ vencimento: "2026-09-18", valor_original: 500 }), OPERADOR]);
    expect((await pagamento(db, pid)).status_conciliacao).toBe("AGUARDANDO_ACORDO");
    return pid;
  }

  it("encerra qualquer pendência aberta, registra quem, quando e o estado anterior, e não toca em dinheiro", async () => {
    const db = await novoBanco({ encerrar: true });
    const pid = await pendenciaAguardandoAcordo(db);
    await comoGestao(db);
    const financeiroAntes = await fotoFinanceira(db);

    const r = await um(db, `select public.conciliacao_encerrar($1, $2)`, [pid, "cliente enviou comprovante de outro acordo"]);
    expect(r).toMatchObject({ ok: true, fila_fechada: 1, decisao: "ENCERRADO_GESTAO", status_conciliacao: "AGUARDANDO_ACORDO" });
    expect(r.estado_anterior).toMatchObject({ status_conciliacao: "AGUARDANDO_ACORDO" });
    expect(r.estado_anterior.fila.decisao).toBeNull();
    expect(await fotoFinanceira(db)).toEqual(financeiroAntes);

    const f = await fila(db, pid);
    expect(f).toMatchObject({ decisao: "ENCERRADO_GESTAO", decidido_por: "amanda.seibel@aelbra.com.br" });
    expect(f.observacao).toMatch(/encerrado pela gestao: cliente enviou comprovante/);
    expect(await um(db, `select decidido_em is not null from public.fila_pagamento_sem_vinculo where pagamento_id = $1`, [pid])).toBe(true);

    const aud = await linhas(db, `select usuario, acao, registro_id, detalhes from public.auditoria`);
    expect(aud).toHaveLength(1);
    expect(aud[0]).toMatchObject({ usuario: "amanda.seibel@aelbra.com.br", acao: "CONCILIACAO_ENCERRADA_PELA_GESTAO", registro_id: pid });
    expect(aud[0].detalhes).toMatchObject({ sem_efeito_financeiro: true, decisao: "ENCERRADO_GESTAO",
      observacao: "cliente enviou comprovante de outro acordo", estado_anterior: { status_conciliacao: "AGUARDANDO_ACORDO" } });
  }, T);

  it("observação é opcional, e a linha some da fila ativa e do reprocessamento", async () => {
    const db = await novoBanco({ encerrar: true });
    const pid = await pendenciaAguardandoAcordo(db);
    await comoGestao(db);
    expect(await um(db, `select count(*)::int from public.pagamentos_sem_aluno(null, true)`)).toBe(1);

    expect(await um(db, `select public.conciliacao_encerrar($1)`, [pid])).toMatchObject({ ok: true, fila_fechada: 1 });
    expect((await fila(db, pid)).observacao).toBe("encerrado pela gestao");
    expect(await um(db, `select count(*)::int from public.pagamentos_sem_aluno(null, true)`)).toBe(0);

    const depois = await foto(db);
    expect(await um(db, `select public.conciliacao_reprocessar(true, 5000)`)).toMatchObject({ avaliados: 0 });
    expect(await foto(db)).toEqual(depois);
  }, T);

  it("recusa o que não é pendência: baixado, sem estado e linha já decidida", async () => {
    const db = await novoBanco({ encerrar: true });
    const pid = await pendenciaAguardandoAcordo(db);
    await comoGestao(db);
    await um(db, `select public.conciliacao_encerrar($1)`, [pid]);
    expect(await um(db, `select public.conciliacao_encerrar($1)`, [pid])).toMatchObject({ ok: false, motivo: "SEM_PENDENCIA_ABERTA" });

    await db.query(`update public.pagamentos set status_conciliacao = 'BAIXADO' where id = $1`, [pid]);
    expect(await um(db, `select public.conciliacao_encerrar($1)`, [pid])).toMatchObject({ ok: false, motivo: "JA_BAIXADO" });

    await db.query(`update public.pagamentos set status_conciliacao = null where id = $1`, [pid]);
    expect(await um(db, `select public.conciliacao_encerrar($1)`, [pid])).toMatchObject({ ok: false, motivo: "SEM_CONCILIACAO" });
  }, T);

  it("quem não é da gestão não encerra", async () => {
    const db = await novoBanco({ encerrar: true });
    const pid = await pendenciaAguardandoAcordo(db);
    await comoGestao(db, OPERADOR);
    await expect(um(db, `select public.conciliacao_encerrar($1)`, [pid])).rejects.toThrow(/gestao/i);
    expect((await fila(db, pid)).decisao).toBeNull();
  }, T);

  it("PARCELA_JA_PAGA que a prova recusa também pode ser encerrada pela gestão, e isso não conserta a parcela", async () => {
    const db = await novoBanco({ encerrar: true });
    await cenario(db);
    // baixa a mais: a prova automatica recusa
    await db.query(`update public.parcelas set status = 'PAGO', pago_em = '2026-09-01' where boleto = $1`, [boletoDe("42884", 6)]);
    expect(await encerrarJaPaga(db, ATUAL, true)).toMatchObject({ gravou: false });

    await comoGestao(db);
    const financeiroAntes = await fotoFinanceira(db);
    expect(await um(db, `select public.conciliacao_encerrar($1, $2)`, [ATUAL, "conferido com a Prime"])).toMatchObject({ ok: true, decisao: "ENCERRADO_GESTAO" });
    expect(await fotoFinanceira(db)).toEqual(financeiroAntes);
    // a parcela indevidamente paga continua exatamente como estava
    expect(await um(db, `select status from public.parcelas where boleto = $1`, [boletoDe("42884", 6)])).toBe("PAGO");
  }, T);
});

describe("instalação e rollback", () => {
  const corpos = async (db) => Object.fromEntries((await linhas(db,
    `select p.proname, md5(p.prosrc) as h from pg_proc p where p.pronamespace = 'public'::regnamespace
      and p.proname = any($1)`, [["fluxo_pagamentos_rodar", "conciliacao_encerrar", "pagamentos_sem_aluno",
      "pagamento_conciliar_um", "parcela_paga_antes_reconstruir", "conciliacao_ja_paga_previa",
      "conciliacao_ja_paga_encerrar", "conciliacao_ja_paga_encerrar_pendentes"]])).map((r) => [r.proname, r.h]));
  const PRODUCAO = {
    fluxo_pagamentos_rodar: "418c15291cf912516d7f02304b4fdd2d",
    conciliacao_encerrar: "e41a43f4bfe1754c45570f3afd5e2ade",
    pagamentos_sem_aluno: "067e2b74c3f8ef3d52b60e42b8d5b93d",
    pagamento_conciliar_um: "fa3d64add73e0e73e587e16f0c0624d1",
    parcela_paga_antes_reconstruir: "0bd85569a834454244abb5ea97f068a2",
  };

  it("sem o patch, os três corpos são os de produção; com ele, motor e reconstrução não mudam", async () => {
    expect(await corpos(await novoBanco())).toEqual(PRODUCAO);
    const comPatch = await corpos(await novoBanco({ encerrar: true }));
    expect(comPatch.pagamento_conciliar_um).toBe(PRODUCAO.pagamento_conciliar_um);
    expect(comPatch.parcela_paga_antes_reconstruir).toBe(PRODUCAO.parcela_paga_antes_reconstruir);
    expect(Object.keys(comPatch)).toHaveLength(8);
  }, T);

  it("as funções do encerramento automático não são chamáveis de fora; a da gestão continua sendo", async () => {
    const db = await novoBanco({ encerrar: true });
    for (const f of ["conciliacao_ja_paga_previa(uuid)", "conciliacao_ja_paga_encerrar(uuid,boolean)", "conciliacao_ja_paga_encerrar_pendentes(integer)"]) {
      for (const papel of ["anon", "authenticated"]) {
        expect(await um(db, `select has_function_privilege($1, $2, 'EXECUTE')`, [papel, `public.${f}`])).toBe(false);
      }
    }
    expect(await um(db, `select has_function_privilege('authenticated', 'public.conciliacao_encerrar(uuid,text)', 'EXECUTE')`)).toBe(true);
    expect(await um(db, `select has_function_privilege('anon', 'public.conciliacao_encerrar(uuid,text)', 'EXECUTE')`)).toBe(false);
    await db.exec(MIGRATION_ENCERRAR);
    expect(await um(db, `select ligado from public.fluxo_pagamentos_config where etapa = 'encerrar_ja_paga_conferida'`)).toBe(false);
  }, T);

  it("rollback devolve os três corpos de produção e remove as funções novas", async () => {
    const db = await novoBanco({ encerrar: true });
    await db.exec(ROLLBACK_ENCERRAR);
    expect(await corpos(db)).toEqual(PRODUCAO);
  }, T);
});
