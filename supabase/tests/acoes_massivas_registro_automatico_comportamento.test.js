// ACOES MASSIVAS: REGISTRO AUTOMATICO, IDEMPOTENTE, CONTANDO COMO ACIONAMENTO.
//
// Bancada PGlite (Postgres real, dados inventados). "antes" = producao de
// 02/10/2026 (migrations ate 20260920125611); "depois" = + a migration nova
// 20261002150000, ainda em aguardando_aprovacao.
//
// Prova os 7 criterios pedidos pela gestao em 02/10:
//   1. 300 selecionados e 300 elegiveis -> 300 movimentacoes, sem clique extra;
//   2. 300 selecionados e 5 excluidos na revalidacao -> 295;
//   3. concluir duas vezes -> continua 295, sem duplicar;
//   4. acao massiva mais nova avanca data_ultimo_acionamento;
//   5. acao massiva mais antiga NAO sobrescreve acionamento mais recente;
//   6. aluno cujo unico acionamento valido e massivo deixa de ser "nunca acionado";
//   7. a fidelizacao de 10 dias passa a considerar essa data.
// E as travas: nao cria retorno, nao troca responsavel, nao toca financeiro,
// nao mexe em lote pendente antigo nem em movimentacao ja existente.
import { describe, it, expect, vi } from "vitest";
import {
  novoBanco, alunos, mov, previa, exportar, concluir, fotoIntocavel, titularidade,
  OP_A, OP_B,
} from "./fixtures/acoes_massivas_universo/bancada.js";

vi.setConfig({ testTimeout: 180000, hookTimeout: 180000 });

const banco = () => novoBanco({ registroAutomatico: true });

const movsDoLote = async (db, lote) =>
  (await db.query(
    `select aluno_id, tipo, registrado_em from public.aluno_movimentacoes
      where lote_id = $1 order by aluno_id`, [lote])).rows;

const loteRow = async (db, lote) =>
  (await db.query(`select total, registrados, registro_automatico, confirmado_em, descartado_em
                     from public.acoes_massivas_lotes where id = $1`, [lote])).rows[0];

const alunoRow = async (db, id) =>
  (await db.query(`select data_ultimo_acionamento, data_retorno, status_acionamento,
                          responsavel_atual_email, retorno_origem
                     from public.alunos where id = $1`, [id])).rows[0];

const casoRow = async (db, id) =>
  (await db.query(`select operador_email, data_ultimo_acionamento from public.casos where aluno_id = $1`, [id])).rows[0];

/** Exporta todos os ids elegiveis da previa. Na regra nova isto JA registra. */
async function exportarTudo(db, { limite = 1000, operador = "TODOS" } = {}) {
  const p = await previa(db, { p_canal: "WHATSAPP", p_limite: limite, p_operador_email: operador });
  const ids = p.elegiveis.map((e) => e.id);
  const ex = await exportar(db, ids, { canal: "WHATSAPP", operador, previa_id: p.previa_id });
  return { previa: p, exportacao: ex, ids };
}

// ---------------------------------------------------------------- criterio 1
describe("1. lote com 300 selecionados e 300 elegiveis", () => {
  it("exportar registra as 300 movimentacoes sozinho, sem ninguem clicar em confirmar", async () => {
    const db = await banco();
    await alunos(db, 300, { valor: 300 });

    const { exportacao: ex } = await exportarTudo(db, { limite: 300 });

    expect(ex.selecionados).toBe(300);
    expect(ex.registrados).toBe(300);
    expect(ex.registro_automatico).toBe(true);
    expect((await movsDoLote(db, ex.lote_id)).length).toBe(300);

    const l = await loteRow(db, ex.lote_id);
    expect(l.total).toBe(300);              // selecionado/exportado
    expect(l.registrados).toBe(300);        // gravado no CRM
    expect(l.registro_automatico).toBe(true);
    expect(l.confirmado_em).not.toBeNull(); // nasce ja registrado: nao fica pendente
  });

  it("'enviados' e 'falhas de envio' voltam nulos: nao existe retorno da mensageria", async () => {
    const db = await banco();
    await alunos(db, 10, { valor: 300 });
    const { exportacao: ex } = await exportarTudo(db, { limite: 10 });
    expect(ex.enviados).toBeNull();
    expect(ex.falhas_envio).toBeNull();
    // e o lote nunca chama o selecionado de enviado
    expect(Object.keys(ex)).not.toContain("enviados_confirmados");
  });
});

