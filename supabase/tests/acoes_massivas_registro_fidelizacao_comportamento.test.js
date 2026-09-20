// ACOES MASSIVAS: REGISTRO POR LOTE, SEPARACAO DA FIDELIZACAO, ROLLBACK E BACKFILL.
//
// "antes" = estado de producao de 20/09/2026; "depois" = producao + migrations
// 20260920100000/110000/120000 (PGlite, dados inventados).
//
// Prova:
//   * cada aluno confirmado tem UMA movimentacao ligada ao lote (lote -> alunos e
//     aluno -> lote); previa/exportacao/descarte nao registram nada;
//   * ANTES: acao massiva renovava a fidelizacao e criava retorno +10;
//     DEPOIS: nao renova, nao cria retorno, nao troca responsavel, nao libera,
//     e o contato do operador continua renovando como sempre;
//   * eh_tipo_acionamento e as funcoes de fidelizacao/nivelamento NAO foram tocadas;
//   * rollback devolve o estado de producao;
//   * backfill: simulacao (inequivoco / ambiguo / nao encontrado) e execucao;
//   * o lote aberto (19/09) fica intacto em todo o fluxo.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  novoBanco, alunos, mov, universo, previa, executar, exportar, concluir, fotoIntocavel, titularidade,
  MIG1, MIG2, MIG3, RB1, RB2, RB3, BACKFILL, OP_A, OP_B, comoGestao,
} from "./fixtures/acoes_massivas_universo/bancada.js";

vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 });

const AQUI = dirname(fileURLToPath(import.meta.url));
const SOMA = (o) => Object.values(o ?? {}).reduce((s, n) => s + Number(n), 0);
const elegiveisLiberacao = async (db) =>
  (await db.query(`select aluno_id from public.casos_elegiveis_liberacao_fidelizacao() order by aluno_id`)).rows.map((r) => r.aluno_id);
const alunoRow = async (db, id) =>
  (await db.query(`select responsavel_atual_email, data_ultimo_acionamento, data_retorno, status_acionamento, retorno_origem
                     from public.alunos where id = $1`, [id])).rows[0];
const casoRow = async (db, id) =>
  (await db.query(`select operador_email, data_ultimo_acionamento from public.casos where aluno_id = $1`, [id])).rows[0];

