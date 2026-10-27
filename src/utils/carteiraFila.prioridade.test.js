// FAIXA DE PRIORIDADE da Minha Carteira (22/10/2026).
//
// O que estas guardas protegem, na ordem do pedido da operacao:
//   1. nenhum caso elegivel desaparece -- as seis faixas particionam a lista;
//   2. "Todos" nunca esconde nada;
//   3. a ordem e Perdendo -> Critico -> Urgente -> Atencao -> Novo -> Normal,
//      sem passar por cima de retorno devido nem da prioridade marcada;
//   4. o numero do chip e o numero de linhas que o clique abre;
//   5. a pesquisa acha por nome, CPF e matricula -- inclusive quem esta fora
//      da fila de trabalho;
//   6. prazo e classificacao continuam sendo DUAS coisas (foi a confusao entre
//      as duas que escondeu os casos).
import { describe, it, expect } from "vitest";
import {
  filtrarCasos,
  montarListaFiltrada,
  ordenarCasos,
  contarPorPrioridade,
  faixaPrioridade,
  rankPrioridadeFaixa,
  FAIXAS_PRIORIDADE,
  PRIORIDADE_LABEL,
  seloPrazo,
} from "./carteiraFila";

const HOJE = "2026-10-22";
const AGORA = Date.parse("2026-10-22T12:00:00Z");

function aluno(extra) {
  return {
    status_atual: "CONTATAR",
    nivel_criticidade: "NORMAL",
    semestre_divida: "2026/1",
    data_retorno: null,
    responsavel_atual_email: "cobranca05@aelbra.com.br",
    ...extra,
  };
}

// Carteira de teste desenhada sobre o que a producao mostrou em 22/10/2026:
// a classificacao do backend e o prazo DISCORDAM na maioria dos casos.
//   p1 PERDENDO, 20 dias parado      -> prazo tambem diz "Perdendo o caso"
//   c1 CRITICO, 8 dias               -> prazo diz "Atencao" (o caso dos 155)
//   c2 CRITICO, 2 dias               -> prazo diz "Dentro do prazo" (os 44)
//   u1 URGENTE, 3 dias               -> prazo diz "Dentro do prazo" (os 1.170)
//   u2 URGENTE, com acordo fechado   -> prazo diz "Aguardando pgto"
//   t1 ATENCAO, 1 dia                -> prazo diz "Dentro do prazo" (os 2.279)
//   n1 NORMAL nunca acionado         -> faixa "Novo"
//   z1 NORMAL, 4 dias                -> faixa "Normal"
const CASOS = [
  aluno({ id: "p1", nome: "Paula Alves", cpf: "11111111111", matricula: "202500011",
          nivel_criticidade: "PERDENDO", data_ultimo_acionamento: "2026-10-02", valor_em_aberto: 900 }),
  aluno({ id: "c1", nome: "Carlos Dias", cpf: "22222222222", matricula: "202500022",
          nivel_criticidade: "CRITICO", data_ultimo_acionamento: "2026-10-14", valor_em_aberto: 800 }),
  aluno({ id: "c2", nome: "Celia Moraes", cpf: "33333333333", matricula: "202500033",
          nivel_criticidade: "CRITICO", data_ultimo_acionamento: "2026-10-20", valor_em_aberto: 700 }),
  aluno({ id: "u1", nome: "Ulisses Prado", cpf: "44444444444", matricula: "202500044",
          nivel_criticidade: "URGENTE", data_ultimo_acionamento: "2026-10-19", valor_em_aberto: 600 }),
  aluno({ id: "u2", nome: "Ursula Lima", cpf: "55555555555", matricula: "202500055",
          nivel_criticidade: "URGENTE", status_atual: "ACORDO_FECHADO",
          data_ultimo_acionamento: "2026-10-18", valor_em_aberto: 500 }),
  aluno({ id: "t1", nome: "Tania Souza", cpf: "66666666666", matricula: "202500066",
          nivel_criticidade: "ATENCAO", data_ultimo_acionamento: "2026-10-21", valor_em_aberto: 400 }),
  aluno({ id: "n1", nome: "Nilo Barros", cpf: "77777777777", matricula: "202500077",
          data_ultimo_acionamento: null, valor_em_aberto: 300 }),
  aluno({ id: "z1", nome: "Zilda Ramos", cpf: "88888888888", matricula: "202500088",
          data_ultimo_acionamento: "2026-10-18", valor_em_aberto: 200 }),
];

const entrada = (extra) => ({ casos: CASOS, hoje: HOJE, agoraMs: AGORA, ordenacao: "prioridade", ...extra });
const ids = (lista) => lista.map((a) => a.id);