// ---------------------------------------------------------------- criterio 2
describe("2. lote com exclusoes na revalidacao", () => {
  it("300 selecionados com 5 que sairam do universo -> 295 movimentacoes, com motivo", async () => {
    const db = await banco();
    const ids = await alunos(db, 300, { valor: 300 });

    // previa ve os 300; 5 saem do universo ANTES da exportacao revalidar
    const p = await previa(db, { p_canal: "WHATSAPP", p_limite: 300, p_operador_email: "TODOS" });
    expect(p.elegiveis.length).toBe(300);
    const fora = ids.slice(0, 5);
    await db.query(`insert into public._liq_stub select unnest($1::uuid[])`, [fora]);

    const ex = await exportar(db, p.elegiveis.map((e) => e.id),
      { canal: "WHATSAPP", operador: "TODOS", previa_id: p.previa_id });

    expect(ex.selecionados).toBe(295);
    expect(ex.registrados).toBe(295);
    expect(ex.excluidos_liquidados_prime).toBe(5);
    expect((await movsDoLote(db, ex.lote_id)).length).toBe(295);
    // os 5 excluidos nao tem movimentacao nenhuma
    const n = (await db.query(
      `select count(*)::int c from public.aluno_movimentacoes where aluno_id = any($1::text[])`,
      [fora.map(String)])).rows[0].c;
    expect(n).toBe(0);
  });
});

// ---------------------------------------------------------------- criterio 3
describe("3. idempotencia", () => {
  it("concluir o mesmo lote de novo continua 295 e nao cria movimentacao nova", async () => {
    const db = await banco();
    const ids = await alunos(db, 300, { valor: 300 });
    const p = await previa(db, { p_canal: "WHATSAPP", p_limite: 300, p_operador_email: "TODOS" });
    await db.query(`insert into public._liq_stub select unnest($1::uuid[])`, [ids.slice(0, 5)]);
    const ex = await exportar(db, p.elegiveis.map((e) => e.id),
      { canal: "WHATSAPP", operador: "TODOS", previa_id: p.previa_id });
    expect(ex.registrados).toBe(295);

    const antes = await movsDoLote(db, ex.lote_id);
    const r2 = await concluir(db, ex.lote_id, "CONFIRMAR");
    const r3 = await concluir(db, ex.lote_id, "CONFIRMAR");
    const depois = await movsDoLote(db, ex.lote_id);

    expect(r2.ja_registrado).toBe(true);
    expect(r2.registrados).toBe(295);
    expect(r2.movimentacoes_criadas).toBe(0);
    expect(r3.movimentacoes_criadas).toBe(0);
    expect(depois.length).toBe(295);
    expect(depois).toEqual(antes);          // nada mudou, nem timestamp
  });

  it("chamar registrar direto no mesmo lote nao cria nada: a recencia ja barra antes", async () => {
    const db = await banco();
    await alunos(db, 20, { valor: 300 });
    const { exportacao: ex } = await exportarTudo(db, { limite: 20 });
    const r = (await db.query(
      `select public.registrar_acao_massiva($1::text[], 'WHATSAPP', 'x.xlsx', null, null, 'livres', $2::uuid, null) r`,
      [`{${ex.ids_exportados.join(",")}}`, ex.lote_id])).rows[0].r;
    // primeira barreira: o universo ja considera estes alunos "acao massiva recente"
    expect(r.registrados).toBe(0);
    expect(r.excluidos_por_motivo.acao_massiva_recente).toBe(20);
    expect((await movsDoLote(db, ex.lote_id)).length).toBe(20);
  });

  it("segunda barreira: o indice unico recusa a duplicata no nivel do banco", async () => {
    const db = await banco();
    await alunos(db, 5, { valor: 300 });
    const { exportacao: ex } = await exportarTudo(db, { limite: 5 });
    const um = ex.ids_exportados[0];
    await expect(db.query(
      `insert into public.aluno_movimentacoes (aluno_id, tipo, descricao, registrado_por_nome, registrado_por_email, registrado_em, lote_id)
       values ($1, 'ACAO_MASSIVA_EXTERNA', 'duplicata', 'x', 'x', now(), $2::uuid)`, [um, ex.lote_id]))
      .rejects.toThrow(/ux_aluno_mov_lote_aluno|duplicate key/i);
    expect((await movsDoLote(db, ex.lote_id)).length).toBe(5);
  });
});

