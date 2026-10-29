import { describe, it, expect } from "vitest";
import {
  montarListaFiltrada,
  recorteProntoParaGuiado,
  alunosDoCursoEscolhido,
  alunosDoSemestreEscolhido,
  finAlunosDoSemestre,
  valorAbertoDe,
  cursoSemestrePedido,
  CURSOS_CARTEIRA,
  SEMESTRES_CARTEIRA,
  estadoRecorteCursoSemestre,
  MSG_RECORTE_CARREGANDO,
  MSG_RECORTE_INDISPONIVEL,
} from "./carteiraFila";

// Relogio fixo: sem isso "acionado hoje" mudaria de valor amanha e o teste
// viraria falso-negativo.
const HOJE = "2026-10-23";
const AGORA = Date.parse("2026-10-23T12:00:00Z");

// O mapa e exatamente o que a RPC `carteira_curso_semestre_do_operador`
// devolve, uma linha por ficha da carteira.
//
//   m1  Medicina nas duas janelas, mensalidade so em 2026/1
//   m2  Odontologia nas duas, mensalidade so em 2026/2
//   m3  TROCOU de curso: Medicina em 2026/1, Odontologia em 2026/2
//   m4  nenhum dos 3 cursos; divida so dentro de acordo de 2026/1
//   m5  Medicina; divida so em acordo INDETERMINADO (acordo sem titulo)
//   m6  Medicina; divida real, mas de 2025 -- atribuida a OUTRO semestre
const MAPA = {
  m1: {
    curso_2026_1: "Medicina", curso_2026_2: "Medicina",
    titulos_2026_1: 3, saldo_2026_1: 1500, titulos_2026_2: 0, saldo_2026_2: 0,
    acordo_saldo_2026_1: 0, acordo_saldo_2026_2: 0, acordo_indeterminado: 0,
  },
  m2: {
    curso_2026_1: "Odontologia", curso_2026_2: "Odontologia",
    titulos_2026_1: 0, saldo_2026_1: 0, titulos_2026_2: 2, saldo_2026_2: 900,
    acordo_saldo_2026_1: 0, acordo_saldo_2026_2: 0, acordo_indeterminado: 0,
  },
  m3: {
    curso_2026_1: "Medicina", curso_2026_2: "Odontologia",
    titulos_2026_1: 1, saldo_2026_1: 400, titulos_2026_2: 1, saldo_2026_2: 600,
    acordo_saldo_2026_1: 0, acordo_saldo_2026_2: 0, acordo_indeterminado: 0,
  },
  m4: {
    curso_2026_1: null, curso_2026_2: null,
    titulos_2026_1: 0, saldo_2026_1: 0, titulos_2026_2: 0, saldo_2026_2: 0,
    acordo_saldo_2026_1: 2500, acordo_saldo_2026_2: 0, acordo_indeterminado: 0,
  },
  m5: {
    curso_2026_1: "Medicina", curso_2026_2: "Medicina",
    titulos_2026_1: 0, saldo_2026_1: 0, titulos_2026_2: 0, saldo_2026_2: 0,
    saldo_outros_semestres: 0, saldo_sem_serie: 0,
    acordo_saldo_2026_1: 0, acordo_saldo_2026_2: 0,
    acordo_outros_semestres: 0, acordo_indeterminado: 7000,
  },
  m6: {
    curso_2026_1: "Medicina", curso_2026_2: "Medicina",
    titulos_2026_1: 0, saldo_2026_1: 0, titulos_2026_2: 0, saldo_2026_2: 0,
    saldo_outros_semestres: 3100, saldo_sem_serie: 250,
    acordo_saldo_2026_1: 0, acordo_saldo_2026_2: 0,
    acordo_outros_semestres: 1800, acordo_indeterminado: 0,
  },
};

function aluno(id, extra) {
  return {
    id,
    status_atual: "CONTATAR",
    nivel_criticidade: "NORMAL",
    data_retorno: null,
    data_ultimo_acionamento: null,
    valor_em_aberto: 1000,
    ...extra,
  };
}

const CASOS = ["m1", "m2", "m3", "m4", "m5", "m6"].map((id) => aluno(id));

function entrada(extra) {
  return {
    casos: CASOS,
    casosForaDaFila: [],
    ordenacao: "valor_desc",
    hoje: HOJE,
    agoraMs: AGORA,
    ...extra,
  };
}

