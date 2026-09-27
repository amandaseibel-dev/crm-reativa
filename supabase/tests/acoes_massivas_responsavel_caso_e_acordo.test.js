// ACOES MASSIVAS: responsavel em DUAS dimensoes (dono da FICHA e dono do ACORDO).
//
// Roda o universo VIVO de producao num PostgreSQL real: a bancada aplica
// supabase/migrations/20260920110000_acoes_massivas_universo.sql, cujo corpo tem
// md5 a71720cc4ad602f174f11af000ca8a8e -- identico ao de producao em 27/09/2026.
//
// O QUE ESTE ARQUIVO PROVA
//   * o recorte de responsavel e por DONO DA FICHA, e passa a aceitar LISTA;
//   * a dimensao de ACORDO existe e recorta o flag "tem acordo vencido";
//   * operadora DESLIGADA (Olga) pode ser selecionada e traz a carteira dela;
//   * acordo da GESTORA em caso da OLGA: cada dimensao pega o seu;
//   * Carteira Geral e "sem responsavel" entram como selecao explicita;
//   * a selecao explicita tem precedencia sobre o 'todos' que ja existia;
//   * sem selecao, NADA muda -- o comportamento antigo fica intacto.
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  novoBanco, comoGestao, alunos, acordoVencido, universo,
  GESTAO, OP_A, OP_B, OP_INATIVA, CG,
} from "./fixtures/acoes_massivas_universo/bancada.js";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

let db;
beforeEach(async () => { db = await novoBanco(); await comoGestao(db); });

const disp = (rows) => rows.filter((r) => r.disponivel).map((r) => r.aluno_id).sort();
const motivo = (rows, id) => rows.find((r) => r.aluno_id === id)?.motivo;

describe("dimensao CASO: lista de responsaveis, incluindo quem foi desligado", () => {
  it("uma lista com dois operadores traz os dois, e mais ninguem", async () => {
    const a = await alunos(db, 2, { dono: OP_A, ini: 1 });
    const b = await alunos(db, 2, { dono: OP_B, ini: 11 });
    const c = await alunos(db, 2, { dono: OP_INATIVA, ini: 21 });

    const r = await universo(db, { responsaveis_caso: [OP_A, OP_B] });
    expect(disp(r)).toEqual([...a, ...b].sort());
    for (const id of c) expect(motivo(r, id)).toBe("outro_responsavel");
  });

  it("a OPERADORA DESLIGADA pode ser selecionada e traz a carteira dela", async () => {
    const olga = await alunos(db, 3, { dono: OP_INATIVA, ini: 1 });
    await alunos(db, 2, { dono: OP_A, ini: 11 });

    const r = await universo(db, { responsaveis_caso: [OP_INATIVA] });
    expect(disp(r)).toEqual([...olga].sort());
  });

  it("'SEM_RESPONSAVEL' e a fila livre, e nao se mistura com pessoa nenhuma", async () => {
    const livres = await alunos(db, 2, { dono: null, ini: 1 });
    await alunos(db, 2, { dono: OP_A, ini: 11 });

    const r = await universo(db, { responsaveis_caso: ["SEM_RESPONSAVEL"] });
    expect(disp(r)).toEqual([...livres].sort());
  });

  it("Carteira Geral entra como selecao explicita", async () => {
    const naCg = await alunos(db, 2, { dono: CG, ini: 1 });
    await alunos(db, 2, { dono: OP_A, ini: 11 });

    const r = await universo(db, { responsaveis_caso: [CG] });
    expect(disp(r)).toEqual([...naCg].sort());
  });

  it("pessoa + fila livre na mesma selecao", async () => {
    const livres = await alunos(db, 1, { dono: null, ini: 1 });
    const daOlga = await alunos(db, 1, { dono: OP_INATIVA, ini: 11 });
    await alunos(db, 1, { dono: OP_A, ini: 21 });

    const r = await universo(db, { responsaveis_caso: [OP_INATIVA, "SEM_RESPONSAVEL"] });
    expect(disp(r)).toEqual([...livres, ...daOlga].sort());
  });

  it("a selecao explicita tem precedencia sobre o 'todos' que ja existia", async () => {
    const a = await alunos(db, 1, { dono: OP_A, ini: 1 });
    await alunos(db, 1, { dono: OP_B, ini: 11 });

    // 'todos' desligaria o recorte; a lista manda
    const r = await universo(db, { operador: "todos", responsaveis_caso: [OP_A] });
    expect(disp(r)).toEqual(a);
  });

  it("SEM selecao, o comportamento antigo fica intacto", async () => {
    const livres = await alunos(db, 2, { dono: null, ini: 1 });
    const a = await alunos(db, 2, { dono: OP_A, ini: 11 });

    expect(disp(await universo(db, {}))).toEqual([...livres].sort());          // default 'livres'
    expect(disp(await universo(db, { operador: OP_A }))).toEqual([...a].sort());
    expect(disp(await universo(db, { operador: "todos" })).length).toBe(4);
    // lista vazia tambem nao liga a dimensao
    expect(disp(await universo(db, { responsaveis_caso: [] }))).toEqual([...livres].sort());
  });
});