// --------------------------------------------------------------- criterios 4/5
describe("4 e 5. ultimo acionamento so avanca", () => {
  it("acao massiva mais nova vira o ultimo acionamento do aluno e do caso", async () => {
    const db = await banco();
    const [id] = await alunos(db, 1, { valor: 300, acionadoDias: 30 });
    const antes = (await alunoRow(db, id)).data_ultimo_acionamento;

    const { exportacao: ex } = await exportarTudo(db, { limite: 1 });
    expect(ex.registrados).toBe(1);

    const a = await alunoRow(db, id);
    const c = await casoRow(db, id);
    expect(new Date(a.data_ultimo_acionamento).getTime()).toBeGreaterThan(new Date(antes).getTime());
    expect(c.data_ultimo_acionamento).not.toBeNull();
  });

  it("acao massiva mais antiga NAO sobrescreve contato operacional mais recente", async () => {
    const db = await banco();
    const [id] = await alunos(db, 1, { valor: 300, acionadoDias: 30 });
    const { exportacao: ex } = await exportarTudo(db, { limite: 1 });
    expect(ex.registrados).toBe(1);
    const depoisDaMassiva = (await alunoRow(db, id)).data_ultimo_acionamento;

    // contato real do operador, agora
    await mov(db, id, "FINALIZACAO_ATENDIMENTO", 0);
    const depoisDoContato = (await alunoRow(db, id)).data_ultimo_acionamento;
    expect(new Date(depoisDoContato).getTime()).toBeGreaterThanOrEqual(new Date(depoisDaMassiva).getTime());

    // uma massiva ANTIGA chegando depois nao pode puxar a data para tras
    await db.query(
      `insert into public.aluno_movimentacoes (aluno_id, tipo, descricao, registrado_por_nome, registrado_por_email, registrado_em)
       values ($1, 'ACAO_MASSIVA_EXTERNA', 'antiga', 'x', 'x', now() - interval '20 days')`, [String(id)]);
    expect((await alunoRow(db, id)).data_ultimo_acionamento).toEqual(depoisDoContato);
  });
});

// ---------------------------------------------------------------- criterio 6
describe("6. Saude da Carteira: nunca acionado", () => {
  it("aluno cujo unico acionamento valido e massivo deixa de ser 'nunca acionado'", async () => {
    const semRegra = await novoBanco();                       // producao hoje
    const comRegra = await banco();                           // com a migration
    for (const db of [semRegra, comRegra]) await alunos(db, 1, { valor: 300 });

    const nuncaAcionado = async (db) =>
      (await db.query(`select c.data_ultimo_acionamento is null n from public.casos c`)).rows[0].n;

    for (const db of [semRegra, comRegra]) {
      expect(await nuncaAcionado(db)).toBe(true);             // parte dos dois nulos
      await exportarTudo(db, { limite: 1 });
    }
    expect(await nuncaAcionado(semRegra)).toBe(true);          // ANTES: segue "nunca acionado"
    expect(await nuncaAcionado(comRegra)).toBe(false);         // DEPOIS: deixa de ser
  });
});

