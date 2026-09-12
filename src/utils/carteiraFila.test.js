import { describe, it, expect } from "vitest";
import {
  montarListaFiltrada,
  filtrarCasos,
  ordenarCasos,
  snapshotDoGuiado,
  proximoIdDoSnapshot,
  faltamNoSnapshot,
  candidatoSegueValido,
  recorteProntoParaGuiado,
  seloPrazo,
  ORDENACOES,
  CRIT_RANK,
} from "./carteiraFila";

// Relogio fixo: sem isso "dias sem contato" muda de valor a cada dia que passa
// e o teste viraria falso-negativo amanha.
const HOJE = "2026-09-12";
const AGORA = Date.parse("2026-09-12T12:00:00Z");

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

// Carteira de teste. Os dias sem contato sao calculados a partir de AGORA:
//   a1 -> 18 dias (Perdendo o caso)   a2 -> 7 dias (Dentro do prazo)
//   a3 -> 10 dias (Critico)           a4 -> nunca acionado (Novo)
//   a5 -> acionado HOJE (sai da lista de trabalho)
const CASOS = [
  aluno({ id: "a1", nome: "Ana Silva", cpf: "11111111111", valor_em_aberto: 10000,
          data_ultimo_acionamento: "2026-08-25", nivel_criticidade: "PERDENDO" }),
  aluno({ id: "a2", nome: "Bruno Costa", cpf: "22222222222", valor_em_aberto: 50000,
          data_ultimo_acionamento: "2026-09-05" }),
  aluno({ id: "a3", nome: "Carla Dias", cpf: "33333333333", valor_em_aberto: 200,
          data_ultimo_acionamento: "2026-09-02", status_atual: "MENSAGEM_ENVIADA",
          data_retorno: "2026-09-10" }),
  aluno({ id: "a4", nome: "Diego Rocha", cpf: "44444444444", valor_em_aberto: 30000,
          data_ultimo_acionamento: null }),
  aluno({ id: "a5", nome: "Elisa Martins", cpf: "55555555555", valor_em_aberto: 1500,
          data_ultimo_acionamento: HOJE }),
];

function entrada(extra) {
  return { casos: CASOS, hoje: HOJE, agoraMs: AGORA, ordenacao: "inteligente", ...extra };
}

const ids = (lista) => lista.map((a) => String(a.id));

// Simula o guiado de ponta a ponta com as MESMAS funcoes que a tela usa.
// `banco` responde a reconferencia de cada id; `injetarNaListaViva` imita uma
// recarga da carteira acontecendo no meio do guiado.
function percorrerGuiado({ listaVisivel, banco, meuEmail = "cobranca05@aelbra.com.br", acionadosHoje = [] }) {
  const snapshot = snapshotDoGuiado(listaVisivel);
  const feitos = new Set();
  const abertos = [];
  const pulados = [];
  let idAtual = null;
  for (let passo = 0; passo < 100; passo++) {
    const proximo = proximoIdDoSnapshot({ snapshot, feitos, acionadosHoje, idAtual });
    if (!proximo) break;
    const fresco = banco[proximo] === undefined ? listaVisivel.find((a) => String(a.id) === proximo) : banco[proximo];
    const veredito = candidatoSegueValido({ fresco, meuEmail, hoje: HOJE });
    if (!veredito.ok) {
      feitos.add(proximo); // saiu por fora: marca e PASSA AO PROXIMO DA FOTO
      pulados.push([proximo, veredito.motivo]);
      continue;
    }
    abertos.push(proximo);
    feitos.add(proximo); // tabulou
    idAtual = proximo;
  }
  return { snapshot, abertos, pulados };
}

