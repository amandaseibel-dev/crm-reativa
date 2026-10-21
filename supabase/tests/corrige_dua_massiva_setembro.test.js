// CORRECAO PONTUAL dos alunos com `data_ultimo_acionamento` atras da propria
// acao massiva (janela 20/09-02/10 de 2026, em que o gatilho ignorava os tipos
// massivos de proposito).
//
// Bancada PGlite (Postgres real, dados inventados) + a migration REAL
// 20261020094500. A migration chama a funcao com os 11 ids de producao, que
// nao existem aqui -- entao ela aplica zero linha, o que por si so ja prova
// que a correcao nao inventa alvo. Os testes chamam a MESMA funcao com ids
// sintéticos, no padrao de `backfill_57_conciliacao_legado`.
//
// O que prova:
//   1. leva o campo ate a movimentacao de acionamento mais nova e espelha no caso;
//   2. e idempotente: a segunda passada corrige 0 e nao duplica a trilha;
//   3. nao toca quem ja esta em dia;
//   4. nao altera retorno, tabulacao, responsavel nem status -- so o acionamento;
//   5. nao cria nem apaga movimentacao;
//   6. aluno com o MESMO sintoma fora da lista de ids fica intacto;
//   7. o caso nunca regride;
//   8. a trilha guarda o valor ANTES, que e o que o rollback le.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { novoBanco, alunos, mov, OP_A } from "./fixtures/acoes_massivas_universo/bancada.js";

vi.setConfig({ testTimeout: 180000, hookTimeout: 180000 });

const MIG = readFileSync(
  resolve("supabase/migrations/20261020093853_corrige_dua_massiva_setembro.sql"), "utf8");

const banco = async () => {
  const db = await novoBanco({ registroAutomatico: true });
  await db.exec(MIG);
  return db;
};

/**
 * Aluno no estado exato do defeito: tem a movimentacao massiva de N dias
 * atras, mas o campo (e o caso) ficaram parados num contato mais antigo --
 * que e o que a janela 20/09-02/10 produzia.
 */
async function comDefeito(db, { ini, massivaDias = 20, campoDias = 50, extra = {} } = {}) {
  const [id] = await alunos(db, 1, { ini, dono: OP_A, acionadoDias: campoDias });
  await mov(db, id, "ACAO_MASSIVA_EXTERNA", massivaDias);
  // O gatilho da bancada pode ter adiantado o campo; devolvemos ao estado do
  // defeito para o teste medir a CORRECAO, nao o gatilho.
  await db.query(
    `update public.alunos set data_ultimo_acionamento = now() - ($2::int || ' days')::interval,
            status_acionamento = $3, data_retorno = current_date + 5, retorno_origem = 'OPERADOR',
            status_jornada = 'CONTATAR', status_atual = 'CONTATAR'
      where id = $1`, [id, campoDias, extra.statusAcionamento ?? "Ação massiva externa enviada — aguardando retorno"]);
  await db.query(
    `update public.casos set data_ultimo_acionamento = current_date - $2::int where aluno_id = $1`,
    [id, campoDias]);
  return id;
}

const corrigir = async (db, ids) =>
  (await db.query(`select public._corrige_dua_massiva_setembro($1::uuid[]) r`, [ids])).rows[0].r;

const aluno = async (db, id) => (await db.query(
  `select (data_ultimo_acionamento at time zone 'America/Sao_Paulo')::date as dua,
          status_acionamento, data_retorno, retorno_origem, responsavel_atual_email,
          status_jornada, status_atual
     from public.alunos where id = $1`, [id])).rows[0];

const caso = async (db, id) => (await db.query(
  `select data_ultimo_acionamento as dua from public.casos where aluno_id = $1`, [id])).rows[0];

const diasAtras = async (db, n) => (await db.query(
  `select ((now() - ($1::int || ' days')::interval) at time zone 'America/Sao_Paulo')::date as d`, [n])).rows[0].d;

