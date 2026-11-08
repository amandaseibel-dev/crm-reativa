import { describe, it, expect } from "vitest";
import {
  EQUIPE_REATIVA,
  SITUACAO_ESPERANDO,
  LIMITE_DIARIO_MENSAGERIA,
  normalizarAtendimento,
  alunoRespondeu,
  doResponsavel,
  naoLidas,
  contarNaoLidas,
  orcamentoSincronizacao,
  amostraSimulada,
} from "./ulbraRespostas";

// Instante fixo e datas DERIVADAS dele. Nada de data absoluta em fixture:
// ela vence e derruba o CI, já aconteceu neste repositório.
const AGORA = 1_800_000_000_000;
const min = (n) => new Date(AGORA - n * 60_000).toISOString();

function item(extra = {}) {
  return normalizarAtendimento({
    id: "a1",
    aluno_id: "aluno-1",
    aluno_nome: "Fulana",
    responsavel_email: "cobranca05@aelbra.com.br",
    situacao: SITUACAO_ESPERANDO,
    equipe: EQUIPE_REATIVA,
    entrou_em: min(60),
    atualizado_em: min(10),
    ...extra,
  });
}

describe("normalizarAtendimento", () => {
  it("aceita o atendimento da equipe Reativa e normaliza o e-mail", () => {
    const r = normalizarAtendimento({
      id: "x",
      equipe: "Reativa",
      responsavel_email: "  Cobranca05@AELBRA.com.br ",
      situacao: "waiting",
    });
    expect(r.atendimento_id).toBe("x");
    expect(r.responsavel_email).toBe("cobranca05@aelbra.com.br");
  });

  it("recusa equipe diferente, inclusive variação de caixa", () => {
    for (const equipe of ["REATIVA", "reativa", "Financeiro", null]) {
      expect(normalizarAtendimento({ id: "x", equipe })).toBeNull();
    }
  });

  it("recusa sem id, e recusa o que não é objeto", () => {
    expect(normalizarAtendimento({ equipe: EQUIPE_REATIVA })).toBeNull();
    expect(normalizarAtendimento(null)).toBeNull();
    expect(normalizarAtendimento("texto")).toBeNull();
  });

  it("aceita os nomes de campo da Mensageria (entrouEm/atualizadoEm)", () => {
    const r = normalizarAtendimento({
      id: "x",
      equipe: EQUIPE_REATIVA,
      cliente: { nome: "Beltrano" },
      entrouEm: min(5),
      atualizadoEm: min(1),
    });
    expect(r.aluno_nome).toBe("Beltrano");
    expect(r.atualizado_em).toBe(min(1));
  });

  it("sem atualizadoEm cai para entrouEm, em vez de ficar sem carimbo", () => {
    const r = normalizarAtendimento({ id: "x", equipe: EQUIPE_REATIVA, entrouEm: min(7) });
    expect(r.atualizado_em).toBe(min(7));
  });
});

describe("alunoRespondeu", () => {
  it("só 'waiting' conta como esperando a Reativa", () => {
    expect(alunoRespondeu(item())).toBe(true);
    for (const s of ["accepted", "done", "expired", "new", null]) {
      expect(alunoRespondeu(item({ situacao: s }))).toBe(false);
    }
  });
});

describe("doResponsavel", () => {
  const lista = [
    item({ id: "meu", responsavel_email: "cobranca05@aelbra.com.br" }),
    item({ id: "alheio", responsavel_email: "cobranca12@aelbra.com.br" }),
  ];

  it("o operador vê só os da própria carteira", () => {
    const r = doResponsavel(lista, { email: "cobranca05@aelbra.com.br" });
    expect(r.map((i) => i.atendimento_id)).toEqual(["meu"]);
  });

  it("casa e-mail ignorando caixa e espaço", () => {
    expect(doResponsavel(lista, { email: " COBRANCA05@aelbra.com.br " })).toHaveLength(1);
  });

  it("a gestão vê todos", () => {
    expect(doResponsavel(lista, { email: "amanda.seibel@aelbra.com.br", gestao: true })).toHaveLength(2);
  });

  it("sem e-mail, item COM responsável conhecido não aparece", () => {
    expect(doResponsavel(lista, {})).toEqual([]);
    expect(doResponsavel(lista, { email: "" })).toEqual([]);
  });

  it("item sem responsável conhecido fica visível — é o formato da ulbra-leads-pendentes de hoje", () => {
    const semDono = [item({ id: "lead", responsavel_email: null })];
    expect(doResponsavel(semDono, { email: "cobranca05@aelbra.com.br" })).toHaveLength(1);
    expect(doResponsavel(semDono, {})).toHaveLength(1);
    expect(doResponsavel(semDono, { gestao: true })).toHaveLength(1);
  });
});

