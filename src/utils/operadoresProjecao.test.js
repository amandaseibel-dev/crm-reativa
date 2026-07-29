import { describe, it, expect } from "vitest";
import { podeVerRelatorios, ehEquipe9, EQUIPE_9, EQUIPE_9_EMAILS } from "./operadores";

describe("permissões da Projeção/Relatórios", () => {
  it("Relatórios: só Amanda gestora e Fernanda", () => {
    expect(podeVerRelatorios("amanda.seibel@aelbra.com.br")).toBe(true);
    expect(podeVerRelatorios("cobranca04@aelbra.com.br")).toBe(true);
    // Amanda ADM e operadores NÃO exportam
    expect(podeVerRelatorios("cobranca07@aelbra.com.br")).toBe(false);
    expect(podeVerRelatorios("cobranca13@aelbra.com.br")).toBe(false);
    expect(podeVerRelatorios("painel.tv@reativa.local")).toBe(false);
    expect(podeVerRelatorios("")).toBe(false);
  });

  it("equipe dos 9 = 8 operadores + Amanda ADM, sem Fernanda/painel/gestora", () => {
    expect(EQUIPE_9_EMAILS.length).toBe(9);
    expect(EQUIPE_9.length).toBe(9);
    expect(ehEquipe9("cobranca07@aelbra.com.br")).toBe(true); // Amanda ADM
    expect(ehEquipe9("cobranca13@aelbra.com.br")).toBe(true); // Diego
    expect(ehEquipe9("cobranca04@aelbra.com.br")).toBe(false); // Fernanda
    expect(ehEquipe9("amanda.seibel@aelbra.com.br")).toBe(false); // gestora
    expect(ehEquipe9("painel.tv@reativa.local")).toBe(false);
  });
});
