import { describe, it, expect } from "vitest";
import { conjuntoDoRecorte, listaParaContagem, alunosDoCursoEscolhido, alunosDoSemestreEscolhido } from "./carteiraFila";
import { recorteSemDadosValidados } from "./recorteCursoSemestreVisual";

const mapa = {
  "1": { aluno_id: 1, curso_2026_1: "Medicina", titulos_2026_1: 2, acordo_saldo_2026_1: 0 },
  "2": { aluno_id: 2, curso_2026_1: "Odontologia", titulos_2026_1: 0, acordo_saldo_2026_1: 0 },
};
const todos = ["1", "2"];

// Fluxo real da tela: a flag de recorte sem dados decide o estado; o conjunto e o contador seguem dele.
const estado = (filtroCurso, filtroSemestre, { carregando, mapaValido }) => ({
  recorteSemDados: recorteSemDadosValidados({ filtroCurso, filtroSemestre, carregando, mapaValido }),
});

describe("sem filtro: comportamento original", () => {
  it("curso TODOS e semestre AMBOS nao criam conjunto (null)", () => {
    expect(conjuntoDoRecorte({ escolhido: false, mapaValido: null, calcular: () => new Set(todos) })).toBeNull();
  });

  it("contagem sem filtro usa a lista normal", () => {
    const lista = [{ id: "1" }, { id: "2" }];
    const usada = listaParaContagem({ recorteSemDados: false, filtroPrioridade: "TODAS", listaFiltrada: lista, montarSemPrioridade: () => [] });
    expect(usada).toBe(lista);
  });
});

describe("carregamento, falha e troca de operador: nenhum conjunto do total geral", () => {
  it("carregando com curso escolhido: conjunto vazio, nao o total", () => {
    const { recorteSemDados } = estado("Medicina", "AMBOS", { carregando: true, mapaValido: null });
    const r = conjuntoDoRecorte({ escolhido: true, mapaValido: null, calcular: () => new Set(todos) });
    expect(recorteSemDados).toBe(true);
    expect(r.size).toBe(0);
  });

  it("falha com semestre escolhido: conjunto vazio, nao o total", () => {
    const { recorteSemDados } = estado("TODOS", "2026/1", { carregando: false, mapaValido: null });
    const r = conjuntoDoRecorte({ escolhido: true, mapaValido: null, calcular: () => new Set(todos) });
    expect(recorteSemDados).toBe(true);
    expect(r.size).toBe(0);
  });

  it("troca de operador (mapa do escopo anterior, ja invalido): conjunto vazio", () => {
    // A tela passa mapaValido = null quando o escopo lido nao bate com o atual.
    const r = conjuntoDoRecorte({ escolhido: true, mapaValido: null, calcular: () => new Set(todos) });
    expect(r.size).toBe(0);
  });

  it("contadores por prioridade com recorte sem dados: zero, em qualquer prioridade", () => {
    for (const prioridade of ["TODAS", "CRITICO", "URGENTE"]) {
      const usada = listaParaContagem({
        recorteSemDados: true,
        filtroPrioridade: prioridade,
        listaFiltrada: [{ id: "1" }, { id: "2" }],
        montarSemPrioridade: () => [{ id: "1" }, { id: "2" }],
      });
      expect(usada).toEqual([]);
    }
  });
});

describe("recorte validado: dados do proprio recorte", () => {
  it("curso escolhido com mapa validado devolve somente o recorte", () => {
    const r = conjuntoDoRecorte({
      escolhido: true,
      mapaValido: mapa,
      calcular: (m) => alunosDoCursoEscolhido(m, "Medicina", "AMBOS"),
    });
    expect([...r]).toEqual(["1"]);
  });

  it("semestre escolhido com mapa validado sem titulos no semestre devolve vazio", () => {
    const r = conjuntoDoRecorte({
      escolhido: true,
      mapaValido: mapa,
      calcular: (m) => alunosDoSemestreEscolhido(m, "2026/2"),
    });
    expect(r.size).toBe(0);
  });

  it("contagem com recorte validado usa a lista do recorte", () => {
    const lista = [{ id: "1" }];
    const usada = listaParaContagem({ recorteSemDados: false, filtroPrioridade: "CRITICO", listaFiltrada: lista, montarSemPrioridade: () => [{ id: "1" }, { id: "2" }] });
    expect(usada).toEqual([{ id: "1" }, { id: "2" }]);
  });
});