describe("naoLidas", () => {
  it("conta só o que mudou depois do último olhar", () => {
    const lista = [
      item({ id: "novo", atualizado_em: min(2) }),
      item({ id: "velho", atualizado_em: min(90) }),
    ];
    const r = naoLidas(lista, { vistoEm: min(30) });
    expect(r.map((i) => i.atendimento_id)).toEqual(["novo"]);
  });

  it("sem marcador de leitura devolve tudo — melhor avisar demais que engolir", () => {
    expect(naoLidas([item(), item({ id: "b" })], {})).toHaveLength(2);
  });

  it("o que não está esperando a Reativa nunca entra, por mais recente que seja", () => {
    const lista = [item({ id: "aceito", situacao: "accepted", atualizado_em: min(1) })];
    expect(naoLidas(lista, { vistoEm: min(60) })).toEqual([]);
  });

  it("empate no carimbo não conta: visto é visto", () => {
    const quando = min(5);
    expect(naoLidas([item({ atualizado_em: quando })], { vistoEm: quando })).toEqual([]);
  });

  it("carimbo inválido não vira aviso", () => {
    expect(naoLidas([item({ atualizado_em: "nao-e-data" })], { vistoEm: min(60) })).toEqual([]);
  });
});

describe("contarNaoLidas", () => {
  it("combina carteira e marcador de leitura", () => {
    const lista = [
      item({ id: "meu-novo", responsavel_email: "cobranca05@aelbra.com.br", atualizado_em: min(2) }),
      item({ id: "meu-velho", responsavel_email: "cobranca05@aelbra.com.br", atualizado_em: min(99) }),
      item({ id: "alheio-novo", responsavel_email: "cobranca12@aelbra.com.br", atualizado_em: min(1) }),
    ];
    expect(contarNaoLidas(lista, { email: "cobranca05@aelbra.com.br", vistoEm: min(30) })).toBe(1);
    expect(contarNaoLidas(lista, { email: "amanda.seibel@aelbra.com.br", gestao: true, vistoEm: min(30) })).toBe(2);
  });
});

describe("orcamentoSincronizacao", () => {
  it("10 em 10 min por 12h cabe com folga larga", () => {
    const o = orcamentoSincronizacao({ intervaloMin: 10, horasPorDia: 12 });
    expect(o.sincronizacao).toBe(72);
    expect(o.cabe).toBe(true);
    expect(o.folga).toBe(LIMITE_DIARIO_MENSAGERIA - 72);
  });

  it("cada abertura de ficha custa 2: ulbra-consultar + ulbra-atendimento", () => {
    const o = orcamentoSincronizacao({ intervaloMin: 10, horasPorDia: 12, aberturasFicha: 100 });
    expect(o.fichas).toBe(200);
    expect(o.total).toBe(272);
    expect(o.cabe).toBe(true);
  });

  it("1 em 1 minuto estoura o dia sozinho — é o motivo de o polling de 60s nunca ter sido ligado", () => {
    const o = orcamentoSincronizacao({ intervaloMin: 1, horasPorDia: 12 });
    expect(o.sincronizacao).toBe(720);
    expect(o.cabe).toBe(false);
  });

  it("o teto é o limite medido da Mensageria", () => {
    expect(orcamentoSincronizacao().limiteDiario).toBe(500);
  });
});

describe("amostraSimulada", () => {
  it("devolve só equipe Reativa, com duas esperando", () => {
    const a = amostraSimulada(AGORA);
    expect(a).toHaveLength(3); // a de outra equipe caiu na normalização
    expect(a.filter(alunoRespondeu)).toHaveLength(2);
  });

  it("as datas acompanham o `agora` recebido — não envelhecem", () => {
    const a = amostraSimulada(AGORA);
    const b = amostraSimulada(AGORA + 86_400_000);
    expect(a[0].atualizado_em).not.toBe(b[0].atualizado_em);
    expect(contarNaoLidas(b, { email: "cobranca05@aelbra.com.br", vistoEm: new Date(AGORA).toISOString() })).toBe(2);
  });
});