const ids = (l) => l.map((a) => a.id);

describe("Minha Carteira: filtro de curso", () => {
  it("as opcoes sao exatamente os 3 cursos pedidos pela gestao", () => {
    expect(CURSOS_CARTEIRA).toEqual(["Medicina", "Medicina Veterinária", "Odontologia"]);
  });

  it("'TODOS' devolve null -- nao filtra nada", () => {
    expect(alunosDoCursoEscolhido(MAPA, "TODOS", "AMBOS")).toBeNull();
    expect(alunosDoCursoEscolhido(MAPA, "", "AMBOS")).toBeNull();
  });

  it("com 2026/1 escolhido, vale o curso DA JANELA de 2026/1", () => {
    const s = alunosDoCursoEscolhido(MAPA, "Medicina", "2026/1");
    expect([...s].sort()).toEqual(["m1", "m3", "m5", "m6"]);
  });

  it("com 2026/2 escolhido, vale o curso DA JANELA de 2026/2", () => {
    // m3 trocou: em 2026/2 ele e Odontologia, entao sai de Medicina.
    const s = alunosDoCursoEscolhido(MAPA, "Medicina", "2026/2");
    expect([...s].sort()).toEqual(["m1", "m5", "m6"]);
    expect(alunosDoCursoEscolhido(MAPA, "Odontologia", "2026/2").has("m3")).toBe(true);
  });

  it("em 'Ambos', quem trocou de curso aparece nos DOIS recortes", () => {
    expect(alunosDoCursoEscolhido(MAPA, "Medicina", "AMBOS").has("m3")).toBe(true);
    expect(alunosDoCursoEscolhido(MAPA, "Odontologia", "AMBOS").has("m3")).toBe(true);
  });

  it("o casamento e por igualdade exata -- 'Biomedicina' nunca entra em Medicina", () => {
    const mapa = { x: { curso_2026_1: "Biomedicina", curso_2026_2: "Biomedicina" } };
    expect(alunosDoCursoEscolhido(mapa, "Medicina", "AMBOS").size).toBe(0);
  });

  it("ficha sem curso nos 3 nao entra em nenhum deles", () => {
    for (const c of CURSOS_CARTEIRA) {
      expect(alunosDoCursoEscolhido(MAPA, c, "AMBOS").has("m4")).toBe(false);
    }
  });
});

describe("Minha Carteira: filtro de semestre", () => {
  it("as opcoes sao 2026/1 e 2026/2", () => {
    expect(SEMESTRES_CARTEIRA).toEqual(["2026/1", "2026/2"]);
  });

  it("'AMBOS' devolve null -- nao filtra nada", () => {
    expect(alunosDoSemestreEscolhido(MAPA, "AMBOS")).toBeNull();
    expect(alunosDoSemestreEscolhido(MAPA, "")).toBeNull();
    expect(alunosDoSemestreEscolhido(MAPA, "2025/2")).toBeNull();
  });

  it("entra quem tem MENSALIDADE do semestre", () => {
    expect([...alunosDoSemestreEscolhido(MAPA, "2026/1")].sort()).toEqual(["m1", "m3", "m4"]);
    expect([...alunosDoSemestreEscolhido(MAPA, "2026/2")].sort()).toEqual(["m2", "m3"]);
  });

  it("entra tambem quem tem PARCELA DE ACORDO atribuivel ao semestre", () => {
    // m4 nao tem mensalidade aberta: entra em 2026/1 so pelo acordo.
    expect(alunosDoSemestreEscolhido(MAPA, "2026/1").has("m4")).toBe(true);
    expect(alunosDoSemestreEscolhido(MAPA, "2026/2").has("m4")).toBe(false);
  });

  it("acordo INDETERMINADO nao entra em semestre nenhum -- nao se chuta", () => {
    // m5 deve R$ 7.000 num acordo sem titulo vinculado: nao se sabe de que
    // semestre e. Ele aparece em "Ambos" e em nenhum dos dois recortes.
    expect(alunosDoSemestreEscolhido(MAPA, "2026/1").has("m5")).toBe(false);
    expect(alunosDoSemestreEscolhido(MAPA, "2026/2").has("m5")).toBe(false);
    expect(ids(montarListaFiltrada(entrada()))).toContain("m5");
  });
});