// ---------------------------------------------------------------------------
describe("registro: lote <-> movimentacao <-> aluno", () => {
  it("cada aluno confirmado tem exatamente uma movimentacao ligada ao lote; lote e registros reconciliam", async () => {
    const db = await novoBanco();
    await alunos(db, 60, { valor: 300 });
    await alunos(db, 10, { ini: 500, dono: OP_A });
    const x = await executar(db, { p_limite: 40, p_operador_email: "TODOS" });
    const lote = x.exportacao.lote_id;
    const movs = (await db.query(
      `select aluno_id, tipo, lote_id, registrado_em from public.aluno_movimentacoes where lote_id = $1 order by aluno_id`, [lote])).rows;
    expect(x.confirmacao.registrados).toBe(40);
    expect(movs.length).toBe(40);
    expect(new Set(movs.map((m) => m.aluno_id)).size).toBe(40);         // uma por aluno
    expect(movs.every((m) => m.tipo === "ACAO_MASSIVA_EXTERNA")).toBe(true);
    // lote -> alunos: o conjunto de movimentacoes = ids registrados
    expect(new Set(movs.map((m) => m.aluno_id))).toEqual(new Set(x.confirmacao.ids_registrados));
    // aluno -> lote: sai do aluno e chega ao lote
    const um = movs[0].aluno_id;
    const volta = (await db.query(`select lote_id from public.aluno_movimentacoes where aluno_id = $1`, [um])).rows;
    expect(volta.map((r) => r.lote_id)).toEqual([lote]);
    // o lote guarda o que foi pedido/achado/selecionado/confirmado, os filtros e a recencia
    const l = (await db.query(`select * from public.acoes_massivas_lotes where id = $1`, [lote])).rows[0];
    expect(l).toMatchObject({ solicitado: 40, encontrado: 70, selecionado: 40, recencia_dias: 10, total: 40 });
    expect(l.previa_id).toBe(x.previa.previa_id);
    expect(l.filtros).toMatchObject({ operador: "todos", valor_min: 0, recencia_dias: 10, canal: "WHATSAPP" });
    expect(l.filtros.aluno_ids).toBeUndefined();
    expect(l.resultado.registrados).toBe(40);
    expect(l.confirmado_em).not.toBeNull();
    // registrado_em == confirmado_em (mesma transacao): base do vinculo exato
    expect(movs.every((m) => new Date(m.registrado_em).getTime() === new Date(l.confirmado_em).getTime())).toBe(true);
  });

  it("previa, exportacao e descarte NAO registram nada; lote descartado nao confirma; nao confirma duas vezes", async () => {
    const db = await novoBanco();
    await alunos(db, 8, {});
    const p = await previa(db, { p_limite: 8, p_canal: "WHATSAPP" });
    expect((await db.query(`select count(*)::int n from public.aluno_movimentacoes`)).rows[0].n).toBe(0);
    const ex = await exportar(db, p.elegiveis.map((e) => e.id), { previa_id: p.previa_id });
    expect((await db.query(`select count(*)::int n from public.aluno_movimentacoes`)).rows[0].n).toBe(0);
    const d = await concluir(db, ex.lote_id, "DESCARTAR");
    expect(d.descartado).toBe(true);
    expect((await db.query(`select count(*)::int n from public.aluno_movimentacoes`)).rows[0].n).toBe(0);
    await expect(concluir(db, ex.lote_id)).rejects.toThrow(/foi descartado/);
    const ex2 = await exportar(db, p.elegiveis.map((e) => e.id), { previa_id: p.previa_id });
    await concluir(db, ex2.lote_id);
    await expect(concluir(db, ex2.lote_id)).rejects.toThrow(/ja foi confirmado/);
    expect((await db.query(`select count(*)::int n from public.aluno_movimentacoes`)).rows[0].n).toBe(8);
  });

  it("revalida entre previa, exportacao e confirmacao: quem deixou de estar disponivel sai, com motivo", async () => {
    const db = await novoBanco();
    const a = await alunos(db, 10, {});
    const p = await previa(db, { p_limite: 10, p_canal: "WHATSAPP" });
    // entre a previa e a exportacao: um vira retorno futuro, outro liquidado
    await db.query(`update public.alunos set data_retorno = current_date + 3 where id = $1`, [a[0]]);
    await db.query(`insert into public._liq_stub values ($1)`, [a[1]]);
    const ex = await exportar(db, p.elegiveis.map((e) => e.id), { previa_id: p.previa_id });
    expect(ex.exportados).toBe(8);
    expect(ex.excluidos_por_motivo).toEqual({ retorno_futuro: 1, liquidado_prime: 1 });
    expect(ex.excluidos_liquidados_prime).toBe(1);
    // entre a exportacao e a confirmacao: um entra em confirmacao financeira, outro recebe contato do OPERADOR
    await db.query(`insert into public.solicitacoes_confirmacao_pagamento values ($1, 'AGUARDANDO_CONFIRMACAO')`, [a[2]]);
    await mov(db, a[3], "FINALIZACAO_ATENDIMENTO", 0);
    const cf = await concluir(db, ex.lote_id);
    expect(cf.registrados).toBe(6);
    expect(cf.excluidos_confirmacao).toBe(1);
    expect(cf.excluidos_acionados_apos_exportacao).toBe(1);
    const movsMassivas = (await db.query(`select aluno_id from public.aluno_movimentacoes where lote_id = $1`, [ex.lote_id])).rows;
    expect(movsMassivas.length).toBe(6);
    expect(movsMassivas.map((m) => m.aluno_id)).not.toContain(a[2]);
    expect(movsMassivas.map((m) => m.aluno_id)).not.toContain(a[3]);
    const l = (await db.query(`select total, selecionado, resumo_exclusoes from public.acoes_massivas_lotes where id = $1`, [ex.lote_id])).rows[0];
    expect(l.total).toBe(8);
    expect(l.selecionado).toBe(8);
    expect(l.resumo_exclusoes).toEqual({ retorno_futuro: 1, liquidado_prime: 1 });
  });

  it("recencia revalidada na confirmacao: outro lote confirmado no mesmo canal no intervalo tira o aluno", async () => {
    const db = await novoBanco();
    const a = await alunos(db, 6, {});
    const p = await previa(db, { p_limite: 6, p_canal: "WHATSAPP" });
    const ex = await exportar(db, p.elegiveis.map((e) => e.id), { previa_id: p.previa_id });
    await mov(db, a[0], "ACAO_MASSIVA_EXTERNA", 0);          // outro lote confirmou o a[0] entre a exportacao e agora
    const cf = await concluir(db, ex.lote_id);
    expect(cf.registrados).toBe(5);
    expect(cf.excluidos_por_motivo).toEqual({ acao_massiva_recente: 1 });
  });

  it("confirmar em modo operador especifico revalida o dono: aluno que mudou de carteira nao entra", async () => {
    const db = await novoBanco();
    const a = await alunos(db, 5, { dono: OP_A });
    const p = await previa(db, { p_limite: 5, p_canal: "WHATSAPP", p_operador_email: OP_A });
    const ex = await exportar(db, p.elegiveis.map((e) => e.id), { previa_id: p.previa_id, operador: OP_A });
    await db.query(`update public.alunos set responsavel_atual_email = $2 where id = $1`, [a[0], OP_B]);
    const cf = await concluir(db, ex.lote_id);
    expect(cf.registrados).toBe(4);
    expect(cf.excluidos_outro_operador).toBe(1);
    expect((await alunoRow(db, a[0])).responsavel_atual_email).toBe(OP_B); // o dono NAO foi tocado
  });

  it("acionamento invalido e canal invalido: exportar recusa; ids duplicados contam uma vez", async () => {
    const db = await novoBanco();
    const [a] = await alunos(db, 1, {});
    await expect(exportar(db, [a], { canal: "SMS" })).rejects.toThrow(/Canal invalido/);
    const ex = await exportar(db, [a, a, a], { canal: "WHATSAPP" });
    expect(ex.exportados).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("O LOTE ABERTO (analogo ao de 19/09) fica intacto", () => {
  it("nenhuma migration, previa, exportacao ou confirmacao de OUTROS lotes o altera", async () => {
    const db = await novoBanco({ fase: "antes" });
    const a = await alunos(db, 10, {});
    // lote aberto legado (sem as colunas novas, tipo REGRA_ANTERIOR), antes das migrations
    await db.query(
      `insert into public.acoes_massivas_lotes (id, canal, arquivo, aluno_ids, total, exportado_por_email, exportado_em, tipo_cobranca)
       values ('11111111-1111-4111-8111-111111111111', 'WHATSAPP', 'legado.xlsx', $1::text[], 4, 'gestao@teste.local',
               '2026-09-19 12:43:00+00', 'REGRA_ANTERIOR')`, [`{${a.slice(0, 4).join(",")}}`]);
    const foto = async () => JSON.stringify((await db.query(
      `select id, canal, arquivo, aluno_ids, total, exportado_por_email, exportado_em, confirmado_em, confirmado_por_email,
              descartado_em, descartado_por_email, resultado, tipo_cobranca
         from public.acoes_massivas_lotes where id = '11111111-1111-4111-8111-111111111111'`)).rows[0]);
    const antes = await foto();
    await db.exec(MIG1); await db.exec(MIG2); await db.exec(MIG3);
    expect(await foto()).toBe(antes);
    const x = await executar(db, { p_limite: 3 });
    expect(x.confirmacao.registrados).toBe(3);
    expect(await foto()).toBe(antes);
    const aberto = (await db.query(`select confirmado_em, descartado_em, filtros from public.acoes_massivas_lotes where id = '11111111-1111-4111-8111-111111111111'`)).rows[0];
    expect(aberto).toEqual({ confirmado_em: null, descartado_em: null, filtros: null });
    // e nao entrou no backfill
    await db.exec(BACKFILL);
    expect(await foto()).toBe(antes);
    expect((await db.query(`select count(*)::int n from public.aluno_movimentacoes where lote_id = '11111111-1111-4111-8111-111111111111'`)).rows[0].n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("SEPARACAO da fidelizacao: ANTES (producao hoje) x DEPOIS (migrations)", () => {
  // Aluno de OP_A, ultimo contato do operador ha 30 dias: fidelizacao VENCIDA (elegivel para liberacao).
  async function cenario(fase) {
    const db = await novoBanco({ fase });
    const [fidel, vencida] = await alunos(db, 2, { dono: OP_A, acionadoDias: 30 });
    const [livre] = await alunos(db, 1, { ini: 100 });
    return { db, fidel, vencida, livre };
  }

  it("ANTES: a acao massiva renovava a fidelizacao (ultimo acionamento = agora), criava retorno +10 e status proprio", async () => {
    const { db, fidel, vencida } = await cenario("antes");
    expect(await elegiveisLiberacao(db)).toEqual([fidel, vencida].sort());
    const ex = (await db.query(
      `select public.acoes_massivas_exportar($1::text[], 'WHATSAPP', 'x.xlsx', $2, null) r`, [`{${fidel}}`, OP_A])).rows[0].r;
    await db.query(`select public.acoes_massivas_concluir_lote($1::uuid, 'CONFIRMAR')`, [ex.lote_id]);
    const a = await alunoRow(db, fidel);
    expect(a.status_acionamento).toMatch(/Ação massiva/);
    expect(a.retorno_origem).toBe("AUTOMATICO");
    expect(new Date(a.data_ultimo_acionamento).getTime()).toBeGreaterThan(Date.now() - 60000); // renovou
    expect(a.data_retorno).not.toBeNull();
    // e o caso saiu da lista de liberacao: fidelizacao renovada por um simples disparo
    expect(await elegiveisLiberacao(db)).toEqual([vencida]);
    expect((await db.query(`select count(*)::int n from public._recalc_log`)).rows[0].n).toBe(1);
  });

  it("DEPOIS: a acao massiva NAO renova fidelizacao, NAO cria retorno, NAO troca dono, NAO libera, NAO recalcula", async () => {
    const { db, fidel, vencida, livre } = await cenario("depois");
    const antesLib = await elegiveisLiberacao(db);
    expect(antesLib).toEqual([fidel, vencida].sort());
    const tit = await titularidade(db);
    const fotoAntes = { fidel: await alunoRow(db, fidel), livre: await alunoRow(db, livre),
                        casoFidel: await casoRow(db, fidel), casoLivre: await casoRow(db, livre) };
    const x = await executar(db, { p_limite: 100, p_operador_email: "TODOS" });
    expect(x.confirmacao.registrados).toBe(3);
    // nada operacional mudou: ultimo acionamento, retorno, status, retorno_origem, dono
    expect({ fidel: await alunoRow(db, fidel), livre: await alunoRow(db, livre),
             casoFidel: await casoRow(db, fidel), casoLivre: await casoRow(db, livre) }).toEqual(fotoAntes);
    expect(await titularidade(db)).toBe(tit);
    // a fila de liberacao/nivelamento enxerga exatamente o mesmo
    expect(await elegiveisLiberacao(db)).toEqual(antesLib);
    // a recalculadora de situacao/criticidade nao foi chamada pela acao massiva
    expect((await db.query(`select count(*)::int n from public._recalc_log`)).rows[0].n).toBe(0);
    // mas a atividade continua REGISTRADA (visivel onde ja e usada) e conta na cobertura
    expect((await db.query(`select count(*)::int n from public.aluno_movimentacoes where tipo = 'ACAO_MASSIVA_EXTERNA' and lote_id is not null`)).rows[0].n).toBe(3);
    expect((await universo(db, { operador: "todos" })).filter((u) => u.acionado_mes).length).toBe(3);
    // aluno livre so recebeu massiva: continua "nunca acionado" OPERACIONALMENTE (nada renovou nem protegeu)
    expect((await alunoRow(db, livre)).data_ultimo_acionamento).toBeNull();
  });

  it("DEPOIS: o contato do OPERADOR continua renovando a fidelizacao e chamando a recalculadora, como sempre", async () => {
    const { db, fidel, vencida } = await cenario("depois");
    await mov(db, fidel, "FINALIZACAO_ATENDIMENTO", 0);
    const a = await alunoRow(db, fidel);
    expect(new Date(a.data_ultimo_acionamento).getTime()).toBeGreaterThan(Date.now() - 60000);
    expect((await casoRow(db, fidel)).data_ultimo_acionamento).not.toBeNull();
    expect((await db.query(`select motivo from public._recalc_log where aluno_id = $1`, [fidel])).rows).toEqual([{ motivo: "acionamento" }]);
    expect(await elegiveisLiberacao(db)).toEqual([vencida]);
  });

  it("DEPOIS: cada tipo de contato operacional continua atualizando; os dois massivos nao", async () => {
    const db = await novoBanco();
    const tipos = ["FINALIZACAO_ATENDIMENTO", "FINALIZACAO", "CONTATO", "LINK_ENVIADO_AO_ALUNO", "SOLICITACAO_LINK_PAGAMENTO",
      "COMPROVANTE_ENVIADO_BAIXA", "QUITADO_MANUAL", "TERMO_ENVIADO_ADM", "RETORNO_ADM_CRIADO", "RETORNO_ADM_CONCLUIDO"];
    const a = await alunos(db, tipos.length, {});
    for (let i = 0; i < tipos.length; i++) await mov(db, a[i], tipos[i], 0);
    for (const id of a) expect((await alunoRow(db, id)).data_ultimo_acionamento, id).not.toBeNull();
    const b = await alunos(db, 2, { ini: 500 });
    await mov(db, b[0], "ACAO_MASSIVA_EXTERNA", 0);
    await mov(db, b[1], "ACAO_MASSIVA_EXTERNA_EMAIL", 0);
    for (const id of b) {
      expect((await alunoRow(db, id)).data_ultimo_acionamento).toBeNull();
      expect((await casoRow(db, id)).data_ultimo_acionamento).toBeNull();
    }
  });

  it("eh_tipo_acionamento e as funcoes de fidelizacao/nivelamento/recalculo NAO foram alteradas; a massiva segue contando como atividade", async () => {
    const todas = MIG1 + MIG2 + MIG3;
    for (const f of ["eh_tipo_acionamento", "caso_dentro_prazo_fidelizacao", "casos_elegiveis_liberacao_fidelizacao",
      "liberar_casos_fidelizacao_vencida", "liberar_fidelizacao_caso", "nivelamento_automatico_gestao",
      "calibragem_simular", "recalcular_situacao_aluno", "caso_protegido_redistribuicao"]) {
      expect(new RegExp(`function\\s+public\\.${f}\\b`, "i").test(todas), f).toBe(false);
    }
    const db = await novoBanco();
    expect((await db.query(`select public.eh_tipo_acionamento('ACAO_MASSIVA_EXTERNA') a, public.eh_tipo_acionamento('ACAO_MASSIVA_EXTERNA_EMAIL') b`)).rows[0])
      .toEqual({ a: true, b: true });
    const [x] = await alunos(db, 1, {});
    await mov(db, x, "ACAO_MASSIVA_EXTERNA", 0);
    expect((await db.query(`select count(*)::int n from public.aluno_movimentacoes where public.eh_tipo_acionamento(tipo)`)).rows[0].n).toBe(1);
  });

  it("nenhuma das tres migrations escreve em alunos, casos, retorno ou responsavel (a unica escrita e a movimentacao e o lote)", () => {
    const corpoRegistrar = MIG3.slice(MIG3.indexOf("create or replace function public.registrar_acao_massiva"),
                                       MIG3.indexOf("-- ----------------------------------------------------------------- exportar"));
    const semComentarios = corpoRegistrar.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(/update\s+public\.(alunos|casos)/i.test(semComentarios)).toBe(false);
    expect(/data_retorno|status_acionamento|responsavel_atual|data_ultimo_acionamento/i.test(semComentarios)).toBe(false);
    for (const [nome, sql] of Object.entries({ MIG1, MIG2 })) {
      const s = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
      expect(/update\s+public\.(alunos|casos)|delete\s+from/i.test(s), nome).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
describe("rollback e reaplicacao", () => {
  it("rollback devolve o estado de producao (gatilho renova de novo, registrar antigo, previa de 15 parametros) e as migrations reaplicam", async () => {
    const db = await novoBanco();
    const [a] = await alunos(db, 1, {});
    await db.exec(RB3);
    await db.exec(RB2);
    await db.exec(RB1);
    const funcs = await db.query(`select p.proname, pronargs from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname='public' and p.proname in ('acoes_massivas_universo','acoes_massivas_cobertura_por_ano','acoes_massivas_drilldown',
        'acoes_massivas_tipo_cobertura','acoes_massivas_motivo_texto','acoes_massivas_previa','registrar_acao_massiva','acoes_massivas_exportar')
      order by 1`);
    expect(funcs.rows).toEqual([
      { proname: "acoes_massivas_exportar", pronargs: 5 },
      { proname: "acoes_massivas_previa", pronargs: 15 },
      { proname: "registrar_acao_massiva", pronargs: 6 },
    ]);
    const cols = await db.query(`select column_name from information_schema.columns where table_name='aluno_movimentacoes' and column_name='lote_id'`);
    expect(cols.rows.length).toBe(0);
    // o gatilho antigo voltou: a acao massiva renova o ultimo acionamento
    await mov(db, a, "ACAO_MASSIVA_EXTERNA", 0);
    expect((await alunoRow(db, a)).data_ultimo_acionamento).not.toBeNull();
    // reaplica tudo
    await db.exec(MIG1); await db.exec(MIG2); await db.exec(MIG3);
    const [b] = await alunos(db, 1, { ini: 900 });
    await mov(db, b, "ACAO_MASSIVA_EXTERNA", 0);
    expect((await alunoRow(db, b)).data_ultimo_acionamento).toBeNull();
  });

  it("migrations sao idempotentes (rodar duas vezes nao quebra nem duplica)", async () => {
    const db = await novoBanco();
    await db.exec(MIG1); await db.exec(MIG2); await db.exec(MIG3);
    const [a] = await alunos(db, 3, {});
    expect((await previa(db, { p_limite: 5 })).resumo.elegiveis).toBe(3);
    void a;
  });
});

// ---------------------------------------------------------------------------
describe("BACKFILL de lote_id: simulacao e execucao", () => {
  // Simulacao lida do PROPRIO arquivo de backfill (bloco comentado "1) SIMULACAO").
  const simulacao = (() => {
    const ls = BACKFILL.split("\n");
    const i = ls.findIndex((l) => l.includes("1) SIMULACAO"));
    const j = ls.findIndex((l) => l.includes("2) BACKFILL"));
    return ls.slice(i + 1, j).filter((l) => l.startsWith("-- ")).map((l) => l.slice(3)).join("\n").replace(/;\s*$/, "");
  })();

  async function historico() {
    const db = await novoBanco();
    const ids = await alunos(db, 12, {});
    const T1 = "2026-09-17 13:53:00+00", T2 = "2026-09-18 17:26:00+00", T3 = "2026-09-18 20:00:00+00";
    const L1 = "aaaaaaaa-0000-4000-8000-000000000001", L2 = "aaaaaaaa-0000-4000-8000-000000000002";
    const L3 = "aaaaaaaa-0000-4000-8000-000000000003", L4 = "aaaaaaaa-0000-4000-8000-000000000004";
    const LA = "aaaaaaaa-0000-4000-8000-0000000000aa"; // aberto (nao confirmado)
    const arr = (xs) => `{${xs.join(",")}}`;
    const ins = (id, canal, xs, conf, reg) => db.query(
      `insert into public.acoes_massivas_lotes (id, canal, arquivo, aluno_ids, total, exportado_por_email, exportado_em, confirmado_em, resultado, tipo_cobranca)
       values ($1, $2, 'h.xlsx', $3::text[], $4, 'g', '2026-09-01', $5::timestamptz, $6::jsonb, 'MENSALIDADES')`,
      [id, canal, arr(xs), xs.length, conf, conf ? JSON.stringify({ registrados: reg }) : null]);
    // L1: 4 alunos, 3 registrados (o 4o foi excluido na confirmacao: sem movimentacao)
    await ins(L1, "WHATSAPP", ids.slice(0, 4), T1, 3);
    for (const id of ids.slice(0, 3)) await db.query(`insert into public.aluno_movimentacoes (aluno_id, tipo, registrado_em) values ($1,'ACAO_MASSIVA_EXTERNA',$2)`, [id, T1]);
    // L2: e-mail, 2 alunos (mesmos de L1 em outro canal/momento: sem ambiguidade)
    await ins(L2, "EMAIL", ids.slice(0, 2), T2, 2);
    for (const id of ids.slice(0, 2)) await db.query(`insert into public.aluno_movimentacoes (aluno_id, tipo, registrado_em) values ($1,'ACAO_MASSIVA_EXTERNA_EMAIL',$2)`, [id, T2]);
    // L3 e L4: MESMO canal e MESMO confirmado_em, ambos contendo ids[6] => ambiguidade
    await ins(L3, "WHATSAPP", [ids[6], ids[7]], T3, 2);
    await ins(L4, "WHATSAPP", [ids[6], ids[8]], T3, 2);
    for (const id of [ids[6], ids[7], ids[8]]) await db.query(`insert into public.aluno_movimentacoes (aluno_id, tipo, registrado_em) values ($1,'ACAO_MASSIVA_EXTERNA',$2)`, [id, T3]);
    // aberto: nao confirmado; um aluno com movimentacao massiva no horario do "aberto" e outro tipo qualquer
    await ins(LA, "WHATSAPP", [ids[9], ids[10]], null, 0);
    await db.query(`update public.acoes_massivas_lotes set exportado_em = '2026-09-19 12:43:00+00' where id = $1`, [LA]);
    // ruido: massiva antiga sem lote, e contato de operador no mesmo instante
    await db.query(`insert into public.aluno_movimentacoes (aluno_id, tipo, registrado_em) values ($1,'ACAO_MASSIVA_EXTERNA','2026-08-01'), ($2,'FINALIZACAO_ATENDIMENTO',$3)`, [ids[11], ids[0], T1]);
    return { db, ids, L1, L2, L3, L4, LA };
  }

  it("simulacao: quantos inequivocos, ambiguos e nao encontrados", async () => {
    const { db } = await historico();
    const r = (await db.query(simulacao)).rows[0];
    expect(Number(r.lotes)).toBe(4);                  // L1..L4 confirmados; o aberto fica de fora
    expect(Number(r.registrados)).toBe(3 + 2 + 2 + 2);
    // L1: 3 e L2: 2 inequivocos. L3/L4: ids[6] casa com 2 lotes (ambiguo); ids[7] e ids[8] casam com 1 lote so cada
    // mas a MOVIMENTACAO de ids[6] e uma so e casa com L3 e L4 => 1 ambigua
    expect(Number(r.inequivocos)).toBe(3 + 2 + 2);
    expect(Number(r.ambiguos)).toBe(1);
    expect(Number(r.sem_movimentacao)).toBe((4 - 3) + 0 + 0 + 0);
  });

  it("execucao: so o inequivoco recebe lote_id; ambiguo fica NULL; aberto, ruido e outros tipos nao sao tocados; idempotente", async () => {
    const { db, ids, L1, L2, L3, L4, LA } = await historico();
    const foto = async () => JSON.stringify((await db.query(`select aluno_id, tipo, registrado_em, lote_id from public.aluno_movimentacoes order by aluno_id, tipo, registrado_em`)).rows);
    await db.exec(BACKFILL);
    const m = (await db.query(`select aluno_id, tipo, lote_id from public.aluno_movimentacoes where tipo like 'ACAO_MASSIVA%' order by aluno_id, tipo`)).rows;
    const lote = (id, tipo) => m.find((x) => x.aluno_id === id && x.tipo === tipo)?.lote_id;
    for (const id of ids.slice(0, 3)) expect(lote(id, "ACAO_MASSIVA_EXTERNA")).toBe(L1);
    for (const id of ids.slice(0, 2)) expect(lote(id, "ACAO_MASSIVA_EXTERNA_EMAIL")).toBe(L2);
    expect(lote(ids[3], "ACAO_MASSIVA_EXTERNA")).toBeUndefined();          // nao registrado no lote: sem movimentacao
    expect(lote(ids[6], "ACAO_MASSIVA_EXTERNA")).toBeNull();               // AMBIGUO => NULL
    expect(lote(ids[7], "ACAO_MASSIVA_EXTERNA")).toBe(L3);
    expect(lote(ids[8], "ACAO_MASSIVA_EXTERNA")).toBe(L4);
    expect(lote(ids[11], "ACAO_MASSIVA_EXTERNA")).toBeNull();              // antiga, fora de qualquer lote
    expect((await db.query(`select count(*)::int n from public.aluno_movimentacoes where lote_id = $1`, [LA])).rows[0].n).toBe(0);
    expect((await db.query(`select count(*)::int n from public.aluno_movimentacoes where tipo = 'FINALIZACAO_ATENDIMENTO' and lote_id is not null`)).rows[0].n).toBe(0);
    const depois = await foto();
    await db.exec(BACKFILL);                                                // idempotente
    expect(await foto()).toBe(depois);
    // o aberto continua aberto
    expect((await db.query(`select confirmado_em, descartado_em from public.acoes_massivas_lotes where id = $1`, [LA])).rows[0]).toEqual({ confirmado_em: null, descartado_em: null });
  });

  it("depois do backfill, lote e movimentacoes reconciliam (registrados = vinculados), salvo ambiguos", async () => {
    const { db, L1, L2 } = await historico();
    await db.exec(BACKFILL);
    for (const [lote, esperado] of [[L1, 3], [L2, 2]]) {
      const n = (await db.query(`select count(*)::int n from public.aluno_movimentacoes where lote_id = $1`, [lote])).rows[0].n;
      expect(n).toBe(esperado);
    }
  });
});

// ---------------------------------------------------------------------------
describe("performance (PGlite): informativo, com teto generoso", () => {
  it("universo com 5.000 alunos e 10.000 movimentacoes responde bem dentro do teto", async () => {
    const db = await novoBanco();
    await alunos(db, 5000, { valor: 400 });
    await db.query(
      `insert into public.aluno_movimentacoes (aluno_id, tipo, registrado_em)
       select ('00000000-0000-4000-8000-' || lpad(((i % 5000) + 1)::text, 12, '0')), 
              (array['FINALIZACAO_ATENDIMENTO','ACAO_MASSIVA_EXTERNA','QUITADO_MANUAL','CONTATO'])[1 + (i % 4)],
              now() - ((i % 90) || ' days')::interval
         from generate_series(1, 10000) i`);
    const t0 = Date.now();
    const u = await universo(db, { canal: "WHATSAPP" });
    const ms = Date.now() - t0;
    expect(u.length).toBe(5000);
    const t1 = Date.now();
    await previa(db, { p_limite: 1000, p_canal: "WHATSAPP" });
    const ms2 = Date.now() - t1;
    console.log(`PERF PGlite (5000 alunos, 10000 mov): universo ${ms} ms; previa completa ${ms2} ms`);
    expect(ms).toBeLessThan(20000);
    expect(ms2).toBeLessThan(30000);
  });
});

void [AQUI, OP_B, comoGestao, fotoIntocavel, resolve, readFileSync, SOMA];