describe("recorte da carteira: filtro separado de ordenacao", () => {
  it("tira da lista de trabalho quem ja foi acionado hoje", () => {
    expect(ids(montarListaFiltrada(entrada()))).not.toContain("a5");
  });

  it("FILTRO 'valor minimo' corta pelo valor em aberto", () => {
    const l = montarListaFiltrada(entrada({ ordenacao: "valor_desc", filtroValorMin: "20.000,00" }));
    expect(ids(l)).toEqual(["a2", "a4"]);
  });

  it("FILTRO 'valor maximo' corta pelo valor em aberto", () => {
    const l = montarListaFiltrada(entrada({ ordenacao: "valor_desc", filtroValorMax: "10.000,00" }));
    expect(ids(l)).toEqual(["a1", "a3"]);
  });

  it("FILTRO de status usa o selo de prazo que a operadora ve", () => {
    expect(seloPrazo(CASOS[0], AGORA)).toBe("Perdendo o caso");
    expect(seloPrazo(CASOS[2], AGORA)).toBe("Critico");
    expect(ids(montarListaFiltrada(entrada({ filtroStatus: "Critico" })))).toEqual(["a3"]);
    expect(ids(montarListaFiltrada(entrada({ filtroStatus: "Novo" })))).toEqual(["a4"]);
  });

  it("FILTRO de tabulacao usa a tabulacao canonica do aluno", () => {
    expect(ids(montarListaFiltrada(entrada({ filtroTabulacao: "MENSAGEM_ENVIADA" })))).toEqual(["a3"]);
  });

  it("FILTRO de ano de vencimento corta pelo conjunto vindo da RPC", () => {
    const l = montarListaFiltrada(entrada({ alunosDoAnoVencimento: new Set(["a1", "a3"]) }));
    expect(ids(l)).toEqual(["a1", "a3"]);
  });

  it("FILTRO 'Foco do Dia' deixa so critico, retorno devido, fixado ou boleto vencendo", () => {
    // a1 e PERDENDO (criticidade canonica); a3 tem retorno atrasado.
    const l = montarListaFiltrada(entrada({ somenteFocoDia: true }));
    expect(ids(l).sort()).toEqual(["a1", "a3"]);
  });

  it("FILTRO 'Fixados' deixa so os fixados (e nao ressuscita quem foi acionado hoje)", () => {
    const l = montarListaFiltrada(entrada({ somenteFixados: true, fixados: new Set(["a2", "a5"]) }));
    expect(ids(l)).toEqual(["a2"]);
  });

  it("FILTRO de card/KPI troca a FONTE da lista: vem do recorte do card, nao da carteira", () => {
    const doCard = [
      CASOS[2],
      aluno({ id: "a9", nome: "Fora da carteira", valor_em_aberto: 777, data_ultimo_acionamento: "2026-09-03" }),
    ];
    const l = montarListaFiltrada(entrada({ filtroKpi: "retornosHoje", casosEspeciais: doCard }));
    expect(ids(l).sort()).toEqual(["a3", "a9"]);
  });

  it("FILTRO de busca acha sem acento e ignora o corte de 'acionado hoje'", () => {
    expect(ids(montarListaFiltrada(entrada({ busca: "bruno" })))).toEqual(["a2"]);
    // a5 foi acionado hoje: fora da lista de trabalho, mas a busca enxerga.
    expect(ids(montarListaFiltrada(entrada({ busca: "elisa" })))).toEqual(["a5"]);
  });

  it("ORDENACAO nao altera o conjunto filtrado, so a sequencia", () => {
    const base = entrada({ filtroValorMin: "1.000,00" });
    const conjuntos = ORDENACOES.map((ordenacao) =>
      ids(montarListaFiltrada({ ...base, ordenacao })).slice().sort().join(",")
    );
    expect(new Set(conjuntos).size).toBe(1);
  });

  it("'Maior valor primeiro' ordena por valor decrescente", () => {
    expect(ids(montarListaFiltrada(entrada({ ordenacao: "valor_desc" })))).toEqual(["a2", "a4", "a1", "a3"]);
  });

  it("'Menor valor primeiro' ordena por valor crescente", () => {
    expect(ids(montarListaFiltrada(entrada({ ordenacao: "valor_asc" })))).toEqual(["a3", "a1", "a4", "a2"]);
  });

  it("fila inteligente segue a faixa do selo de prazo", () => {
    expect(ids(montarListaFiltrada(entrada({ ordenacao: "inteligente" })))).toEqual(["a1", "a3", "a4", "a2"]);
  });

  it("no Foco do Dia a ordenacao por valor manda por cima do re-rank", () => {
    const l = montarListaFiltrada(entrada({ somenteFocoDia: true, ordenacao: "valor_desc" }));
    expect(ids(l)).toEqual(["a1", "a3"]); // 10.000 antes de 200, sem re-rank
  });

  it("valor vem do financeiro consolidado quando existe (o mesmo 'Em aberto' do card)", () => {
    const finAlunos = { a3: { temDetalhe: true, total: 99999 } };
    const l = montarListaFiltrada(entrada({ ordenacao: "valor_desc", finAlunos }));
    expect(ids(l)[0]).toBe("a3");
  });

  it("o rank de criticidade cobre os mesmos niveis do selo da tela", () => {
    expect(Object.keys(CRIT_RANK)).toEqual(["PERDENDO", "CRITICO", "URGENTE", "ATENCAO", "NORMAL"]);
  });
});

