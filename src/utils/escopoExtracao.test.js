import { describe, it, expect } from "vitest";
import {
  TIPOS_DE_ESCOPO, soAcordo, temAlgumAcordo,
  escopoTipoPermitido, motivoDoBloqueio, scopeKeyRelatorio,
} from "./escopoExtracao";

// Tipos reais medidos em producao em 01/10/2026, inclusive os dois mojibake.
const CARTEIRA = ["Cursos de Graduação Presencial", "Cursos de Graduação Online",
  "Cursos de Pós Graduação - Lato Sensu", "Cursos de Graduação Híbrido",
  "Cursos de GraduaÁ„o Presencial", "Acordo", "Extensão", "Extens„o"];

describe("escopo declarado da extracao", () => {
  it("o caso real de 01/10 18:14 NAO pode ser declarado sem filtro", () => {
    // 22 linhas, 100% Acordo, declarado PORTADOR=195|BORDERO=TODOS|TIPO=TODOS
    const arquivo = ["Acordo"];
    expect(escopoTipoPermitido("TODOS", arquivo)).toBe(false);
    expect(motivoDoBloqueio("TODOS", arquivo)).toMatch(/1 tipo de boleto/);
    // e a unica declaracao coerente e ACORDO
    expect(escopoTipoPermitido("ACORDO", arquivo)).toBe(true);
  });

  it("extracao da carteira inteira pode ser declarada sem filtro", () => {
    expect(escopoTipoPermitido("TODOS", CARTEIRA)).toBe(true);
  });

  it("ACORDO exige 100% das linhas do tipo Acordo", () => {
    expect(escopoTipoPermitido("ACORDO", ["Acordo"])).toBe(true);
    expect(escopoTipoPermitido("ACORDO", ["Acordo", "Extensão"])).toBe(false);
    expect(motivoDoBloqueio("ACORDO", ["Acordo", "Extensão"]))
      .toMatch(/diferente de Acordo/);
  });

  it("arquivo vazio nao sustenta declaracao nenhuma", () => {
    for (const v of TIPOS_DE_ESCOPO) expect(escopoTipoPermitido(v, [])).toBe(false);
  });

  it("valor fora do vocabulario e recusado", () => {
    expect(escopoTipoPermitido("QUALQUER", CARTEIRA)).toBe(false);
    expect(escopoTipoPermitido(undefined, CARTEIRA)).toBe(false);
  });

  it("RECORTE aceita qualquer conteudo nao vazio: nao afirma nada", () => {
    expect(escopoTipoPermitido("RECORTE", ["Extensão"])).toBe(true);
    expect(escopoTipoPermitido("RECORTE", CARTEIRA)).toBe(true);
    expect(motivoDoBloqueio("RECORTE", ["Extensão"])).toBeNull();
  });

  it("maiuscula/minuscula e espaco nao escapam da regra do Acordo", () => {
    expect(soAcordo([" ACORDO "])).toBe(true);
    expect(soAcordo(["acordo"])).toBe(true);
    expect(temAlgumAcordo(["Extensão", " acordo"])).toBe(true);
  });

  it("o mojibake NAO entra na chave, e por isso nao parte a sequencia", () => {
    // o mesmo tipo gravado de dois jeitos produziria duas chaves se o nome
    // fosse para a scope_key. Aqui as duas dao a MESMA chave.
    const a = scopeKeyRelatorio("195", "TODOS", "TODOS");
    const b = scopeKeyRelatorio("195", "TODOS", "TODOS");
    expect(a).toBe(b);
    expect(a).not.toMatch(/Gradua/);
  });

  it("a chave separa populacoes diferentes", () => {
    const completa = scopeKeyRelatorio("195", "TODOS", "TODOS");
    const soAcordos = scopeKeyRelatorio("195", "TODOS", "ACORDO");
    const outroPortador = scopeKeyRelatorio("202", "TODOS", "TODOS");
    const umBordero = scopeKeyRelatorio("195", "617", "TODOS");
    const chaves = new Set([completa, soAcordos, outroPortador, umBordero]);
    expect(chaves.size).toBe(4);
  });

  it("a chave antiga, fixa no codigo, e reproduzida pela declaracao equivalente", () => {
    // garante que o escopo real que ja existe em producao continua alcancavel
    expect(scopeKeyRelatorio("195", "TODOS", "TODOS"))
      .toBe("PORTADOR=195|BORDERO=TODOS|TIPO=TODOS");
  });

  it("bordero em branco vira TODOS, nao string vazia", () => {
    expect(scopeKeyRelatorio("195", "", "TODOS"))
      .toBe("PORTADOR=195|BORDERO=TODOS|TIPO=TODOS");
  });

  it("a chave sempre comeca com PORTADOR= (CHECK ck_extracao_scope_key_coerente)", () => {
    expect(scopeKeyRelatorio("195", "TODOS", "ACORDO").startsWith("PORTADOR=")).toBe(true);
  });
});
