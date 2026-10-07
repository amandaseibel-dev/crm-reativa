// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";

const rpcMock = vi.fn();
vi.mock("../services/supabase", () => ({ supabase: { rpc: (...a) => rpcMock(...a) } }));

import ComparativoSafras from "./ComparativoSafras";

// O comparativo é COMPACTO de propósito: cinco colunas e nada mais. Ele
// substituiu o card "Status acadêmico por safra", que comparava as três safras
// repetindo categoria por categoria a mesma lista acadêmica que a composição do
// saldo já desenha para a safra selecionada.
//
// Reaproveita `carteira_safra_situacoes` — a MESMA RPC do resumo executivo e
// das seis linhas. Nenhuma RPC nova foi criada para este bloco, e é por isso
// que a linha da safra selecionada não pode divergir do topo da página.
const safra = (recorte, entrou, pago, aberto) => ({
  data: {
    recorte,
    situacoes: {
      entrou: { alunos: 100, titulos: 300, valor: entrou },
      pago: { alunos: 10, titulos: 30, valor: pago },
      em_aberto: { alunos: 80, titulos: 250, valor: aberto },
    },
  },
  error: null,
});

const PADRAO = {
  "2024": safra("2024", 5159080.84, 31369.29, 4995634.73),
  "2025": safra("2025", 15197210.88, 338011.03, 14000000.00),
  "2026/1": safra("2026/1", 21710447.29, 6005263.81, 9136169.08),
};

function responder(mapa = PADRAO) {
  rpcMock.mockImplementation((nome, args) => {
    const chave = args.p_ano === "2026" ? "2026/" + args.p_semestre : args.p_ano;
    return Promise.resolve(mapa[chave] || { data: null, error: null });
  });
}

const txt = (el) => el.textContent.replace(/\u00a0/g, " ");
const montar = (props = {}) =>
  act(async () => { render(<ComparativoSafras {...props} />); });

beforeEach(() => { rpcMock.mockReset(); responder(); });
afterEach(() => cleanup());

describe("Comparativo entre safras", () => {
  it("reaproveita a camada da Efetividade — não cria RPC nova para comparar", async () => {
    await montar();
    const nomes = [...new Set(rpcMock.mock.calls.map((c) => c[0]))];
    expect(nomes).toEqual(["carteira_efetividade_ler"]);
    expect(rpcMock).toHaveBeenCalledTimes(3);
  });

  it("tem exatamente as cinco colunas executivas, e nenhuma composição acadêmica", async () => {
    await montar();
    for (const c of ["Safra", "Universo recebido", "Recuperado", "Em aberto", "Efetividade"]) {
      expect(screen.getByText(c)).toBeTruthy();
    }
    expect(screen.queryByText("Formado")).toBeNull();
    expect(screen.queryByText("Status acadêmico")).toBeNull();
  });

  it("a efetividade é o recuperado sobre o universo recebido", async () => {
    await montar();
    // 6.005.263,81 / 21.710.447,29 = 27,7%
    const linha = screen.getByText("2026/1").closest("tr");
    expect(txt(linha)).toContain("R$ 21.710.447,29");
    expect(txt(linha)).toContain("R$ 6.005.263,81");
    expect(txt(linha)).toContain("27,7%");
  });

  it("marca a safra que está em análise acima, sem repetir a análise dela", async () => {
    await montar({ selecionada: "2024" });
    expect(txt(screen.getByText("2024").closest("tr"))).toContain("em análise acima");
    expect(txt(screen.getByText("2025").closest("tr"))).not.toContain("em análise acima");
  });

  it("avisa que aluno não se soma entre safras, por causa de CPF sobreposto", async () => {
    await montar();
    expect(screen.getByText(/Nenhuma coluna se soma entre safras/)).toBeTruthy();
    expect(screen.getByText(/CPFs sobrepostos entre períodos/)).toBeTruthy();
  });

  it("2026/2 fica de fora, e a tela diz por quê", async () => {
    await montar();
    expect(screen.queryByText("2026/2")).toBeNull();
    expect(screen.getByText(/2026\/2 fica fora/)).toBeTruthy();
  });

  it("erro em qualquer safra aparece, sem derrubar o resto da página", async () => {
    responder({ ...PADRAO, "2025": { data: null, error: { message: "Acesso negado." } } });
    await montar();
    expect(screen.getByText(/Não foi possível comparar as safras: Acesso negado/)).toBeTruthy();
  });
});