describe("acionamento guiado: a foto do recorte", () => {
  it("o guiado NAO troca a ordenacao escolhida: maior valor primeiro continua maior valor primeiro", () => {
    const visivel = montarListaFiltrada(entrada({ ordenacao: "valor_desc" }));
    const { snapshot, abertos } = percorrerGuiado({ listaVisivel: visivel, banco: {} });
    expect(snapshot).toEqual(["a2", "a4", "a1", "a3"]);
    expect(abertos).toEqual(["a2", "a4", "a1", "a3"]);
  });

  it("respeita cada ordenacao escolhida, abrindo na mesma sequencia que a tela mostra", () => {
    for (const ordenacao of ORDENACOES) {
      const visivel = montarListaFiltrada(entrada({ ordenacao }));
      const { abertos } = percorrerGuiado({ listaVisivel: visivel, banco: {} });
      expect(abertos).toEqual(ids(visivel));
    }
  });

  it("INVARIANTE: os ids abertos sao sempre um subconjunto da foto, em qualquer combinacao de filtros", () => {
    const combinacoes = [
      { filtroValorMin: "20.000,00" },
      { filtroStatus: "Critico" },
      { filtroTabulacao: "MENSAGEM_ENVIADA" },
      { alunosDoAnoVencimento: new Set(["a1", "a3"]) },
      { somenteFocoDia: true },
      { somenteFixados: true, fixados: new Set(["a2"]) },
      { busca: "a" },
      { filtroKpi: "retornosHoje", casosEspeciais: [CASOS[1], CASOS[3]] },
    ];
    for (const extra of combinacoes) {
      for (const ordenacao of ORDENACOES) {
        const visivel = montarListaFiltrada(entrada({ ...extra, ordenacao }));
        const visiveisSet = new Set(ids(visivel));
        const { snapshot, abertos } = percorrerGuiado({ listaVisivel: visivel, banco: {} });
        expect(snapshot.every((id) => visiveisSet.has(id))).toBe(true);
        expect(abertos.every((id) => visiveisSet.has(id))).toBe(true);
      }
    }
  });

  it("candidato que DEIXOU DE SER MEU e pulado, sem tirar ninguem de fora da foto", () => {
    const visivel = montarListaFiltrada(entrada({ ordenacao: "valor_desc" }));
    const banco = { a4: { ...CASOS[3], responsavel_atual_email: "cobranca03@aelbra.com.br" } };
    const { snapshot, abertos, pulados } = percorrerGuiado({ listaVisivel: visivel, banco });
    expect(abertos).toEqual(["a2", "a1", "a3"]);
    expect(pulados).toEqual([["a4", "NAO_E_MAIS_MEU"]]);
    expect(abertos.every((id) => snapshot.includes(id))).toBe(true);
  });

  it("candidato que virou NAO ACIONAVEL e pulado", () => {
    const visivel = montarListaFiltrada(entrada({ ordenacao: "valor_desc" }));
    const banco = { a4: { ...CASOS[3], status_atual: "JURIDICO" } };
    const { abertos, pulados } = percorrerGuiado({ listaVisivel: visivel, banco });
    expect(abertos).toEqual(["a2", "a1", "a3"]);
    expect(pulados).toEqual([["a4", "NAO_ACIONAVEL"]]);
  });

  it("candidato que ja foi tabulado hoje por fora e pulado", () => {
    const visivel = montarListaFiltrada(entrada({ ordenacao: "valor_desc" }));
    const banco = { a1: { ...CASOS[0], data_ultimo_acionamento: HOJE } };
    const { abertos, pulados } = percorrerGuiado({ listaVisivel: visivel, banco });
    expect(abertos).toEqual(["a2", "a4", "a3"]);
    expect(pulados).toEqual([["a1", "JA_ACIONADO_HOJE"]]);
  });

  it("candidato que sumiu do banco e pulado", () => {
    const visivel = montarListaFiltrada(entrada({ ordenacao: "valor_desc" }));
    const { abertos, pulados } = percorrerGuiado({ listaVisivel: visivel, banco: { a4: null } });
    expect(abertos).toEqual(["a2", "a1", "a3"]);
    expect(pulados).toEqual([["a4", "NAO_ENCONTRADO"]]);
  });

  it("RECARGA da carteira durante o guiado NAO injeta id novo", () => {
    const visivel = montarListaFiltrada(entrada({ ordenacao: "valor_desc" }));
    const snapshot = snapshotDoGuiado(visivel);
    // Recarga traz um caso novo (reposicao automatica) com valor altissimo --
    // antes ele furava a fila e era aberto pelo guiado.
    const novo = aluno({ id: "a77", nome: "Recem chegado", valor_em_aberto: 999999,
                         data_ultimo_acionamento: "2026-08-01" });
    const listaViva = montarListaFiltrada(entrada({ casos: [...CASOS, novo], ordenacao: "valor_desc" }));
    expect(ids(listaViva)[0]).toBe("a77"); // ele REALMENTE entraria no topo da lista viva
    expect(snapshot).not.toContain("a77"); // mas a foto foi tirada antes
    const feitos = new Set(["a2"]);
    const sequencia = [];
    let idAtual = "a2";
    for (let i = 0; i < 10; i++) {
      const p = proximoIdDoSnapshot({ snapshot, feitos, acionadosHoje: [], idAtual });
      if (!p) break;
      sequencia.push(p);
      feitos.add(p);
      idAtual = p;
    }
    expect(sequencia).toEqual(["a4", "a1", "a3"]);
    expect(sequencia).not.toContain("a77");
  });

  it("quem foi acionado hoje nao volta na foto, e o contador de 'faltam' acompanha", () => {
    const snapshot = ["a2", "a4", "a1", "a3"];
    expect(faltamNoSnapshot({ snapshot, feitos: new Set(["a2"]), acionadosHoje: ["a4"] })).toBe(2);
    expect(proximoIdDoSnapshot({ snapshot, feitos: new Set(["a2"]), acionadosHoje: ["a4"] })).toBe("a1");
  });

  it("a foto nao repete id", () => {
    expect(snapshotDoGuiado([{ id: "x" }, { id: "x" }, { id: "y" }, {}, null])).toEqual(["x", "y"]);
  });
});