describe("correcao pontual do ultimo acionamento preso atras da massiva", () => {
  it("leva o campo ate a massiva registrada e espelha no caso", async () => {
    const db = await banco();
    const id = await comDefeito(db, { ini: 1, massivaDias: 20, campoDias: 50 });

    expect((await aluno(db, id)).dua).toEqual(await diasAtras(db, 50));
    const r = await corrigir(db, [id]);

    expect(r.corrigidos).toBe(1);
    expect((await aluno(db, id)).dua).toEqual(await diasAtras(db, 20));
    expect((await caso(db, id)).dua).toEqual(await diasAtras(db, 20));
  });

  it("e idempotente: a segunda passada corrige 0 e nao duplica a trilha", async () => {
    const db = await banco();
    const id = await comDefeito(db, { ini: 10 });

    const primeira = await corrigir(db, [id]);
    const depoisDaPrimeira = await aluno(db, id);
    const segunda = await corrigir(db, [id]);

    expect(primeira.corrigidos).toBe(1);
    expect(segunda.corrigidos).toBe(0);
    expect(segunda.ja_em_dia).toBe(1);
    expect(await aluno(db, id)).toEqual(depoisDaPrimeira);
    expect(Number((await db.query(
      `select count(*) n from public._backup_dua_massiva_setembro_20261020`)).rows[0].n)).toBe(1);
  });

  it("nao toca quem ja esta em dia", async () => {
    const db = await banco();
    // campo MAIS NOVO que a massiva: nada a corrigir
    const [id] = await alunos(db, 1, { ini: 20, dono: OP_A, acionadoDias: 2 });
    await mov(db, id, "ACAO_MASSIVA_EXTERNA", 30);
    const antes = await aluno(db, id);

    const r = await corrigir(db, [id]);

    expect(r.corrigidos).toBe(0);
    expect(await aluno(db, id)).toEqual(antes);
  });

  it("nao altera retorno, tabulacao, responsavel nem status", async () => {
    const db = await banco();
    const id = await comDefeito(db, { ini: 30 });
    const antes = await aluno(db, id);

    await corrigir(db, [id]);
    const depois = await aluno(db, id);

    expect(depois.dua).not.toEqual(antes.dua);          // so o acionamento muda
    expect(depois.status_acionamento).toBe(antes.status_acionamento);
    expect(depois.data_retorno).toEqual(antes.data_retorno);
    expect(depois.retorno_origem).toBe(antes.retorno_origem);
    expect(depois.responsavel_atual_email).toBe(antes.responsavel_atual_email);
    expect(depois.status_jornada).toBe(antes.status_jornada);
    expect(depois.status_atual).toBe(antes.status_atual);
  });

  it("nao cria nem apaga movimentacao", async () => {
    const db = await banco();
    const id = await comDefeito(db, { ini: 40 });
    const conta = async () => (await db.query(
      `select count(*) n, coalesce(max(id),0) ultimo from public.aluno_movimentacoes`)).rows[0];
    const antes = await conta();

    await corrigir(db, [id]);

    expect(await conta()).toEqual(antes);
  });

  it("aluno com o mesmo sintoma fora da lista de ids fica intacto", async () => {
    const db = await banco();
    const alvo = await comDefeito(db, { ini: 50 });
    const vizinho = await comDefeito(db, { ini: 60 });
    const antesVizinho = await aluno(db, vizinho);
    const casoVizinho = await caso(db, vizinho);

    const r = await corrigir(db, [alvo]);

    expect(r.corrigidos).toBe(1);
    expect(await aluno(db, vizinho)).toEqual(antesVizinho);
    expect(await caso(db, vizinho)).toEqual(casoVizinho);
  });

  it("o caso nunca regride", async () => {
    const db = await banco();
    const id = await comDefeito(db, { ini: 70, massivaDias: 20, campoDias: 50 });
    // caso ja esta mais adiantado que a massiva (acionamento registrado so no caso)
    await db.query(
      `update public.casos set data_ultimo_acionamento = current_date - 3 where aluno_id = $1`, [id]);

    await corrigir(db, [id]);

    expect((await caso(db, id)).dua).toEqual(await diasAtras(db, 3));
  });

  it("a trilha guarda o valor ANTES, que e o que o rollback le", async () => {
    const db = await banco();
    const id = await comDefeito(db, { ini: 80, massivaDias: 20, campoDias: 50 });
    const antes = await aluno(db, id);

    await corrigir(db, [id]);

    const t = (await db.query(
      `select (dua_antes at time zone 'America/Sao_Paulo')::date as antes,
              (dua_depois at time zone 'America/Sao_Paulo')::date as depois,
              status_acionamento_antes, data_retorno_antes, responsavel_atual_email_antes
         from public._backup_dua_massiva_setembro_20261020 where aluno_id = $1`, [id])).rows[0];

    expect(t.antes).toEqual(await diasAtras(db, 50));
    expect(t.depois).toEqual(await diasAtras(db, 20));
    expect(t.status_acionamento_antes).toBe(antes.status_acionamento);
    expect(t.data_retorno_antes).toEqual(antes.data_retorno);
    expect(t.responsavel_atual_email_antes).toBe(antes.responsavel_atual_email);

    // o caso tambem tem trilha, para o rollback devolver os dois lados
    expect(Number((await db.query(
      `select count(*) n from public._backup_dua_massiva_setembro_20261020_casos
        where aluno_id = $1`, [id])).rows[0].n)).toBe(1);
  });
});