describe("Minha Carteira: o que e de OUTRO semestre fica de fora dos dois", () => {
  // A RPC fecha a linha: mensalidade = 2026/1 + 2026/2 + outros_semestres +
  // sem_serie, e acordo = 2026/1 + 2026/2 + outros_semestres + indeterminado.
  // Medido em PROD em 23/10/2026, as duas somas batem com diferenca 0,00 -- e
  // R$ 3.028.377,13 da carteira vivem nesses baldes de fora. O que este bloco
  // protege e que eles NUNCA sejam contados como 2026/1 ou 2026/2.
  it("ficha com divida so de 2025 nao entra em 2026/1 nem em 2026/2", () => {
    expect(alunosDoSemestreEscolhido(MAPA, "2026/1").has("m6")).toBe(false);
    expect(alunosDoSemestreEscolhido(MAPA, "2026/2").has("m6")).toBe(false);
  });

  it("mas ela continua na carteira, visivel em 'Ambos'", () => {
    expect(ids(montarListaFiltrada(entrada()))).toContain("m6");
  });

  it("o valor do semestre nao soma outros_semestres, sem_serie nem indeterminado", () => {
    const f1 = finAlunosDoSemestre({}, MAPA, "2026/1");
    const f2 = finAlunosDoSemestre({}, MAPA, "2026/2");
    // m6 tem R$ 5.150 de divida real, toda fora de 2026: zera nos dois.
    expect(valorAbertoDe({ id: "m6", valor_em_aberto: 0 }, f1)).toBe(0);
    expect(valorAbertoDe({ id: "m6", valor_em_aberto: 0 }, f2)).toBe(0);
    // e m5, que deve R$ 7.000 indeterminados, tambem.
    expect(valorAbertoDe({ id: "m5", valor_em_aberto: 0 }, f1)).toBe(0);
  });
});

describe("Minha Carteira: os dois filtros combinados", () => {
  it("combinar curso e semestre pede as DUAS condicoes (interseccao)", () => {
    const l = montarListaFiltrada(entrada({
      alunosDoCurso: alunosDoCursoEscolhido(MAPA, "Medicina", "2026/1"),
      alunosDoSemestre: alunosDoSemestreEscolhido(MAPA, "2026/1"),
    }));
    // Medicina em 2026/1 = m1, m3, m5, m6; com mensalidade/acordo de 2026/1 =
    // m1, m3, m4. A interseccao e m1 e m3 -- m5 cai por divida indeterminada,
    // m6 por divida de outro semestre, e m4 por nao ser Medicina.
    expect(ids(l).sort()).toEqual(["m1", "m3"]);
  });

  it("Odontologia em 2026/2 entrega so quem casa as duas", () => {
    const l = montarListaFiltrada(entrada({
      alunosDoCurso: alunosDoCursoEscolhido(MAPA, "Odontologia", "2026/2"),
      alunosDoSemestre: alunosDoSemestreEscolhido(MAPA, "2026/2"),
    }));
    expect(ids(l).sort()).toEqual(["m2", "m3"]);
  });

  it("filtro nao carregado (null) NAO encolhe a lista", () => {
    const todos = ids(montarListaFiltrada(entrada())).sort();
    const comNull = ids(montarListaFiltrada(entrada({
      alunosDoCurso: null,
      alunosDoSemestre: null,
    }))).sort();
    expect(comNull).toEqual(todos);
    expect(todos).toEqual(["m1", "m2", "m3", "m4", "m5", "m6"]);
  });
});

