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
  novoBanco, comoGestao, alunos, acordoVencido, universo, previa, exportar,
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

// ---------------------------------------------------------------------------
// A LACUNA DO #537: campo de "Responsavel pelo acordo" VAZIO significava
// "acordo de qualquer pessoa". Nas modalidades que olham acordo, escolher de
// quem e o acordo passa a ser OBRIGATORIO -- na previa, no exportar e no
// registrar. MENSALIDADES segue sem a exigencia.
// ---------------------------------------------------------------------------
describe("acordo sem dono explicito e recusado nos tres caminhos", () => {
  const SO_CASO = `CASO:${OP_INATIVA}`;
  const COM_ACORDO = `CASO:${OP_INATIVA};ACORDO:${GESTAO}`;

  // o cenario que ela pediu: acordo da GESTORA em caso da OLGA
  const cenario = async () => {
    const [aluno] = await alunos(db, 1, { dono: OP_INATIVA, ini: 1 });
    await acordoVencido(db, aluno, GESTAO);
    return aluno;
  };

  it("PREVIA: ACORDOS_VENCIDOS sem dono de acordo é recusado", async () => {
    await cenario();
    await expect(previa(db, {
      p_operador_email: SO_CASO, p_tipo_cobranca: "ACORDOS_VENCIDOS", p_limite: 50,
    })).rejects.toThrow(/exige pelo menos um "Responsavel pelo acordo"/);
  });

  it("PREVIA: MENSALIDADES_E_ACORDOS sem dono de acordo é recusado", async () => {
    await cenario();
    await expect(previa(db, {
      p_operador_email: SO_CASO, p_tipo_cobranca: "MENSALIDADES_E_ACORDOS", p_limite: 50,
    })).rejects.toThrow(/Campo vazio NAO significa acordo de qualquer pessoa/);
  });

  it("PREVIA: MENSALIDADES segue SEM a exigência", async () => {
    await cenario();
    const p = await previa(db, {
      p_operador_email: SO_CASO, p_tipo_cobranca: "MENSALIDADES", p_limite: 50,
    });
    expect(p.previa_id).toBeTruthy();
  });

  it("PREVIA: com o dono do acordo escolhido, passa — e diz quem foi escolhido", async () => {
    const aluno = await cenario();
    const p = await previa(db, {
      p_operador_email: COM_ACORDO, p_tipo_cobranca: "ACORDOS_VENCIDOS", p_limite: 50,
    });
    expect(p.responsaveis_acordo).toEqual([GESTAO]);
    expect(p.elegiveis.map((e) => e.id)).toEqual([aluno]);
  });

  it("PREVIA: escolhendo OUTRO dono de acordo, o aluno não entra", async () => {
    await cenario();
    const p = await previa(db, {
      p_operador_email: `CASO:${OP_INATIVA};ACORDO:${OP_A}`,
      p_tipo_cobranca: "ACORDOS_VENCIDOS", p_limite: 50,
    });
    expect(p.elegiveis).toEqual([]);
  });

  it("CHAMADA ANTIGA também cai: 'todos', e-mail solto e vazio", async () => {
    await cenario();
    for (const op of ["todos", "livres", OP_INATIVA, "", null]) {
      await expect(previa(db, {
        p_operador_email: op, p_tipo_cobranca: "ACORDOS_VENCIDOS", p_limite: 50,
      })).rejects.toThrow(/Responsavel pelo acordo/);
    }
  });

  it("tipo AUSENTE vale MENSALIDADES_E_ACORDOS, e também é recusado", async () => {
    await cenario();
    // p_tipo_cobranca: null passa direto -- o default MENSALIDADES da bancada
    // só entra quando a chave vem `undefined`, e aqui o assunto É o tipo ausente
    await expect(previa(db, { p_operador_email: SO_CASO, p_limite: 50, p_tipo_cobranca: null }))
      .rejects.toThrow(/Responsavel pelo acordo/);
  });

  it("EXPORTAR recusa sozinho, mesmo com previa válida de outra modalidade", async () => {
    const aluno = await cenario();
    const p = await previa(db, {
      p_operador_email: SO_CASO, p_tipo_cobranca: "MENSALIDADES", p_limite: 50,
    });
    // a previa de mensalidades passou; exportar como ACORDOS_VENCIDOS sem dono não
    await expect(exportar(db, [aluno], {
      operador: SO_CASO, tipo: "ACORDOS_VENCIDOS", previa_id: p.previa_id,
    })).rejects.toThrow(/Responsavel pelo acordo/);
  });

  it("EXPORTAR passa com o dono escolhido", async () => {
    const aluno = await cenario();
    const p = await previa(db, {
      p_operador_email: COM_ACORDO, p_tipo_cobranca: "ACORDOS_VENCIDOS", p_limite: 50,
    });
    const ex = await exportar(db, [aluno], {
      operador: COM_ACORDO, tipo: "ACORDOS_VENCIDOS", previa_id: p.previa_id,
    });
    expect(ex.lote_id).toBeTruthy();
  });

  it("REGISTRAR recusa sem dono de acordo — o disparo não passa", async () => {
    const aluno = await cenario();
    await expect(db.query(
      `select public.registrar_acao_massiva(
         p_aluno_ids => $1::text[], p_canal => 'WHATSAPP', p_arquivo => 'x.xlsx',
         p_registrado_por_nome => 'G', p_registrado_por_email => $2,
         p_operador_email => $3, p_lote_id => null,
         p_filtros => $4::jsonb) r`,
      [`{${aluno}}`, GESTAO, SO_CASO, JSON.stringify({ tipo_cobranca: "ACORDOS_VENCIDOS" })]
    )).rejects.toThrow(/Responsavel pelo acordo/);
  });

  it("REGISTRAR sem tipo nos filtros também cai (default é MENSALIDADES_E_ACORDOS)", async () => {
    const aluno = await cenario();
    await expect(db.query(
      `select public.registrar_acao_massiva(
         p_aluno_ids => $1::text[], p_canal => 'WHATSAPP', p_arquivo => 'x.xlsx',
         p_registrado_por_nome => 'G', p_registrado_por_email => $2,
         p_operador_email => $3, p_lote_id => null, p_filtros => '{}'::jsonb) r`,
      [`{${aluno}}`, GESTAO, SO_CASO]
    )).rejects.toThrow(/Responsavel pelo acordo/);
  });

  it("REGISTRAR de MENSALIDADES segue passando", async () => {
    const aluno = await cenario();
    const r = await db.query(
      `select public.registrar_acao_massiva(
         p_aluno_ids => $1::text[], p_canal => 'WHATSAPP', p_arquivo => 'x.xlsx',
         p_registrado_por_nome => 'G', p_registrado_por_email => $2,
         p_operador_email => $3, p_lote_id => null,
         p_filtros => $4::jsonb) r`,
      [`{${aluno}}`, GESTAO, SO_CASO, JSON.stringify({ tipo_cobranca: "MENSALIDADES" })]);
    expect(r.rows[0].r).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// FICHA x CASO: o filtro recorta alunos.responsavel_atual_email, e a tela
// rotulava isso como "Responsavel pelo caso". Medido em producao em 27/09/2026:
// 20 alunos de 13.041 divergem, TODOS com ficha atribuida e caso sem dono.
// Estes testes fixam o comportamento nesses divergentes -- que nao e obvio e
// erra nas duas direcoes se alguem ler o rotulo antigo.
// ---------------------------------------------------------------------------
describe("registros divergentes: ficha de um, caso de outro", () => {
  // o padrao real: ficha com dono, caso SEM dono
  const fichaComDonoCasoLivre = async (dono, ini) => {
    const [aluno] = await alunos(db, 1, { dono, ini });
    await db.query("update public.casos set operador_email=null, operador_nome=null where aluno_id=$1", [aluno]);
    return aluno;
  };

  it("filtrar pela PESSOA traz o aluno, embora o caso esteja na fila livre", async () => {
    const divergente = await fichaComDonoCasoLivre(OP_INATIVA, 1);
    const normal = await alunos(db, 1, { dono: OP_INATIVA, ini: 11 });

    const r = await universo(db, { responsaveis_caso: [OP_INATIVA] });
    expect(disp(r)).toEqual([divergente, ...normal].sort());
  });

  it("filtrar por SEM_RESPONSAVEL NAO traz o divergente, embora o caso esteja sem dono", async () => {
    const divergente = await fichaComDonoCasoLivre(OP_INATIVA, 1);
    const livreDeVerdade = await alunos(db, 1, { dono: null, ini: 11 });

    const r = await universo(db, { responsaveis_caso: ["SEM_RESPONSAVEL"] });
    expect(disp(r)).toEqual([...livreDeVerdade]);
    expect(disp(r)).not.toContain(divergente);
  });

  it("a PREVIA conta o divergente e avisa que o caso esta em outra mao", async () => {
    await fichaComDonoCasoLivre(OP_INATIVA, 1);
    await alunos(db, 2, { dono: OP_INATIVA, ini: 11 });

    const p = await previa(db, {
      p_operador_email: `CASO:${OP_INATIVA}`, p_tipo_cobranca: "MENSALIDADES", p_limite: 50,
    });
    const linha = p.por_responsavel.find((x) => x.responsavel === OP_INATIVA);
    expect(linha.alunos).toBe(3);
    // so o divergente tem o caso em outra mao
    expect(linha.casos_em_outra_mao).toBe(1);
  });

  it("sem divergencia, a contagem e zero", async () => {
    await alunos(db, 2, { dono: OP_INATIVA, ini: 1 });
    const p = await previa(db, {
      p_operador_email: `CASO:${OP_INATIVA}`, p_tipo_cobranca: "MENSALIDADES", p_limite: 50,
    });
    expect(p.por_responsavel.find((x) => x.responsavel === OP_INATIVA).casos_em_outra_mao).toBe(0);
  });

  it("caso com dono DIFERENTE (não só sem dono) também é contado", async () => {
    const [aluno] = await alunos(db, 1, { dono: OP_INATIVA, ini: 1 });
    await db.query("update public.casos set operador_email=$2 where aluno_id=$1", [aluno, OP_A]);

    const p = await previa(db, {
      p_operador_email: `CASO:${OP_INATIVA}`, p_tipo_cobranca: "MENSALIDADES", p_limite: 50,
    });
    const linha = p.por_responsavel.find((x) => x.responsavel === OP_INATIVA);
    expect(linha.alunos).toBe(1);          // a ficha ainda é dela
    expect(linha.casos_em_outra_mao).toBe(1);
  });
});
