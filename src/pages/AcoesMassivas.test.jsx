// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";

// Dublê só da RPC. O que se prova aqui: a tela diz de quando é o extrato do
// Prime usado para tirar quem já pagou, e a mensagem do registro conta quantos
// saíram por isso. A RELAÇÃO desses alunos não chega à tela de propósito —
// quem consta liquidado não deve nem aparecer.
const rpcMock = vi.fn();
vi.mock("../services/supabase", () => ({
  supabase: {
    rpc: (...a) => rpcMock(...a),
    auth: { getUser: async () => ({ data: { user: { email: "gestao@reativa" } } }) },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
  },
}));
vi.mock("../components/BotaoAtualizar", () => ({
  default: ({ onClick, rotulo }) => <button type="button" onClick={onClick}>{rotulo}</button>,
}));
vi.mock("../components/PenetracaoPorAno", () => ({ default: () => null }));
vi.mock("xlsx", () => ({ utils: { json_to_sheet: () => ({}), book_new: () => ({}), book_append_sheet: () => {} }, writeFile: () => {} }));

import AcoesMassivas from "./AcoesMassivas";

const ELEGIVEL = {
  id: "a1", nome: "Ana ***", situacao_academica: "Matriculado", curso: "EAD", unidade: "CANOAS",
  tem_telefone: true, tem_email: true, telefone_mascarado: "••••1234", email_mascarado: "a•••@x.com",
  data_ultimo_acionamento: null, valor: 1500,
};

let previaExtra = {};
let regExtra = {};

beforeEach(() => {
  previaExtra = { prime_extrato_em: "2026-09-05" };
  regExtra = {};
  rpcMock.mockReset();
  rpcMock.mockImplementation(async (nome, args) => {
    if (nome === "acoes_massivas_filtros") {
      return { data: { unidades: [], cursos: [], situacoes_academicas: ["Matriculado", "Trancado"] } };
    }
    if (nome === "acoes_massivas_borderos") return { data: [] };
    if (nome === "acoes_massivas_previa") {
      return { data: { elegiveis: [ELEGIVEL], excluidos_confirmacao: [], ...previaExtra } };
    }
    if (nome === "registrar_acao_massiva") {
      return {
        data: {
          registrados: 1, ids_registrados: [args.p_aluno_ids[0]], excluidos_confirmacao: 0,
          contatos: [{ aluno_id: "a1", nome: "Ana", telefone: "51999999999", email: "a@x.com" }],
          ...regExtra,
        },
      };
    }
    return { data: null };
  });
});
afterEach(cleanup);

async function montar() {
  await act(async () => { render(<AcoesMassivas />); });
  await screen.findByLabelText("Matriculado");
}
async function buscar() {
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Buscar/ })); });
}
async function gerar() {
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Gerar Excel/ })); });
}

describe("Ações Massivas — liquidados no Prime", () => {
  it("diz a regra e a data do extrato do Prime usado na prévia", async () => {
    await montar();
    await buscar();
    expect(screen.getByText(/Quem já consta liquidado no Prime não entra nesta lista/)).toBeTruthy();
    expect(screen.getByText(/05\/09\/2026/)).toBeTruthy();
  });

  it("sem data de extrato, não inventa a nota", async () => {
    previaExtra = {};
    await montar();
    await buscar();
    expect(screen.queryByText(/liquidado no Prime não entra/)).toBeNull();
  });

  it("o registro conta quantos saíram por já constarem liquidados", async () => {
    regExtra = { excluidos_liquidados_prime: 3 };
    await montar();
    await buscar();
    await gerar();
    expect(screen.getByText(/3 caso\(s\) foram removidos por já constarem liquidados no Prime/)).toBeTruthy();
  });

  it("sem exclusão pelo Prime, a mensagem não menciona o assunto", async () => {
    await montar();
    await buscar();
    await gerar();
    expect(screen.queryByText(/liquidados no Prime\./)).toBeNull();
    expect(screen.getByText(/1 aluno\(s\) registrados/)).toBeTruthy();
  });
});

describe("Ações Massivas — filtro de status acadêmico (multi)", () => {
  it("dois status marcados vão juntos ao banco", async () => {
    await montar();
    fireEvent.click(screen.getByLabelText("Matriculado"));
    fireEvent.click(screen.getByLabelText("Trancado"));
    await buscar();
    const c = rpcMock.mock.calls.filter(([n]) => n === "acoes_massivas_previa").at(-1);
    expect(c[1].p_situacao_academica).toBe("Matriculado|Trancado");
  });
});
