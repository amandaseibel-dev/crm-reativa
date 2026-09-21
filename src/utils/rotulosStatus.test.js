import { describe, it, expect } from "vitest";
import { rotuloStatus, rotuloStatusComSaldo, MAPA_SITUACAO } from "./rotulosStatus";

describe("rotuloStatus", () => {
  it("troca o enum do banco por texto de gente", () => {
    expect(rotuloStatus("EM_ABERTO")).toBe("Em cobrança");
    expect(rotuloStatus("TERMO_RECEBIDO_LIBERADO")).toBe("Termo liberado");
    expect(rotuloStatus("LINK_PRONTO_PARA_ENVIO")).toBe("Link pronto p/ envio");
  });

  it("status desconhecido nao vaza em CAIXA_ALTA", () => {
    expect(rotuloStatus("ALGUM_STATUS_NOVO")).toBe("Algum status novo");
  });

  it("ACORDO_EM_DIA (escrito pelo encerramento da confirmacao processada) tem rotulo proprio, distinto de Acordo fechado", () => {
    expect(rotuloStatus("ACORDO_EM_DIA")).toBe("Acordo em dia");
    expect(rotuloStatus("ACORDO_FECHADO")).toBe("Acordo fechado");
  });

  it("nao mexe em texto que ja e humano", () => {
    expect(rotuloStatus("A contatar")).toBe("A contatar");
  });

  it("vazio continua vazio", () => {
    expect(rotuloStatus("")).toBe("");
    expect(rotuloStatus(null)).toBe("");
  });
});

describe("rotuloStatusComSaldo — a armadilha do 'Pago'", () => {
  it("so diz Pago com saldo comprovadamente zerado", () => {
    expect(rotuloStatusComSaldo("BAIXA_REALIZADA", true)).toBe("Pago");
  });

  it("com saldo em aberto NAO diz Pago", () => {
    expect(rotuloStatusComSaldo("BAIXA_REALIZADA", false)).toBe("Baixa realizada");
  });

  it("saldo desconhecido NAO diz Pago", () => {
    expect(rotuloStatusComSaldo("BAIXA_REALIZADA", null)).toBe("Baixa realizada");
    expect(rotuloStatusComSaldo("BAIXA_REALIZADA", undefined)).toBe("Baixa realizada");
  });
});

// ---------------------------------------------------------------------------
// A UNIFICACAO DO MAPA (13/09/2026)
//
// Ate aqui existiam DOIS mapas de status: este e uma copia dentro de
// carteiraFila.js (que veio do PainelCarteira). A copia tinha 29 chaves, quatro
// sem acento, e `BAIXA_REALIZADA: "Pago"`.
//
// Este arquivo virou a fonte unica. O teste abaixo trava o DELTA: nenhuma
// chave que a Carteira usava pode ter sumido, e nenhum rotulo pode ter mudado
// de sentido -- com UMA excecao autorizada e nomeada, BAIXA_REALIZADA.
//
// O congelado abaixo foi extraido de `git show main:src/utils/carteiraFila.js`,
// nao digitado de memoria.
// ---------------------------------------------------------------------------
const MAPA_DA_CARTEIRA_ANTES = {
  CONTATAR: "A contatar",
  MENSAGEM_ENVIADA: "Mensagem enviada",
  EM_ATENDIMENTO: "Em atendimento",
  ALUNO_EM_NEGOCIACAO_24H: "Em negociacao",
  RETORNAR_DEPOIS: "Retornar depois",
  SEM_RETORNO: "Sem retorno",
  NAO_LOCALIZADO: "Nao localizado",
  AGUARDANDO_LINK: "Aguardando link",
  SOLICITADO_LINK: "Link solicitado",
  LINK_PRONTO_PARA_ENVIO: "Link pronto p/ envio",
  LINK_ENVIADO_AO_ALUNO: "Link enviado",
  AGUARDANDO_COMPROVANTE: "Aguardando comprovante",
  AGUARDANDO_BAIXA: "Aguardando baixa",
  BAIXA_REALIZADA: "Pago",
  BAIXA_DEVOLVIDA: "Baixa devolvida",
  ACORDO_FECHADO: "Acordo fechado",
  ALEGA_FIES: "Alega FIES",
  ALEGA_CREDIES: "Alega CREDIES",
  ALEGA_FINANCIAMENTO: "Alega financiamento",
  ANTECIPACAO_SEMESTRE: "Antecipacao de semestre",
  AGUARDAR_RETORNO_UNIDADE: "Aguardar retorno da unidade",
  LEMBRETE_PARCELA: "Lembrete de parcela feito",
  TERMO_ENVIADO_ALUNO: "Termo enviado",
  TERMO_ENVIADO_ADM: "Termo no ADM",
  TERMO_RECEBIDO_LIBERADO: "Termo liberado",
  TERMO_REJEITADO: "Termo rejeitado",
  JURIDICO: "Juridico",
  CANCELAMENTO_COBRANCA: "Cancelado",
  SUSPENSAO_COBRANCA: "Suspenso",
};

