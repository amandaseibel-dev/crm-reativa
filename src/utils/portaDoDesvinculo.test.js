// A regra de QUAL PORTA usar, e os textos da tela. Nenhum banco aqui: é
// comportamento de decisão, testado como decisão.
import { describe, it, expect } from "vitest";
import {
  portaDoDesvinculo, resumoDaCobertura, mensagemDaRecusa,
  PORTA_DESVINCULAR, PORTA_ATRIBUICAO_REMOVER,
} from "./portaDoDesvinculo";

describe("portaDoDesvinculo", () => {
  it("mensalidade NEGOCIADO em acordo vivo sai pela porta de desvincular", () => {
    const r = portaDoDesvinculo({ situacao: "NEGOCIADO", status: "vinculada" });
    expect(r.porta).toBe(PORTA_DESVINCULAR);
    expect(r.motivo).toBe(null);
  });

  it("mensalidade PAGO exige a porta da atribuicao (o caso Rayssa)", () => {
    const r = portaDoDesvinculo({ situacao: "PAGO", status: "quitada" });
    expect(r.porta).toBe(PORTA_ATRIBUICAO_REMOVER);
    expect(r.motivo).toMatch(/desfaz uma quita/i);
  });

  it("basta o status dizer quitada, mesmo com situacao defasada", () => {
    expect(portaDoDesvinculo({ situacao: "ABERTO", status: "quitada" }).porta)
      .toBe(PORTA_ATRIBUICAO_REMOVER);
  });

  it("marca de proveniencia tambem manda pela porta da atribuicao", () => {
    const r = portaDoDesvinculo({ situacao: "NEGOCIADO", status: "vinculada",
      origem_liquidacao: "ACORDO_QUITADO" });
    expect(r.porta).toBe(PORTA_ATRIBUICAO_REMOVER);
  });

  it("encerramento administrativo tambem", () => {
    const r = portaDoDesvinculo({ situacao: "NEGOCIADO", status: "vinculada",
      origem_encerramento: "CONFERENCIA_PRIME_ADMINISTRATIVA" });
    expect(r.porta).toBe(PORTA_ATRIBUICAO_REMOVER);
    expect(r.motivo).toMatch(/administrativ/i);
  });

  it("string vazia em origem_liquidacao nao conta como marca", () => {
    expect(portaDoDesvinculo({ situacao: "NEGOCIADO", status: "vinculada",
      origem_liquidacao: "  " }).porta).toBe(PORTA_DESVINCULAR);
  });

  it("titulo ausente nao quebra e cai no caminho conservador de desvincular", () => {
    expect(portaDoDesvinculo(null).porta).toBe(PORTA_DESVINCULAR);
  });
});

describe("resumoDaCobertura", () => {
  const COBERTURA_RAYSSA = {
    recebido_no_acordo: 3313.09, quitadas_antes: 5739.46, quitadas_depois: 2869.73,
    descoberto_antes: 2426.37, descoberto_depois: -443.36, valor_deste_titulo: 2869.73,
  };

  it("diz os quatro numeros que a gestao confere no Prime", () => {
    const t = resumoDaCobertura(COBERTURA_RAYSSA);
    expect(t).toContain("3.313,09");
    expect(t).toContain("5.739,46");
    expect(t).toContain("2.426,37");
    expect(t).toContain("2.869,73");
  });

  it("descoberto negativo e dito como sobra de cobertura, nao como divida", () => {
    expect(resumoDaCobertura(COBERTURA_RAYSSA)).toContain("passa a sobrar");
    expect(resumoDaCobertura(COBERTURA_RAYSSA)).toContain("443,36");
  });

  it("descoberto que sobra e dito como falta", () => {
    const t = resumoDaCobertura({ ...COBERTURA_RAYSSA, descoberto_depois: 500 });
    expect(t).toContain("ainda restam");
    expect(t).toContain("500,00");
  });

  it("cobertura ausente nao quebra", () => {
    expect(() => resumoDaCobertura(null)).not.toThrow();
  });
});

describe("mensagemDaRecusa", () => {
  it("A TELA DEGRADA SOZINHA quando a E7 nao esta aplicada", () => {
    const m = mensagemDaRecusa(null, { message: 'Could not find the function public.titulo_atribuicao_remover' });
    expect(m).toMatch(/nao foi aplicada|não foi aplicada/i);
    expect(m).toMatch(/Nada foi alterado/);
  });

  it("erro de schema cache tambem degrada", () => {
    expect(mensagemDaRecusa(null, { message: "function ... does not exist" }))
      .toMatch(/não foi aplicada/i);
  });

  it("portao vira frase de gestao ou diretoria", () => {
    expect(mensagemDaRecusa(null, { message: "Retirar atribuicao de mensalidade e decisao da gestao financeira ou da diretoria." }))
      .toMatch(/gestão financeira ou da diretoria/i);
  });

  it("cada recusa da E7 tem frase propria", () => {
    expect(mensagemDaRecusa({ motivo: "LIQUIDACAO_OFICIAL_COMPROVADA" })).toMatch(/liquidada oficialmente/i);
    expect(mensagemDaRecusa({ motivo: "PROVENIENCIA_DE_OUTRO_ACORDO" })).toMatch(/OUTRO acordo/);
    expect(mensagemDaRecusa({ motivo: "TITULO_TEM_PAGAMENTO_PROPRIO" })).toMatch(/cobraria de novo/i);
    expect(mensagemDaRecusa({ motivo: "ACORDO_COBRE_AS_MENSALIDADES" })).toMatch(/Nada a retirar/i);
    expect(mensagemDaRecusa({ motivo: "REMOCAO_NAO_FECHA_A_CONTA" })).toMatch(/não resolve o descoberto/i);
  });

  it("codigo desconhecido aparece, em vez de virar 'erro'", () => {
    expect(mensagemDaRecusa({ motivo: "COISA_NOVA" })).toContain("COISA_NOVA");
  });

  it("sem codigo e sem erro ainda afirma que nada mudou", () => {
    expect(mensagemDaRecusa(null, null)).toMatch(/Nada foi alterado/);
  });
});
