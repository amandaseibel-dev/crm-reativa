import { describe, expect, it } from "vitest";
import { recorteSemDadosValidados } from "./recorteCursoSemestreVisual";

const MAPA = { "aluno-1": { aluno_id: "aluno-1", curso: "MEDICINA", semestre: "2026/2" } };
const COM_RECORTE = { filtroCurso: "MEDICINA", filtroSemestre: "AMBOS" };
const SEM_RECORTE = { filtroCurso: "TODOS", filtroSemestre: "AMBOS" };

describe("recorteSemDadosValidados", () => {
  it("carregamento: recorte escolhido sem mapa validado nao mostra contagem geral", () => {
    expect(recorteSemDadosValidados({ ...COM_RECORTE, carregando: true, mapaValido: null })).toBe(true);
    expect(recorteSemDadosValidados({ ...COM_RECORTE, carregando: true, mapaValido: MAPA })).toBe(true);
  });

  it("falha: RPC falhou (mapa validado nulo) e o recorte continua escolhido", () => {
    expect(recorteSemDadosValidados({ ...COM_RECORTE, carregando: false, mapaValido: null })).toBe(true);
  });

  it("troca de operador com filtro ativo: mapa do operador anterior nao vale no escopo novo", () => {
    // O componente passa o mapa VALIDADO por escopo: fora do escopo lido, vira null.
    expect(recorteSemDadosValidados({ filtroCurso: "MEDICINA", filtroSemestre: "2026/2", carregando: false, mapaValido: null })).toBe(true);
  });

  it("sucesso: mapa validado presente libera a visualizacao normal do recorte", () => {
    expect(recorteSemDadosValidados({ ...COM_RECORTE, carregando: false, mapaValido: MAPA })).toBe(false);
  });

  it("retorno a carteira sem filtros: visualizacao normal, com ou sem mapa", () => {
    expect(recorteSemDadosValidados({ ...SEM_RECORTE, carregando: false, mapaValido: null })).toBe(false);
    expect(recorteSemDadosValidados({ ...SEM_RECORTE, carregando: true, mapaValido: null })).toBe(false);
    expect(recorteSemDadosValidados({ ...SEM_RECORTE, carregando: false, mapaValido: MAPA })).toBe(false);
  });

  it("nenhum dado de outro operador: sem mapa validado, o recorte nunca vira contagem", () => {
    for (const carregando of [true, false]) {
      expect(recorteSemDadosValidados({ ...COM_RECORTE, carregando, mapaValido: undefined })).toBe(true);
    }
  });
});