describe("'Iniciar acionamento' so libera com o recorte pronto", () => {
  it("indisponivel enquanto o filtro de ANO ainda esta carregando", () => {
    expect(recorteProntoParaGuiado({ filtroAnoVencimento: "2026", alunosDoAnoVencimento: null })).toBe(false);
    expect(recorteProntoParaGuiado({ filtroAnoVencimento: "2026", alunosDoAnoVencimento: new Set(["a1"]) })).toBe(true);
  });

  it("indisponivel enquanto o recorte do card/KPI ainda esta carregando", () => {
    expect(recorteProntoParaGuiado({ filtroKpi: "retornosHoje", casosEspeciais: null })).toBe(false);
    // Pior caso: `casosEspeciais` ainda e o do card ANTERIOR. A lista nao esta
    // vazia, entao `listaFiltrada.length` nao protegia -- o guiado percorreria
    // o card errado.
    expect(recorteProntoParaGuiado({ filtroKpi: "semAcionamento10", casosEspeciais: [{ id: "a3" }], carregandoEspecial: true })).toBe(false);
    expect(recorteProntoParaGuiado({ filtroKpi: "semAcionamento10", casosEspeciais: [{ id: "a3" }], carregandoEspecial: false })).toBe(true);
  });

  it("indisponivel enquanto a carteira inteira esta carregando", () => {
    expect(recorteProntoParaGuiado({ carregando: true })).toBe(false);
  });

  it("disponivel na carteira normal, sem ano e sem card", () => {
    expect(recorteProntoParaGuiado({})).toBe(true);
  });
});

describe("filtrarCasos e ordenarCasos isolados", () => {
  it("filtrarCasos nao ordena", () => {
    const l = filtrarCasos(entrada());
    expect(ids(l)).toEqual(["a1", "a2", "a3", "a4"]); // ordem de entrada
  });

  it("ordenarCasos nao filtra", () => {
    const l = ordenarCasos(CASOS, entrada({ ordenacao: "valor_desc" }));
    expect(l).toHaveLength(CASOS.length);
    expect(ids(l)).toEqual(["a2", "a4", "a1", "a5", "a3"]);
  });
});