// ---------------------------------------------------------------- criterio 7
describe("7. fidelizacao de 10 dias", () => {
  it("passa a considerar a acao massiva: o caso sai da fila de liberacao", async () => {
    const db = await banco();
    const [id] = await alunos(db, 1, { valor: 300, dono: OP_A, acionadoDias: 40 });
    // responsavel_atual_em antigo, para o caso ser elegivel a liberacao
    await db.query(`update public.alunos set responsavel_atual_em = now() - interval '5 days' where id = $1`, [id]);

    const elegiveis = async () =>
      (await db.query(`select aluno_id from public.casos_elegiveis_liberacao_fidelizacao()`)).rows.map((r) => r.aluno_id);
    expect(await elegiveis()).toEqual([id]);                   // fidelizacao vencida

    await exportarTudo(db, { limite: 1, operador: OP_A });

    expect(await elegiveis()).toEqual([]);                     // fidelizado de novo, por 10 dias
    const c = await casoRow(db, id);
    expect((await db.query(`select public.caso_dentro_prazo_fidelizacao($1::date) d`,
      [c.data_ultimo_acionamento])).rows[0].d).toBe(true);
  });
});

// ------------------------------------------------------------------- travas
describe("travas: o que a acao massiva continua NAO podendo fazer", () => {
  it("nao cria retorno, nao grava status_acionamento, nao troca responsavel, nao toca financeiro", async () => {
    const db = await banco();
    const ids = await alunos(db, 50, { valor: 300 });
    await alunos(db, 10, { ini: 500, dono: OP_B });
    const dono = await titularidade(db);

    const { exportacao: ex } = await exportarTudo(db, { limite: 50 });
    expect(ex.registrados).toBeGreaterThan(0);

    const a = await alunoRow(db, ids[0]);
    expect(a.data_retorno).toBeNull();
    expect(a.status_acionamento).toBeNull();
    expect(a.retorno_origem).toBeNull();
    expect(a.responsavel_atual_email).toBeNull();
    expect(await titularidade(db)).toEqual(dono);

    const fin = (await db.query(
      `select (select count(*) from public.acordos) a, (select count(*) from public.parcelas) p,
              (select count(*) from public.acordos_titulos) t`)).rows[0];
    expect(fin).toEqual({ a: 0, p: 0, t: 60 });                // titulos semeados, nada criado/alterado
  });

  it("lote pendente antigo e movimentacao existente ficam intocados pela migration", async () => {
    // lote aberto no estado ANTIGO (exportar nao registrava), depois a regra nova entra
    const db = await novoBanco();
    const ids = await alunos(db, 20, { valor: 300 });
    const p = await previa(db, { p_canal: "WHATSAPP", p_limite: 20, p_operador_email: "TODOS" });
    const ex = await exportar(db, p.elegiveis.map((e) => e.id),
      { canal: "WHATSAPP", operador: "TODOS", previa_id: p.previa_id });
    expect((await movsDoLote(db, ex.lote_id)).length).toBe(0);  // pendente de registro

    await mov(db, ids[0], "FINALIZACAO_ATENDIMENTO", 2);
    const movAntes = (await db.query(`select id, aluno_id, tipo, registrado_em from public.aluno_movimentacoes order by id`)).rows;
    const fotoAntes = await fotoIntocavel(db);

    const { MIG7 } = await import("./fixtures/acoes_massivas_universo/bancada.js");
    await db.exec(MIG7);                                        // aplica a regra nova

    const l = await loteRow(db, ex.lote_id);
    expect(l.confirmado_em).toBeNull();                         // continua pendente de registro
    expect(l.descartado_em).toBeNull();
    expect((await movsDoLote(db, ex.lote_id)).length).toBe(0);   // nada foi backfilado
    expect((await db.query(`select id, aluno_id, tipo, registrado_em from public.aluno_movimentacoes order by id`)).rows)
      .toEqual(movAntes);                                       // nenhuma movimentacao recriada
    expect(await fotoIntocavel(db)).toEqual(fotoAntes);          // aluno/caso/financeiro iguais
  });
});
