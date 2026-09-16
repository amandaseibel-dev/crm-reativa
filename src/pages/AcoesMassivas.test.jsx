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

const OPERADORES = [
  { email: "cobranca03@teste.local", nome: "Olga" },
  { email: "cobranca05@teste.local", nome: "Luana" },
];

let previaExtra = {};
let regExtra = {};

beforeEach(() => {
  previaExtra = { prime_extrato_em: "2026-09-05" };
  regExtra = {};
  rpcMock.mockReset();
  rpcMock.mockImplementation(async (nome, args) => {
    if (nome === "acoes_massivas_filtros") {
      return {
        data: {
          unidades: ["CANOAS", "GRAVATAI"], cursos: ["EAD", "PRESENCIAL"],
          situacoes_academicas: ["Matriculado", "Trancado"],
          operadores: OPERADORES,
        },
      };
    }
    if (nome === "acoes_massivas_borderos") {
      return { data: [{ importacao_id: "imp-1", arquivo_nome: "bordero-ead.xlsx", qtd_alunos: 10 }] };
    }
    if (nome === "acoes_massivas_previa") {
      // O banco devolve o recorte que aplicou (NULL = base livre / regra atual).
      return {
        data: {
          elegiveis: [ELEGIVEL], excluidos_confirmacao: [],
          operador_email: args.p_operador_email ?? null, ...previaExtra,
        },
      };
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

describe("Ações Massivas — filtro por operador responsável", () => {
  const ultimaChamada = (nome) => rpcMock.mock.calls.filter(([n]) => n === nome).at(-1)[1];
  const escolherOperador = (email) =>
    fireEvent.change(screen.getByLabelText("Operador responsável"), { target: { value: email } });

  it("lista os operadores do cadastro e começa em Base livre / regra atual", async () => {
    await montar();
    const seletor = screen.getByLabelText("Operador responsável");
    expect(seletor.value).toBe("");
    const opcoes = [...seletor.querySelectorAll("option")].map((o) => [o.value, o.textContent]);
    expect(opcoes).toEqual([
      ["", "Base livre / regra atual"],
      ["cobranca03@teste.local", "Olga (cobranca03@teste.local)"],
      ["cobranca05@teste.local", "Luana (cobranca05@teste.local)"],
    ]);
  });

  it("sem operador, prévia e registro saem exatamente como antes (sem a chave nova)", async () => {
    await montar();
    await buscar();
    const previa = ultimaChamada("acoes_massivas_previa");
    expect("p_operador_email" in previa).toBe(false);
    expect(Object.keys(previa).sort()).toEqual([
      "p_ano_vencimento", "p_apenas_ja_acionado", "p_apenas_nunca_acionado", "p_curso",
      "p_dias_minimo_sem_contato", "p_importacao_ids", "p_limite", "p_matricula",
      "p_situacao_academica", "p_unidade",
    ]);
    expect(screen.getByText(/Sem operador filtrado: base livre \/ regra atual/)).toBeTruthy();
    expect(screen.getByText(/caso\(s\) livre\(s\)/)).toBeTruthy();
    await gerar();
    const reg = ultimaChamada("registrar_acao_massiva");
    expect("p_operador_email" in reg).toBe(false);
    expect(reg.p_arquivo).toMatch(/^acao-massiva-whatsapp-\d{4}-\d{2}-\d{2}\.xlsx$/);
  });

  it("com operador, a prévia manda o e-mail e mostra qual carteira foi filtrada", async () => {
    await montar();
    escolherOperador("cobranca03@teste.local");
    await buscar();
    expect(ultimaChamada("acoes_massivas_previa").p_operador_email).toBe("cobranca03@teste.local");
    expect(screen.getByText(/Operador filtrado:/).textContent).toMatch(/Olga.*cobranca03@teste\.local/);
    expect(screen.getByText(/caso\(s\) da carteira de Olga/)).toBeTruthy();
  });

  it("a geração final usa o mesmo operador da prévia e avisa quem saiu da carteira", async () => {
    regExtra = { excluidos_outro_operador: 2 };
    await montar();
    escolherOperador("cobranca05@teste.local");
    await buscar();
    await gerar();
    const reg = ultimaChamada("registrar_acao_massiva");
    expect(reg.p_operador_email).toBe("cobranca05@teste.local");
    expect(reg.p_aluno_ids).toEqual(["a1"]);
    expect(reg.p_arquivo).toMatch(/^acao-massiva-whatsapp-cobranca05-/);
    expect(screen.getByText(/2 caso\(s\) foram removidos por não estarem mais na carteira do operador selecionado/)).toBeTruthy();
  });

  it("trocar o operador limpa a prévia e não escreve nada", async () => {
    await montar();
    escolherOperador("cobranca03@teste.local");
    await buscar();
    expect(screen.getByRole("button", { name: /Gerar Excel/ })).toBeTruthy();
    const chamadasAntes = rpcMock.mock.calls.length;
    escolherOperador("cobranca05@teste.local");
    expect(screen.queryByRole("button", { name: /Gerar Excel/ })).toBeNull();
    expect(screen.queryByText(/Operador filtrado:/)).toBeNull();
    // nenhuma RPC foi chamada pela troca (nada de registrar/atribuir)
    expect(rpcMock.mock.calls.length).toBe(chamadasAntes);
    escolherOperador("");
    expect(screen.queryByRole("button", { name: /Gerar Excel/ })).toBeNull();
  });

  it("se o banco não confirmar o recorte do operador, nada é listado", async () => {
    previaExtra = { operador_email: null };
    await montar();
    escolherOperador("cobranca03@teste.local");
    await buscar();
    expect(screen.getByText(/o banco não aplicou o filtro de operador/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Gerar Excel/ })).toBeNull();
  });

  it("operador + borderô + só nunca acionados vão juntos ao banco", async () => {
    await montar();
    escolherOperador("cobranca03@teste.local");
    fireEvent.click(await screen.findByLabelText(/bordero-ead/));
    fireEvent.change(screen.getByDisplayValue("Todos"), { target: { value: "nunca" } });
    await buscar();
    const c = ultimaChamada("acoes_massivas_previa");
    expect(c.p_operador_email).toBe("cobranca03@teste.local");
    expect(c.p_importacao_ids).toEqual(["imp-1"]);
    expect(c.p_apenas_nunca_acionado).toBe(true);
  });

  it("operador + unidade + modalidade vão juntos ao banco", async () => {
    await montar();
    escolherOperador("cobranca05@teste.local");
    fireEvent.click(screen.getByLabelText("CANOAS"));
    fireEvent.change(screen.getByDisplayValue("Todas as modalidades"), { target: { value: "EAD" } });
    await buscar();
    const c = ultimaChamada("acoes_massivas_previa");
    expect(c.p_operador_email).toBe("cobranca05@teste.local");
    expect(c.p_unidade).toBe("CANOAS");
    expect(c.p_curso).toBe("EAD");
  });
});
