import { describe, it, expect } from "vitest";
import { etapaDe, dataEtapa, casaBusca } from "./termosAssinatura";

describe("etapaDe", () => {
  it("cai em NAO_APLICAVEL quando a coluna ainda não existe no banco", () => {
    expect(etapaDe({})).toBe("NAO_APLICAVEL");
    expect(etapaDe({ etapa_assinatura: "INVENTADO" })).toBe("NAO_APLICAVEL");
  });

  it("respeita a etapa gravada", () => {
    expect(etapaDe({ etapa_assinatura: "COMPLETO" })).toBe("COMPLETO");
  });
});

describe("dataEtapa — ordena pela data da PRÓPRIA etapa", () => {
  const base = {
    criado_em: "2026-01-01T00:00:00Z",
    validado_em: "2026-02-01T00:00:00Z",
    assinatura_enviada_em: "2026-03-01T00:00:00Z",
    assinatura_completa_em: "2026-04-01T00:00:00Z",
  };

  it("termo assinado usa a data da assinatura", () => {
    expect(dataEtapa({ ...base, etapa_assinatura: "COMPLETO" }))
      .toBe(new Date(base.assinatura_completa_em).getTime());
  });

  it("aguardando assinaturas usa a data em que saiu", () => {
    expect(dataEtapa({ ...base, etapa_assinatura: "ENVIADO_ASSINATURA" }))
      .toBe(new Date(base.assinatura_enviada_em).getTime());
  });

  it("não verificado usa a data de liberação", () => {
    expect(dataEtapa({ ...base, etapa_assinatura: "NAO_VERIFICADO" }))
      .toBe(new Date(base.validado_em).getTime());
  });

  it("cai no criado_em quando falta o carimbo da etapa", () => {
    expect(dataEtapa({ criado_em: base.criado_em, etapa_assinatura: "COMPLETO" }))
      .toBe(new Date(base.criado_em).getTime());
  });

  it("termo sem data nenhuma vai para o fim, não quebra a ordenação", () => {
    expect(dataEtapa({ etapa_assinatura: "COMPLETO" })).toBe(0);
    expect(dataEtapa({ etapa_assinatura: "COMPLETO", validado_em: "data ruim" })).toBe(0);
  });

  it("mais recentes primeiro coloca o assinado hoje na frente do assinado ontem", () => {
    const hoje = { etapa_assinatura: "COMPLETO", assinatura_completa_em: "2026-08-21T10:00:00Z" };
    const ontem = { etapa_assinatura: "COMPLETO", assinatura_completa_em: "2026-08-20T10:00:00Z" };
    const ordenado = [ontem, hoje].sort((a, b) => dataEtapa(b) - dataEtapa(a));
    expect(ordenado[0]).toBe(hoje);
  });
});

describe("casaBusca", () => {
  const aluno = { aluno_nome: "José Antônio da Silva", aluno_cpf: "123.456.789-00" };

  it("busca vazia não filtra ninguém", () => {
    expect(casaBusca(aluno, "")).toBe(true);
    expect(casaBusca(aluno, "   ")).toBe(true);
  });

  it("acha por nome sem depender de acento nem de maiúscula", () => {
    expect(casaBusca(aluno, "jose antonio")).toBe(true);
    expect(casaBusca(aluno, "SILVA")).toBe(true);
    expect(casaBusca(aluno, "josé")).toBe(true);
  });

  it("acha por pedaço do nome no meio", () => {
    expect(casaBusca(aluno, "antônio da")).toBe(true);
  });

  it("acha por CPF com ou sem pontuação", () => {
    expect(casaBusca(aluno, "123.456.789-00")).toBe(true);
    expect(casaBusca(aluno, "12345678900")).toBe(true);
    expect(casaBusca(aluno, "456789")).toBe(true);
  });

  it("acha CPF gravado sem pontuação quando a ADM digita com", () => {
    expect(casaBusca({ aluno_cpf: "12345678900" }, "123.456")).toBe(true);
  });

  it("não inventa resultado para quem não casa", () => {
    expect(casaBusca(aluno, "maria")).toBe(false);
    expect(casaBusca(aluno, "999")).toBe(false);
  });

  it("aguenta termo sem nome e sem CPF", () => {
    expect(casaBusca({}, "jose")).toBe(false);
    expect(casaBusca(null, "jose")).toBe(false);
  });
});
