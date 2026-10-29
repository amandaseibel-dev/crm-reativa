// ACAO MASSIVA: CONTA COMO ACIONAMENTO, MAS NAO PASSA PELA RECALCULADORA.
//
// MEDIDO EM PRODUCAO (03/10/2026): nos 2 primeiros lotes reais da regra de
// 02/10, 74 dos 200 alunos ficaram com data_retorno = registro + 10 e
// status_acionamento 'Acao massiva externa enviada -- aguardando retorno'.
// Causa: ao remover o short-circuit dos tipos massivos para a massiva voltar a
// contar como acionamento, a ULTIMA linha do gatilho -- a chamada a
// recalcular_situacao_aluno, que escreve data_retorno e status_acionamento --
// voltou a rodar para elas.
//
// "antes" = producao com 20261002094233; "depois" = + 20261003083400.
// A bancada registra QUEM chamou a recalculadora em _recalc_log, entao da para
// provar a ausencia da chamada, nao so a ausencia do efeito.
import { describe, it, expect, vi } from "vitest";
import { novoBanco, alunos, mov, previa, exportar, OP_A } from "./fixtures/acoes_massivas_universo/bancada.js";

vi.setConfig({ testTimeout: 180000, hookTimeout: 180000 });

const comBug = () => novoBanco({ registroAutomatico: true });
const corrigido = () => novoBanco({ registroAutomatico: true, semRetornoAutomatico: true });

const recalcDe = async (db, alunoId) =>
  (await db.query(`select motivo from public._recalc_log where aluno_id = $1`, [alunoId])).rows;

const alunoRow = async (db, id) =>
  (await db.query(`select data_ultimo_acionamento, data_retorno, status_acionamento,
                          responsavel_atual_email, retorno_origem from public.alunos where id = $1`, [id])).rows[0];

async function exportarTudo(db, limite) {
  const p = await previa(db, { p_canal: "WHATSAPP", p_limite: limite, p_operador_email: "TODOS" });
  return exportar(db, p.elegiveis.map((e) => e.id), { canal: "WHATSAPP", operador: "TODOS", previa_id: p.previa_id });
}

describe("o gatilho nao chama a recalculadora para acao massiva", () => {
  it("ANTES da correcao a recalculadora era chamada; DEPOIS nao e mais", async () => {
    const antes = await comBug();
    const depois = await corrigido();
    for (const db of [antes, depois]) await alunos(db, 3, { valor: 300 });

    const idsAntes = (await exportarTudo(antes, 3)).ids_registrados;
    const idsDepois = (await exportarTudo(depois, 3)).ids_registrados;
    expect(idsAntes.length).toBe(3);
    expect(idsDepois.length).toBe(3);

    // ANTES: uma chamada por aluno registrado
    expect((await recalcDe(antes, idsAntes[0])).map((r) => r.motivo)).toEqual(["acionamento"]);
    // DEPOIS: nenhuma
    expect(await recalcDe(depois, idsDepois[0])).toEqual([]);
    const total = (await depois.query(`select count(*)::int c from public._recalc_log`)).rows[0].c;
    expect(total).toBe(0);
  });

  it("contato de operador continua recalculando normalmente", async () => {
    const db = await corrigido();
    const [id] = await alunos(db, 1, { valor: 300 });
    await mov(db, id, "FINALIZACAO_ATENDIMENTO", 0);
    expect((await recalcDe(db, id)).map((r) => r.motivo)).toEqual(["acionamento"]);
  });

  it("os demais tipos de acionamento tambem seguem recalculando", async () => {
    const db = await corrigido();
    const ids = await alunos(db, 4, { valor: 300 });
    const tipos = ["CONTATO", "LINK_ENVIADO_AO_ALUNO", "SOLICITACAO_LINK_PAGAMENTO", "FINALIZACAO"];
    for (let i = 0; i < tipos.length; i++) await mov(db, ids[i], tipos[i], 0);
    for (const id of ids) expect((await recalcDe(db, id)).length).toBe(1);
  });
});

describe("o que a correcao preserva e o que ela corta", () => {
  it("acao massiva CONTINUA sendo o ultimo acionamento do aluno e do caso", async () => {
    const db = await corrigido();
    const [id] = await alunos(db, 1, { valor: 300, acionadoDias: 30 });
    const antes = (await alunoRow(db, id)).data_ultimo_acionamento;

    const r = await exportarTudo(db, 1);
    expect(r.registrados).toBe(1);

    const a = await alunoRow(db, id);
    expect(new Date(a.data_ultimo_acionamento).getTime()).toBeGreaterThan(new Date(antes).getTime());
    const caso = (await db.query(`select data_ultimo_acionamento from public.casos where aluno_id = $1`, [id])).rows[0];
    expect(caso.data_ultimo_acionamento).not.toBeNull();
  });

  it("a fidelizacao de 10 dias continua valendo: o caso sai da fila de liberacao", async () => {
    const db = await corrigido();
    const [id] = await alunos(db, 1, { valor: 300, dono: OP_A, acionadoDias: 40 });
    await db.query(`update public.alunos set responsavel_atual_em = now() - interval '5 days' where id = $1`, [id]);
    const elegiveis = async () =>
      (await db.query(`select aluno_id from public.casos_elegiveis_liberacao_fidelizacao()`)).rows.map((r) => r.aluno_id);
    expect(await elegiveis()).toEqual([id]);

    const p = await previa(db, { p_canal: "WHATSAPP", p_limite: 1, p_operador_email: OP_A });
    await exportar(db, p.elegiveis.map((e) => e.id), { canal: "WHATSAPP", operador: OP_A, previa_id: p.previa_id });

    expect(await elegiveis()).toEqual([]);
  });

  it("nao cria data_retorno, nao grava status_acionamento, nao troca responsavel", async () => {
    const db = await corrigido();
    const ids = await alunos(db, 5, { valor: 300 });
    const r = await exportarTudo(db, 5);
    expect(r.registrados).toBe(5);
    for (const id of ids) {
      const a = await alunoRow(db, id);
      expect(a.data_retorno).toBeNull();
      expect(a.status_acionamento).toBeNull();
      expect(a.retorno_origem).toBeNull();
      expect(a.responsavel_atual_email).toBeNull();
    }
  });

  it("nada financeiro e tocado", async () => {
    const db = await corrigido();
    await alunos(db, 5, { valor: 300 });
    const foto = async () => JSON.stringify((await db.query(
      `select (select count(*) from public.acordos) a, (select count(*) from public.parcelas) p,
              (select count(*) from public.acordos_titulos) t,
              (select count(*) from public.acordo_titulo_vinculo) v`)).rows);
    const antes = await foto();
    await exportarTudo(db, 5);
    expect(await foto()).toEqual(antes);
  });

  it("o rollback devolve a chamada a recalculadora", async () => {
    const db = await corrigido();
    await alunos(db, 2, { valor: 300 });
    const { RB8 } = await import("./fixtures/acoes_massivas_universo/bancada.js");
    await db.exec(RB8);
    const r = await exportarTudo(db, 2);
    expect(r.registrados).toBe(2);
    const total = (await db.query(`select count(*)::int c from public._recalc_log`)).rows[0].c;
    expect(total).toBe(2);
  });
});