describe("Minha Carteira: o valor exibido segue o semestre escolhido", () => {
  const FIN = {
    m1: { temDetalhe: true, total: 9999, menorVencimento: "2026-03-10" },
    m3: { temDetalhe: true, total: 8888, menorVencimento: "2026-04-10" },
  };

  it("em 'Ambos' devolve o proprio finAlunos -- nada muda de comportamento", () => {
    expect(finAlunosDoSemestre(FIN, MAPA, "AMBOS")).toBe(FIN);
    expect(finAlunosDoSemestre(FIN, MAPA, "")).toBe(FIN);
  });

  it("com semestre escolhido, o total passa a ser mensalidade + acordo DAQUELE semestre", () => {
    const f1 = finAlunosDoSemestre(FIN, MAPA, "2026/1");
    expect(valorAbertoDe({ id: "m1" }, f1)).toBe(1500);
    expect(valorAbertoDe({ id: "m3" }, f1)).toBe(400);
    expect(valorAbertoDe({ id: "m4" }, f1)).toBe(2500); // so acordo

    const f2 = finAlunosDoSemestre(FIN, MAPA, "2026/2");
    expect(valorAbertoDe({ id: "m1" }, f2)).toBe(0);
    expect(valorAbertoDe({ id: "m3" }, f2)).toBe(600);
  });

  it("acordo indeterminado NAO e somado a nenhum semestre", () => {
    expect(valorAbertoDe({ id: "m5" }, finAlunosDoSemestre(FIN, MAPA, "2026/1"))).toBe(0);
    expect(valorAbertoDe({ id: "m5" }, finAlunosDoSemestre(FIN, MAPA, "2026/2"))).toBe(0);
  });

  it("preserva os outros campos da linha (a tela le menorVencimento)", () => {
    const f1 = finAlunosDoSemestre(FIN, MAPA, "2026/1");
    expect(f1.m1.menorVencimento).toBe("2026-03-10");
    expect(f1.m3.menorVencimento).toBe("2026-04-10");
  });

  it("o filtro de valor e a ordenacao passam a usar o valor do semestre", () => {
    const f1 = finAlunosDoSemestre(FIN, MAPA, "2026/1");
    const l = montarListaFiltrada(entrada({
      finAlunos: f1,
      alunosDoSemestre: alunosDoSemestreEscolhido(MAPA, "2026/1"),
      ordenacao: "valor_desc",
    }));
    // m4 (2.500) > m1 (1.500) > m3 (400) -- pelos valores de 2026/1, nao pelos
    // totais de 9.999/8.888 que o finAlunos cru traria.
    expect(ids(l)).toEqual(["m4", "m1", "m3"]);
  });
});