describe("faixa de prioridade: nenhum caso elegivel desaparece", () => {
  it("toda a carteira cai em exatamente uma das seis faixas", () => {
    const porFaixa = CASOS.map((a) => faixaPrioridade(a, AGORA));
    expect(porFaixa.every((f) => FAIXAS_PRIORIDADE.includes(f))).toBe(true);
    expect(porFaixa).toEqual(["PERDENDO", "CRITICO", "CRITICO", "URGENTE", "URGENTE", "ATENCAO", "NOVO", "NORMAL"]);
  });

  it("a soma das faixas e o total: ninguem fica de fora e ninguem conta duas vezes", () => {
    const todos = filtrarCasos(entrada());
    const c = contarPorPrioridade(todos, AGORA);
    const soma = FAIXAS_PRIORIDADE.reduce((t, f) => t + c[f], 0);
    expect(soma).toBe(todos.length);
    expect(c.TODOS).toBe(todos.length);
  });

  it("a uniao dos seis filtros devolve exatamente a lista inteira, sem perda e sem repetido", () => {
    const todos = ids(filtrarCasos(entrada()));
    const uniao = [];
    for (const faixa of FAIXAS_PRIORIDADE) {
      uniao.push(...ids(filtrarCasos(entrada({ filtroPrioridade: faixa }))));
    }
    expect(uniao.slice().sort()).toEqual(todos.slice().sort());
    expect(new Set(uniao).size).toBe(uniao.length);
  });

  it('"Todos" (o padrao) nao recorta nada', () => {
    expect(ids(filtrarCasos(entrada({ filtroPrioridade: "TODAS" })))).toEqual(ids(filtrarCasos(entrada())));
    expect(filtrarCasos(entrada()).length).toBe(CASOS.length);
  });

  it("cada faixa devolve so os seus", () => {
    expect(ids(filtrarCasos(entrada({ filtroPrioridade: "URGENTE" })))).toEqual(["u1", "u2"]);
    expect(ids(filtrarCasos(entrada({ filtroPrioridade: "NOVO" })))).toEqual(["n1"]);
    expect(ids(filtrarCasos(entrada({ filtroPrioridade: "NORMAL" })))).toEqual(["z1"]);
  });
});

describe("o numero do chip e o numero de linhas que ele abre", () => {
  it("contagem por faixa bate com o filtro correspondente, com outro filtro ligado junto", () => {
    // Um filtro qualquer ligado por cima: a contagem continua sendo medida
    // sobre o MESMO recorte que o clique vai mostrar.
    const base = entrada({ filtroValorMin: "300" });
    const c = contarPorPrioridade(filtrarCasos(base), AGORA);
    for (const faixa of FAIXAS_PRIORIDADE) {
      expect(filtrarCasos({ ...base, filtroPrioridade: faixa }).length).toBe(c[faixa]);
    }
  });
});

describe("ordenacao por prioridade", () => {
  it("Perdendo -> Critico -> Urgente -> Atencao -> Novo -> Normal", () => {
    const fora = ordenarCasos(filtrarCasos(entrada()), entrada());
    expect(fora.map((a) => faixaPrioridade(a, AGORA))).toEqual([
      "PERDENDO", "CRITICO", "CRITICO", "URGENTE", "URGENTE", "ATENCAO", "NOVO", "NORMAL",
    ]);
  });

  it("o rank segue a ordem pedida, e 'Novo' fica entre Atencao e Normal", () => {
    expect(FAIXAS_PRIORIDADE.map((f) => PRIORIDADE_LABEL[f])).toEqual([
      "Perdendo o caso", "Crítico", "Urgente", "Atenção", "Novo", "Normal",
    ]);
    expect(rankPrioridadeFaixa(CASOS.find((a) => a.id === "n1"), AGORA))
      .toBeGreaterThan(rankPrioridadeFaixa(CASOS.find((a) => a.id === "t1"), AGORA));
    expect(rankPrioridadeFaixa(CASOS.find((a) => a.id === "n1"), AGORA))
      .toBeLessThan(rankPrioridadeFaixa(CASOS.find((a) => a.id === "z1"), AGORA));
  });

  it("compromisso marcado continua mandando: retorno devido sobe na frente da faixa", () => {
    const comRetorno = CASOS.map((a) => (a.id === "z1" ? { ...a, data_retorno: "2026-10-20" } : a));
    const fora = ordenarCasos(filtrarCasos(entrada({ casos: comRetorno })), entrada({ casos: comRetorno }));
    // z1 e NORMAL -- a ultima faixa -- mas tem retorno atrasado: vai para o topo.
    expect(fora[0].id).toBe("z1");
  });

  it("a prioridade marcada pelo operador continua acima de tudo", () => {
    const comMarca = CASOS.map((a) =>
      a.id === "n1" ? { ...a, retorno_prioritario: true, data_retorno: "2026-10-22" } : a
    );
    const fora = ordenarCasos(filtrarCasos(entrada({ casos: comMarca })), entrada({ casos: comMarca }));
    expect(fora[0].id).toBe("n1");
  });

  it("nao perde ninguem ao ordenar", () => {
    const dentro = filtrarCasos(entrada());
    expect(ordenarCasos(dentro, entrada()).length).toBe(dentro.length);
  });
});