describe("dimensao ACORDO: nao acionar acordo de outra pessoa sem perceber", () => {
  // O caso e da OLGA; o acordo vencido e da GESTORA. Em producao sao ~902
  // acordos nessa situacao.
  const cenario = async () => {
    const [aluno] = await alunos(db, 1, { dono: OP_INATIVA, ini: 1 });
    await acordoVencido(db, aluno, GESTAO);
    return aluno;
  };

  it("acordo da GESTORA em caso da OLGA: cada dimensao pega o seu", async () => {
    const aluno = await cenario();

    // pelo caso: a Olga tem o aluno
    expect(disp(await universo(db, { responsaveis_caso: [OP_INATIVA] }))).toEqual([aluno]);
    // pelo caso da gestora: ninguem
    expect(disp(await universo(db, { responsaveis_caso: [GESTAO] }))).toEqual([]);
  });

  it("modalidade ACORDOS_VENCIDOS: sem a dimensao de acordo, o de terceiro ENTRA", async () => {
    const aluno = await cenario();
    const r = await universo(db, {
      responsaveis_caso: [OP_INATIVA], tipo_cobranca: "ACORDOS_VENCIDOS",
    });
    // e o comportamento de hoje, e e exatamente o risco medido
    expect(disp(r)).toEqual([aluno]);
  });

  it("com a dimensao de acordo, o de terceiro SAI", async () => {
    const aluno = await cenario();
    const r = await universo(db, {
      responsaveis_caso: [OP_INATIVA],
      responsaveis_acordo: [OP_INATIVA],          // so acordo DELA
      tipo_cobranca: "ACORDOS_VENCIDOS",
    });
    expect(disp(r)).toEqual([]);
    expect(motivo(r, aluno)).toBe("fora_tipo_cobranca");
  });

  it("escolhendo a dona do ACORDO, o aluno volta", async () => {
    const aluno = await cenario();
    const r = await universo(db, {
      responsaveis_caso: [OP_INATIVA],
      responsaveis_acordo: [GESTAO],
      tipo_cobranca: "ACORDOS_VENCIDOS",
    });
    expect(disp(r)).toEqual([aluno]);
  });

  it("a dimensao de acordo NAO tira quem tem mensalidade", async () => {
    const aluno = await cenario();   // tem titulo aberto E acordo vencido de terceiro
    const r = await universo(db, {
      responsaveis_caso: [OP_INATIVA],
      responsaveis_acordo: [OP_INATIVA],
      tipo_cobranca: "MENSALIDADES",
    });
    // recortar o `parc` tiraria o aluno da base inteira; recortar so o flag nao
    expect(disp(r)).toEqual([aluno]);
  });

  it("acordo SEM dono entra por 'SEM_RESPONSAVEL' na dimensao de acordo", async () => {
    const [aluno] = await alunos(db, 1, { dono: OP_A, ini: 1 });
    await acordoVencido(db, aluno, null);

    expect(disp(await universo(db, {
      responsaveis_caso: [OP_A], responsaveis_acordo: ["SEM_RESPONSAVEL"],
      tipo_cobranca: "ACORDOS_VENCIDOS",
    }))).toEqual([aluno]);

    expect(disp(await universo(db, {
      responsaveis_caso: [OP_A], responsaveis_acordo: [OP_B],
      tipo_cobranca: "ACORDOS_VENCIDOS",
    }))).toEqual([]);
  });

  it("acordo de terceiro na CARTEIRA GERAL: as duas dimensoes combinam", async () => {
    const [aluno] = await alunos(db, 1, { dono: CG, ini: 1 });
    await acordoVencido(db, aluno, GESTAO);

    // caso na Carteira Geral, acordo da gestora
    expect(disp(await universo(db, {
      responsaveis_caso: [CG], responsaveis_acordo: [GESTAO],
      tipo_cobranca: "ACORDOS_VENCIDOS",
    }))).toEqual([aluno]);

    // pedindo acordo da Carteira Geral, nao vem
    expect(disp(await universo(db, {
      responsaveis_caso: [CG], responsaveis_acordo: [CG],
      tipo_cobranca: "ACORDOS_VENCIDOS",
    }))).toEqual([]);
  });
});

describe("a lista de quem pode ser escolhido", () => {
  it("traz quem tem caso OU acordo, com as duas contagens e a classe", async () => {
    await alunos(db, 2, { dono: OP_INATIVA, ini: 1 });
    const [x] = await alunos(db, 1, { dono: OP_A, ini: 11 });
    await acordoVencido(db, x, GESTAO);
    await alunos(db, 1, { dono: null, ini: 21 });

    const r = (await db.query("select public.acoes_massivas_responsaveis() r")).rows[0].r;
    const por = Object.fromEntries(r.map((o) => [o.email, o]));

    // a desligada aparece, e diz que esta inativa
    expect(por[OP_INATIVA].casos).toBe(2);
    expect(por[OP_INATIVA].classe).toBe("INATIVO");
    // a gestora aparece por ACORDO, mesmo sem caso
    expect(por[GESTAO].acordos).toBe(1);
    expect(por[GESTAO].casos).toBe(0);
    expect(por[GESTAO].classe).toBe("NAO_OPERADOR");
    // fila livre vem como sentinela, em primeiro
    expect(r[0].email).toBe("SEM_RESPONSAVEL");
    expect(r[0].casos).toBe(1);
  });

  it("nao inventa quem nao tem nada", async () => {
    await alunos(db, 1, { dono: OP_A, ini: 1 });
    const r = (await db.query("select public.acoes_massivas_responsaveis() r")).rows[0].r;
    expect(r.map((o) => o.email)).not.toContain(OP_B);
  });
});