// A UNICA mudanca de sentido autorizada. Qualquer outra reprova o teste.
const MUDANCA_AUTORIZADA = {
  BAIXA_REALIZADA: { antes: "Pago", depois: "Baixa realizada" },
};

const semAcento = (t) => String(t).normalize("NFD").replace(/[\u0300-\u036f]/g, "");

describe("unificacao do mapa de status — o delta esta travado", () => {
  it("nenhuma chave que a Carteira usava desapareceu", () => {
    const sumiram = Object.keys(MAPA_DA_CARTEIRA_ANTES).filter((k) => !(k in MAPA_SITUACAO));
    expect(sumiram).toEqual([]);
  });

  it("e superconjunto: 29 chaves da Carteira, mais as da ficha", () => {
    expect(Object.keys(MAPA_DA_CARTEIRA_ANTES)).toHaveLength(29);
    expect(Object.keys(MAPA_SITUACAO).length).toBeGreaterThanOrEqual(29);
  });

  it("SO `BAIXA_REALIZADA` mudou de sentido", () => {
    const mudaramDeSentido = Object.entries(MAPA_DA_CARTEIRA_ANTES)
      .filter(([k, antes]) => semAcento(MAPA_SITUACAO[k]) !== semAcento(antes))
      .map(([k]) => k);
    expect(mudaramDeSentido).toEqual(Object.keys(MUDANCA_AUTORIZADA));
  });

  it("a mudanca autorizada e exatamente `Pago` -> `Baixa realizada`", () => {
    const { antes, depois } = MUDANCA_AUTORIZADA.BAIXA_REALIZADA;
    expect(MAPA_DA_CARTEIRA_ANTES.BAIXA_REALIZADA).toBe(antes);
    expect(MAPA_SITUACAO.BAIXA_REALIZADA).toBe(depois);
  });

  it("as demais diferencas sao SO acento — mesma palavra", () => {
    const soAcento = Object.entries(MAPA_DA_CARTEIRA_ANTES)
      .filter(([k, antes]) => MAPA_SITUACAO[k] !== antes && semAcento(MAPA_SITUACAO[k]) === semAcento(antes))
      .map(([k]) => k)
      .sort();
    expect(soAcento).toEqual([
      "ALUNO_EM_NEGOCIACAO_24H",
      "ANTECIPACAO_SEMESTRE",
      "JURIDICO",
      "NAO_LOCALIZADO",
    ]);
    // e o resto e byte a byte igual
    const identicas = Object.entries(MAPA_DA_CARTEIRA_ANTES).filter(([k, antes]) => MAPA_SITUACAO[k] === antes);
    expect(identicas).toHaveLength(24);
  });

  it("o mapa nao afirma `Pago` em lugar nenhum — isso depende de saldo", () => {
    expect(Object.values(MAPA_SITUACAO)).not.toContain("Pago");
  });
});
