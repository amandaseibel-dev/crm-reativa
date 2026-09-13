// @vitest-environment jsdom
//
// O bloco academico abria com ate tres tracos ("—") em aluno sem dado
// importado -- ocupava altura inteira dizendo nada. Estes testes travam os dois
// extremos: com pouco dado ele DIZ que nao tem, e com muito dado nada e
// escondido.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";

const rpcMock = vi.fn();
const maybeSingleMock = vi.fn();
vi.mock("../services/supabase", () => ({
  supabase: {
    rpc: (...a) => rpcMock(...a),
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: () => maybeSingleMock() }) }),
    }),
  },
}));

import DadosAcademicos from "./DadosAcademicos";

// O componente usa `.then()` direto no builder do supabase, entao o dublê
// devolve Promise pronta.
function prepara({ colunas = {}, semestres = [] } = {}) {
  maybeSingleMock.mockImplementation(() => Promise.resolve({ data: colunas }));
  rpcMock.mockImplementation(() => Promise.resolve({ data: semestres }));
}

async function montar(aluno = { id: "a1" }) {
  await act(async () => {
    render(<DadosAcademicos aluno={aluno} />);
  });
}

describe("Dados Acadêmicos", () => {
  beforeEach(() => {
    rpcMock.mockReset();
    maybeSingleMock.mockReset();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  describe("aluno com POUCO dado", () => {
    it("diz que nao ha dado, em vez de mostrar tracos", async () => {
      prepara({ colunas: {} });
      await montar({ id: "a1" });
      expect(screen.getByText("Nenhum dado acadêmico importado")).toBeTruthy();
    });

    it("mantem a Fonte -- e ela que diz de onde o dado viria", async () => {
      prepara({ colunas: {} });
      await montar({ id: "a1" });
      expect(screen.getByText("Fonte")).toBeTruthy();
      expect(screen.getByText("Borderô / base")).toBeTruthy();
    });

    it("nao sobra nenhum `—` na tela", async () => {
      prepara({ colunas: {} });
      await montar({ id: "a1" });
      expect(screen.queryByText("—")).toBeNull();
    });

    it("campo vazio nao vira linha: Modalidade/Estabelecimento/Competencia somem", async () => {
      prepara({ colunas: {} });
      await montar({ id: "a1" });
      expect(screen.queryByText("Modalidade")).toBeNull();
      expect(screen.queryByText("Estabelecimento")).toBeNull();
      expect(screen.queryByText("Competência")).toBeNull();
    });
  });

  // A mensagem de vazio so pode aparecer quando NAO ha informacao academica em
  // lugar nenhum do bloco -- nem no corpo, nem na linha fechada (resumo, contador
  // e chips). Contar so modalidade/estabelecimento/competencia deixava o resumo
  // dizer "Administracao · Matriculado" com o corpo dizendo que nao havia dado.
  describe("a decisao `tem dado` olha TODAS as fontes do bloco", () => {
    const naoDizVazio = () =>
      expect(screen.queryByText("Nenhum dado acadêmico importado")).toBeNull();

    it("(1) so `curso_real` -> NAO diz que esta vazio", async () => {
      prepara({ colunas: { curso_real: "Administração" } });
      await montar({ id: "c1" });
      expect(screen.getByText(/Administração/)).toBeTruthy(); // segue no resumo
      naoDizVazio();
    });

    it("(2) so `situacao_academica` -> NAO diz que esta vazio", async () => {
      prepara({ colunas: { situacao_academica: "Matriculado" } });
      await montar({ id: "c2" });
      expect(screen.getByText(/Matriculado/)).toBeTruthy();
      naoDizVazio();
    });

    it("(3) so matricula -> NAO diz que esta vazio", async () => {
      prepara({ colunas: { matricula: "20231045" } });
      await montar({ id: "c3" });
      expect(screen.getByText("20231045")).toBeTruthy();
      naoDizVazio();
    });

    it("(4) so os chips de semestre -> NAO diz que esta vazio", async () => {
      prepara({
        colunas: {},
        semestres: [{ semestre: "2026/1", status: "Confirmado", cancelado: false, valid_from: "2026-01-01" }],
      });
      await montar({ id: "c4" });
      expect(screen.getByText("2026/1 · Confirmado")).toBeTruthy();
      naoDizVazio();
    });

    it("(5) realmente vazio -> ai sim diz", async () => {
      prepara({ colunas: {}, semestres: [] });
      await montar({ id: "c5" });
      expect(screen.getByText("Nenhum dado acadêmico importado")).toBeTruthy();
    });

    it("curso e situacao NAO sao duplicados no corpo -- seguem so no resumo", async () => {
      prepara({ colunas: { curso_real: "Administração", situacao_academica: "Matriculado" } });
      await montar({ id: "c6" });
      // uma aparicao de cada: a do resumo. O corpo nao ganhou campo novo.
      expect(screen.getAllByText(/Administração/)).toHaveLength(1);
      expect(screen.queryByText("Curso")).toBeNull();
      expect(screen.queryByText("Situação")).toBeNull();
      naoDizVazio();
    });
  });

  describe("aluno com dado PARCIAL", () => {
    it("mostra o que tem e omite so o que falta", async () => {
      prepara({ colunas: { curso: "EAD", unidade: null, academico_atualizado_em: null } });
      await montar({ id: "a2" });
      expect(screen.getByText("Modalidade")).toBeTruthy();
      // "EAD" sai duas vezes de proposito: no resumo da linha fechada (que cai
      // na modalidade quando nao ha curso real) e no campo. Nada disso mudou.
      expect(screen.getAllByText("EAD").length).toBeGreaterThan(0);
      expect(screen.queryByText("Estabelecimento")).toBeNull();
      expect(screen.queryByText("Competência")).toBeNull();
      expect(screen.queryByText("Nenhum dado acadêmico importado")).toBeNull();
      expect(screen.queryByText("—")).toBeNull();
    });
  });

  describe("aluno com MUITO dado", () => {
    const cheio = {
      curso: "EAD",
      curso_real: "Administração",
      situacao_academica: "Matriculado",
      matricula: "20231045",
      unidade: "Canoas",
      academico_atualizado_em: "2026-09-11T12:00:00Z",
    };
    const semestres = [
      { semestre: "2026/1", status: "Confirmado", cancelado: false, valid_from: "2026-01-01" },
      { semestre: "2026/2", status: "Aberto", cancelado: false, valid_from: "2026-07-01" },
      { semestre: "2025/2", status: "Anulado", cancelado: false, valid_from: "2025-07-01" },
    ];

    it("mostra TODOS os quatro campos, nenhum omitido", async () => {
      prepara({ colunas: cheio, semestres });
      await montar({ id: "a3" });
      for (const rot of ["Modalidade", "Estabelecimento", "Competência", "Fonte"]) {
        expect(screen.getByText(rot)).toBeTruthy();
      }
      expect(screen.getByText("EAD")).toBeTruthy();
      expect(screen.getByText("Canoas")).toBeTruthy();
      expect(screen.getByText("Relatório acadêmico")).toBeTruthy();
    });

    it("NAO corta os chips de semestre -- todos continuam na tela", async () => {
      prepara({ colunas: cheio, semestres });
      await montar({ id: "a3" });
      expect(screen.getByText("2026/1 · Confirmado")).toBeTruthy();
      expect(screen.getByText("2026/2 · Aberto")).toBeTruthy();
      expect(screen.getByText("2025/2 · Anulado")).toBeTruthy();
    });

    it("nunca mostra a mensagem de vazio quando ha dado", async () => {
      prepara({ colunas: cheio, semestres });
      await montar({ id: "a3" });
      expect(screen.queryByText("Nenhum dado acadêmico importado")).toBeNull();
    });
  });

  it("o rotulo nao usa opacidade -- opacidade nao e hierarquia, e ilegibilidade", async () => {
    prepara({ colunas: { curso: "EAD" } });
    await montar({ id: "a4" });
    const rot = screen.getByText("Modalidade");
    expect(rot.style.opacity).toBe("");
    expect(rot.style.color).toBeTruthy();
  });
});