describe("prazo e classificacao sao recortes diferentes (a causa do sumico)", () => {
  it("o filtro de PRAZO continua sendo por dias sem acionamento, intocado", () => {
    expect(seloPrazo(CASOS.find((a) => a.id === "c1"), AGORA)).toBe("Atencao");
    expect(seloPrazo(CASOS.find((a) => a.id === "u1"), AGORA)).toBe("Dentro do prazo");
    expect(seloPrazo(CASOS.find((a) => a.id === "t1"), AGORA)).toBe("Dentro do prazo");
  });

  it("CRITICO de classificacao nao cabia no prazo 'Critico' -- agora cabe na faixa", () => {
    // Era isto que a operacao via: filtrar "Critico" devolvia 1 dos 2 CRITICO.
    expect(ids(filtrarCasos(entrada({ filtroStatus: "Critico" })))).toEqual([]);
    expect(ids(filtrarCasos(entrada({ filtroPrioridade: "CRITICO" })))).toEqual(["c1", "c2"]);
  });

  it("ATENCAO de classificacao nao aparecia em prazo 'Atencao' -- la aparecia o CRITICO", () => {
    expect(ids(filtrarCasos(entrada({ filtroStatus: "Atencao" })))).toEqual(["c1"]);
    expect(ids(filtrarCasos(entrada({ filtroPrioridade: "ATENCAO" })))).toEqual(["t1"]);
  });

  it("URGENTE nao tinha recorte nenhum e some atras do status do acordo", () => {
    expect(seloPrazo(CASOS.find((a) => a.id === "u2"), AGORA)).toBe("Aguardando pgto");
    expect(ids(filtrarCasos(entrada({ filtroPrioridade: "URGENTE" })))).toContain("u2");
  });

  it("os dois filtros juntos continuam valendo como interseccao", () => {
    expect(ids(filtrarCasos(entrada({ filtroStatus: "Atencao", filtroPrioridade: "CRITICO" })))).toEqual(["c1"]);
    expect(ids(filtrarCasos(entrada({ filtroStatus: "Atencao", filtroPrioridade: "ATENCAO" })))).toEqual([]);
  });
});

describe("pesquisa por nome, CPF e matricula", () => {
  it("acha por matricula", () => {
    expect(ids(filtrarCasos(entrada({ busca: "202500044" })))).toEqual(["u1"]);
  });

  it("acha por nome sem acento e por CPF pontuado", () => {
    expect(ids(filtrarCasos(entrada({ busca: "tania" })))).toEqual(["t1"]);
    expect(ids(filtrarCasos(entrada({ busca: "666.666.666-66" })))).toEqual(["t1"]);
  });

  it("acha caso DA CARTEIRA que a fila de trabalho nao lista", () => {
    const fora = [aluno({ id: "q1", nome: "Quitado Silva", cpf: "99999999999", matricula: "202500099", _foraDaFila: true })];
    // Sem busca, ele continua fora: a fila de trabalho nao muda.
    expect(ids(filtrarCasos(entrada({ casosForaDaFila: fora })))).not.toContain("q1");
    // Com busca, ele aparece -- era isto que faltava para "poder ser localizado".
    expect(ids(filtrarCasos(entrada({ casosForaDaFila: fora, busca: "202500099" })))).toEqual(["q1"]);
    expect(ids(filtrarCasos(entrada({ casosForaDaFila: fora, busca: "quitado" })))).toEqual(["q1"]);
  });

  it("caso fora da fila nao entra duas vezes se ja estiver na lista", () => {
    const duplicado = [{ ...CASOS[0], _foraDaFila: true }];
    const fora = filtrarCasos(entrada({ casosForaDaFila: duplicado, busca: "paula" }));
    expect(ids(fora)).toEqual(["p1"]);
  });

  it("a lista completa tambem passa pelo recorte final sem perder ninguem", () => {
    expect(montarListaFiltrada(entrada()).length).toBe(CASOS.length);
  });
});