describe("Minha Carteira: o guiado nao comeca em recorte a meio carregar", () => {
  it("curso escolhido com o conjunto ainda null bloqueia", () => {
    expect(recorteProntoParaGuiado({ filtroCurso: "Medicina", alunosDoCurso: null })).toBe(false);
    expect(recorteProntoParaGuiado({ filtroCurso: "Medicina", alunosDoCurso: new Set(["m1"]) })).toBe(true);
  });

  it("semestre escolhido com o conjunto ainda null bloqueia", () => {
    expect(recorteProntoParaGuiado({ filtroSemestre: "2026/1", alunosDoSemestre: null })).toBe(false);
    expect(recorteProntoParaGuiado({ filtroSemestre: "2026/1", alunosDoSemestre: new Set(["m1"]) })).toBe(true);
  });

  it("em TODOS/AMBOS nao exige conjunto nenhum", () => {
    expect(recorteProntoParaGuiado({})).toBe(true);
    expect(recorteProntoParaGuiado({ filtroCurso: "TODOS", filtroSemestre: "AMBOS" })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A leitura so acontece quando o operador pede (26/10/2026)
// ---------------------------------------------------------------------------
//
// O que estas checagens protegem: a RPC de curso/semestre e a consulta mais
// cara da tela (3,07 s no MELHOR caso, contra teto de 8 s do papel
// `authenticated`) e saia em toda abertura de carteira. Se alguem voltar a
// dispara-la no padrao, o custo volta para todos os operadores -- inclusive os
// que nunca tocam no recorte.
describe("Minha Carteira: a leitura de curso/semestre e sob demanda", () => {
  it("no padrao da tela (TODOS/AMBOS) NAO pede a consulta", () => {
    expect(cursoSemestrePedido("TODOS", "AMBOS")).toBe(false);
  });

  it("sem filtro nenhum (vazio, nulo, indefinido) tambem nao pede", () => {
    expect(cursoSemestrePedido(undefined, undefined)).toBe(false);
    expect(cursoSemestrePedido(null, null)).toBe(false);
    expect(cursoSemestrePedido("", "")).toBe(false);
  });

  it("escolher um curso pede a consulta", () => {
    for (const c of CURSOS_CARTEIRA) {
      expect(cursoSemestrePedido(c, "AMBOS")).toBe(true);
    }
  });

  it("escolher um semestre pede a consulta", () => {
    for (const s of SEMESTRES_CARTEIRA) {
      expect(cursoSemestrePedido("TODOS", s)).toBe(true);
    }
  });

  it("os dois juntos pedem uma vez -- a RPC traz as duas dimensoes", () => {
    expect(cursoSemestrePedido("Medicina", "2026/1")).toBe(true);
  });

  it("valor fora das listas NAO dispara a consulta pesada", () => {
    // Pertencimento, nao `!== TODOS`: valor estranho no select (ou um rotulo
    // renomeado sem atualizar a lista) nao pode custar 3 a 8 s de banco.
    expect(cursoSemestrePedido("Biomedicina", "AMBOS")).toBe(false);
    expect(cursoSemestrePedido("TODOS", "2025/2")).toBe(false);
    expect(cursoSemestrePedido("QUALQUER", "QUALQUER")).toBe(false);
  });

  it("espaco em volta nao muda a decisao", () => {
    expect(cursoSemestrePedido("  Medicina  ", "AMBOS")).toBe(true);
    expect(cursoSemestrePedido("TODOS", "  2026/2  ")).toBe(true);
  });

  it("o recorte a meio carregar continua bloqueando o guiado", () => {
    // A leitura sob demanda torna o estado "pediu mas ainda nao chegou" MAIS
    // frequente. A guarda que ja existia e o que impede o guiado de comecar
    // num recorte incompleto -- ela nao pode ser removida junto.
    expect(recorteProntoParaGuiado({ filtroCurso: "Medicina", alunosDoCurso: null })).toBe(false);
  });
});

// Kanban e rodape: com recorte pedido, nenhuma contagem geral sem mapa validado
// para o escopo atual. Comportamento, nao leitura de codigo.
describe("Carteira: estado do recorte para kanban e rodape", () => {
  const COM = { filtroCurso: "Medicina", filtroSemestre: "AMBOS" };
  const SEM = { filtroCurso: "TODOS", filtroSemestre: "AMBOS" };
  const MAPA = { "aluno-1": { aluno_id: "aluno-1", curso: "Medicina" } };
  const ESC_A = "operador-a|0|";
  const ESC_B = "operador-b|0|";

  it("carregamento: recorte pedido sem mapa, com a RPC em curso -> sem dados e mensagem de carga", () => {
    const e = estadoRecorteCursoSemestre({ ...COM, carregando: true, mapa: null, escopoLido: null, escopo: ESC_A });
    expect(e.semDados).toBe(true);
    expect(e.mensagem).toBe(MSG_RECORTE_CARREGANDO);
  });

  it("falha: RPC falhou (mapa nulo, escopo lido igual) -> indisponivel, nunca contagem geral", () => {
    const e = estadoRecorteCursoSemestre({ ...COM, carregando: false, mapa: null, escopoLido: ESC_A, escopo: ESC_A });
    expect(e.semDados).toBe(true);
    expect(e.mensagem).toBe(MSG_RECORTE_INDISPONIVEL);
  });

  it("troca de operador com filtro ativo: mapa do operador A nao vale para B", () => {
    // A recarga de B ainda nao comecou: o mapa de A continua na memoria.
    const e = estadoRecorteCursoSemestre({ ...COM, carregando: false, mapa: MAPA, escopoLido: ESC_A, escopo: ESC_B });
    expect(e.semDados).toBe(true);
    expect(e.mensagem).toBe(MSG_RECORTE_CARREGANDO); // recarga pendente, nao falha
  });

  it("sucesso: mapa validado para o escopo atual libera o recorte", () => {
    const e = estadoRecorteCursoSemestre({ ...COM, carregando: false, mapa: MAPA, escopoLido: ESC_A, escopo: ESC_A });
    expect(e.semDados).toBe(false);
    expect(e.mensagem).toBeNull();
  });

  it("retorno a carteira sem filtros: visualizacao normal, com ou sem mapa, carregando ou nao", () => {
    for (const carregando of [true, false]) {
      for (const mapa of [null, MAPA]) {
        const e = estadoRecorteCursoSemestre({ ...SEM, carregando, mapa, escopoLido: null, escopo: ESC_A });
        expect(e.semDados).toBe(false);
        expect(e.mensagem).toBeNull();
      }
    }
  });
});
