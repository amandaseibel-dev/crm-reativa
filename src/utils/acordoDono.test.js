import { describe, it, expect } from "vitest";
import {
  donoDoAcordo,
  acumularDonos,
  rotuloDonosDoAcordo,
  qtdQuebrados,
  vencidoQuebrado,
  ESTADO_QUEBRADO,
} from "./acordoDono";

const nomes = {
  "cobranca03@aelbra.com.br": "Olga",
  "cobranca05@aelbra.com.br": "Luana",
  "painel.tv@reativa.local": "Painel TV",
};
const nomePorEmail = (e) => nomes[e] || e;

describe("dono do acordo", () => {
  it("normaliza o e-mail do responsavel do ACORDO", () => {
    expect(donoDoAcordo({ operador_responsavel_email: "  Cobranca03@Aelbra.com.BR " })).toBe("cobranca03@aelbra.com.br");
  });

  it("responsavel vazio/nulo = SEM RESPONSAVEL, nunca herda a ficha", () => {
    expect(donoDoAcordo({ operador_responsavel_email: null })).toBeNull();
    expect(donoDoAcordo({ operador_responsavel_email: "   " })).toBeNull();
    // mesmo com a ficha preenchida no mesmo objeto, o dono do acordo e null
    expect(donoDoAcordo({ operador_responsavel_email: "", responsavel_atual_email: "cobranca05@aelbra.com.br" })).toBeNull();
  });

  it("acumula mais de um dono por aluno e marca o sem responsavel separado", () => {
    let fa = acumularDonos(null, { operador_responsavel_email: "cobranca03@aelbra.com.br" });
    fa = acumularDonos(fa, { operador_responsavel_email: "cobranca05@aelbra.com.br" });
    fa = acumularDonos(fa, { operador_responsavel_email: null });
    expect([...fa.donos].sort()).toEqual(["cobranca03@aelbra.com.br", "cobranca05@aelbra.com.br"]);
    expect(fa.semResponsavel).toBe(true);
  });
});

describe("rotulo na linha da carteira", () => {
  const fa = (donos, sem = false) => ({ acordoDonos: new Set(donos), acordoSemResponsavel: sem });

  it("cala quando o acordo e de quem tem a ficha", () => {
    expect(rotuloDonosDoAcordo(fa(["cobranca05@aelbra.com.br"]), "Luana", nomePorEmail)).toBeNull();
  });

  it("DIRECAO INVERSA: ficha da Luana, acordo da Olga -- a linha diz Olga", () => {
    expect(rotuloDonosDoAcordo(fa(["cobranca03@aelbra.com.br"]), "Luana", nomePorEmail)).toBe("Olga");
  });

  it("acordo SEM RESPONSAVEL e dito em voz alta, mesmo com a ficha preenchida", () => {
    // Era exatamente aqui que a operadora lia o responsavel da ficha como dono
    // do acordo: a linha nao dizia nada.
    expect(rotuloDonosDoAcordo(fa([], true), "Luana", nomePorEmail)).toBe("sem responsável");
  });

  it("aluno com dois acordos de donos diferentes mostra os dois", () => {
    expect(rotuloDonosDoAcordo(fa(["cobranca03@aelbra.com.br"], true), "Luana", nomePorEmail))
      .toBe("Olga, sem responsável");
  });

  it("sem acordo nenhum, nada a dizer", () => {
    expect(rotuloDonosDoAcordo(fa([]), "Luana", nomePorEmail)).toBeNull();
    expect(rotuloDonosDoAcordo(null, "Luana", nomePorEmail)).toBeNull();
  });

  it("conta tecnica aparece pelo que e, sem virar da operadora da ficha", () => {
    expect(rotuloDonosDoAcordo(fa(["painel.tv@reativa.local"]), "Olga", nomePorEmail)).toBe("Painel TV");
  });
});

describe("vocabulario do estado quebrado", () => {
  it("o valor tecnico e o que a RPC de detalhe exige", () => {
    expect(ESTADO_QUEBRADO).toBe("QUEBRADO");
  });

  it("le a chave nova `quebrados`", () => {
    expect(qtdQuebrados({ quebrados: 7, a_renegociar: 7 })).toBe(7);
    expect(vencidoQuebrado({ vencido_quebrado: 10.5 })).toBe(10.5);
  });

  it("aceita o apelido antigo enquanto a migration nao foi aplicada", () => {
    expect(qtdQuebrados({ a_renegociar: 3 })).toBe(3);
    expect(vencidoQuebrado({ vencido_renegociar: 99 })).toBe(99);
  });

  it("zero e zero, nao NaN", () => {
    expect(qtdQuebrados({})).toBe(0);
    expect(qtdQuebrados(null)).toBe(0);
    expect(vencidoQuebrado(undefined)).toBe(0);
  });
});
