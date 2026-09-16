// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";

// Dublê só da RPC. O que se prova aqui: a tela diz de quando é o extrato do
// Prime usado para tirar quem já pagou, e a mensagem da exportação conta quantos
// saíram por isso. A RELAÇÃO desses alunos não chega à tela de propósito —
// quem consta liquidado não deve nem aparecer. E: exportar a planilha nunca
// registra contato; só "Confirmar ação realizada" registra.
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
let lotes = [];
let concluirExtra = {};

beforeEach(() => {
  previaExtra = { prime_extrato_em: "2026-09-05" };
  regExtra = {};
  lotes = [];
  concluirExtra = {};
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
          operador_email: args.p_operador_email ?? null,
          tipo_cobranca: args.p_tipo_cobranca ?? "REGRA_ANTERIOR",
          contagem_tipo: args.p_tipo_cobranca
            ? { mensalidades: 1, acordos_vencidos: 0, mensalidades_e_acordos_vencidos: 0, total_unico: 1 }
            : null,
          ...previaExtra,
        },
      };
    }
    if (nome === "acoes_massivas_exportar") {
      return {
        data: {
          lote_id: "lote-novo", exportados: 1, ids_exportados: [args.p_aluno_ids[0]], excluidos_confirmacao: 0,
          operador_email: args.p_operador_email ?? null,
          tipo_cobranca: args.p_tipo_cobranca ?? "REGRA_ANTERIOR",
          contatos: [{ aluno_id: "a1", nome: "Ana", telefone: "51999999999", email: "a@x.com" }],
          ...regExtra,
        },
      };
    }
    if (nome === "acoes_massivas_lotes_pendentes") return { data: lotes };
    if (nome === "acoes_massivas_concluir_lote") {
      return { data: { lote_id: args.p_lote_id, registrados: 3, ...concluirExtra } };
    }
    return { data: null };
  });
});
afterEach(cleanup);

// Por padrão escolhe "Somente mensalidades": a tela não busca sem tipo de
// cobrança. `montar({ tipo: null })` deixa sem escolher.
async function montar({ tipo = "MENSALIDADES" } = {}) {
  await act(async () => { render(<AcoesMassivas />); });
  await screen.findByLabelText("Matriculado");
  if (tipo) fireEvent.change(screen.getByLabelText("Tipo de cobrança"), { target: { value: tipo } });
}
async function buscar() {
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Buscar/ })); });
}
async function gerar() {
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Exportar planilha/ })); });
}
const nomesChamados = () => rpcMock.mock.calls.map(([n]) => n);

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

  it("a exportação conta quantos saíram por já constarem liquidados", async () => {
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
    expect(screen.getByText(/Planilha exportada com 1 aluno\(s\)/)).toBeTruthy();
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

  it("sem operador, prévia e exportação não mandam operador", async () => {
    await montar();
    await buscar();
    const previa = ultimaChamada("acoes_massivas_previa");
    expect("p_operador_email" in previa).toBe(false);
    expect(Object.keys(previa).sort()).toEqual([
      "p_ano_vencimento", "p_apenas_ja_acionado", "p_apenas_nunca_acionado", "p_curso",
      "p_dias_minimo_sem_contato", "p_importacao_ids", "p_limite", "p_matricula",
      "p_situacao_academica", "p_tipo_cobranca", "p_unidade",
    ]);
    expect(screen.getByText(/Sem operador filtrado: base livre \/ regra atual/)).toBeTruthy();
    expect(screen.getByText(/caso\(s\) livre\(s\)/)).toBeTruthy();
    await gerar();
    const reg = ultimaChamada("acoes_massivas_exportar");
    expect("p_operador_email" in reg).toBe(false);
    expect(reg.p_arquivo).toMatch(/^acao-massiva-whatsapp-mensalidades-\d{4}-\d{2}-\d{2}\.xlsx$/);
  });

  it("com operador, a prévia manda o e-mail e mostra qual carteira foi filtrada", async () => {
    await montar();
    escolherOperador("cobranca03@teste.local");
    await buscar();
    expect(ultimaChamada("acoes_massivas_previa").p_operador_email).toBe("cobranca03@teste.local");
    expect(screen.getByText(/Operador filtrado:/).textContent).toMatch(/Olga.*cobranca03@teste\.local/);
    expect(screen.getByText(/caso\(s\) da carteira de Olga/)).toBeTruthy();
  });

  it("a exportação usa o mesmo operador da prévia e avisa quem saiu da carteira", async () => {
    regExtra = { excluidos_outro_operador: 2 };
    await montar();
    escolherOperador("cobranca05@teste.local");
    await buscar();
    await gerar();
    const reg = ultimaChamada("acoes_massivas_exportar");
    expect(reg.p_operador_email).toBe("cobranca05@teste.local");
    expect(reg.p_aluno_ids).toEqual(["a1"]);
    expect(reg.p_arquivo).toMatch(/^acao-massiva-whatsapp-cobranca05-/);
    expect(screen.getByText(/2 caso\(s\) foram removidos por não estarem mais na carteira do operador selecionado/)).toBeTruthy();
  });

  it("trocar o operador limpa a prévia e não escreve nada", async () => {
    await montar();
    escolherOperador("cobranca03@teste.local");
    await buscar();
    expect(screen.getByRole("button", { name: /Exportar planilha/ })).toBeTruthy();
    const chamadasAntes = rpcMock.mock.calls.length;
    escolherOperador("cobranca05@teste.local");
    expect(screen.queryByRole("button", { name: /Exportar planilha/ })).toBeNull();
    expect(screen.queryByText(/Operador filtrado:/)).toBeNull();
    // nenhuma RPC foi chamada pela troca (nada de registrar/atribuir)
    expect(rpcMock.mock.calls.length).toBe(chamadasAntes);
    escolherOperador("");
    expect(screen.queryByRole("button", { name: /Exportar planilha/ })).toBeNull();
  });

  it("se o banco não confirmar o recorte do operador, nada é listado", async () => {
    previaExtra = { operador_email: null };
    await montar();
    escolherOperador("cobranca03@teste.local");
    await buscar();
    expect(screen.getByText(/o banco não aplicou o filtro de operador/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Exportar planilha/ })).toBeNull();
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

describe("Ações Massivas — exportar não é contato; confirmar é uma etapa à parte", () => {
  const LOTE = {
    id: "lote-1", canal: "WHATSAPP", operador_email: "cobranca03@teste.local", operador_nome: "Olga",
    arquivo: "acao-massiva-whatsapp-cobranca03-2026-09-16.xlsx", total: 3,
    exportado_por_email: "gestao@reativa", exportado_em: "2026-09-16T14:00:00Z",
  };

  it("exportar só chama a exportação: nenhum registro, nenhuma confirmação", async () => {
    await montar();
    await buscar();
    await gerar();
    expect(nomesChamados()).toContain("acoes_massivas_exportar");
    expect(nomesChamados()).not.toContain("registrar_acao_massiva");
    expect(nomesChamados()).not.toContain("acoes_massivas_concluir_lote");
    expect(screen.getByText(/Nada foi registrado nos alunos/)).toBeTruthy();
    // a lista de lotes abertos é recarregada para mostrar o que falta confirmar
    expect(nomesChamados().filter((n) => n === "acoes_massivas_lotes_pendentes").length).toBe(2);
  });

  it("nenhum caminho da tela chama o registro direto", async () => {
    lotes = [LOTE];
    await montar();
    await buscar();
    await gerar();
    fireEvent.click(await screen.findByRole("button", { name: /Confirmar ação realizada/ }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Sim, o disparo foi concluído/ })); });
    expect(nomesChamados()).not.toContain("registrar_acao_massiva");
  });

  it("confirmar pede o sim explícito antes de chamar o banco", async () => {
    lotes = [LOTE];
    concluirExtra = { excluidos_acionados_apos_exportacao: 1 };
    await montar();
    expect(await screen.findByText("Planilhas exportadas aguardando confirmação")).toBeTruthy();
    expect(screen.getByText("Olga")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Confirmar ação realizada/ }));
    expect(nomesChamados()).not.toContain("acoes_massivas_concluir_lote");
    expect(screen.getByText(/Confirme só se o disparo já foi concluído/)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Sim, o disparo foi concluído/ })); });
    const c = rpcMock.mock.calls.filter(([n]) => n === "acoes_massivas_concluir_lote").at(-1)[1];
    expect(c).toEqual({ p_lote_id: "lote-1", p_acao: "CONFIRMAR" });
    expect(screen.getByText(/Ação confirmada: 3 aluno\(s\) registrados como acionados/)).toBeTruthy();
    expect(screen.getByText(/1 caso\(s\) foram acionados depois da exportação/)).toBeTruthy();
  });

  it("voltar não chama nada; descartar manda DESCARTAR", async () => {
    lotes = [LOTE];
    await montar();
    fireEvent.click(await screen.findByRole("button", { name: /Confirmar ação realizada/ }));
    fireEvent.click(screen.getByRole("button", { name: "Voltar" }));
    expect(nomesChamados()).not.toContain("acoes_massivas_concluir_lote");
    fireEvent.click(screen.getByRole("button", { name: "Descartar" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Sim, descartar/ })); });
    const c = rpcMock.mock.calls.filter(([n]) => n === "acoes_massivas_concluir_lote").at(-1)[1];
    expect(c).toEqual({ p_lote_id: "lote-1", p_acao: "DESCARTAR" });
    expect(screen.getByText(/descartado. Nada foi registrado/)).toBeTruthy();
  });

  it("trocar de operador não esconde os lotes aguardando confirmação", async () => {
    lotes = [LOTE];
    await montar();
    await screen.findByText("Planilhas exportadas aguardando confirmação");
    fireEvent.change(screen.getByLabelText("Operador responsável"), { target: { value: "cobranca05@teste.local" } });
    expect(screen.getByText("Planilhas exportadas aguardando confirmação")).toBeTruthy();
  });

  it("escolher operador NÃO aplica “Sem acionamento há” sozinho; o filtro segue opcional", async () => {
    await montar();
    fireEvent.change(screen.getByLabelText("Operador responsável"), { target: { value: "cobranca03@teste.local" } });
    expect(screen.getByDisplayValue("Qualquer período")).toBeTruthy();
    await buscar();
    expect(ultimaChamadaPrevia().p_dias_minimo_sem_contato).toBeNull();
    // e quem quiser, escolhe
    fireEvent.change(screen.getByDisplayValue("Qualquer período"), { target: { value: "15" } });
    await buscar();
    expect(ultimaChamadaPrevia().p_dias_minimo_sem_contato).toBe(15);
    expect(ultimaChamadaPrevia().p_operador_email).toBe("cobranca03@teste.local");
  });
});

function ultimaChamadaPrevia() {
  return rpcMock.mock.calls.filter(([n]) => n === "acoes_massivas_previa").at(-1)[1];
}

describe("Ações Massivas — filtro Tipo de cobrança", () => {
  const ultima = (nome) => rpcMock.mock.calls.filter(([n]) => n === nome).at(-1)[1];
  const escolherTipo = (valor) =>
    fireEvent.change(screen.getByLabelText("Tipo de cobrança"), { target: { value: valor } });

  it("três opções, sem “Todos”, e nenhuma escolhida no começo", async () => {
    await montar({ tipo: null });
    const sel = screen.getByLabelText("Tipo de cobrança");
    expect(sel.value).toBe("");
    expect([...sel.querySelectorAll("option")].map((o) => [o.value, o.textContent])).toEqual([
      ["", "Selecione o tipo de cobrança"],
      ["MENSALIDADES", "Somente mensalidades"],
      ["ACORDOS_VENCIDOS", "Somente acordos vencidos"],
      ["MENSALIDADES_E_ACORDOS", "Mensalidades e acordos"],
    ]);
    expect(sel.textContent).not.toMatch(/Todos/);
  });

  it("sem tipo escolhido a prévia não é buscada", async () => {
    await montar({ tipo: null });
    await buscar();
    expect(screen.getByText("Escolha o tipo de cobrança antes de buscar a prévia.")).toBeTruthy();
    expect(rpcMock.mock.calls.some(([n]) => n === "acoes_massivas_previa")).toBe(false);
  });

  for (const [valor, rotulo, sufixo] of [
    ["MENSALIDADES", "Somente mensalidades", "-mensalidades-"],
    ["ACORDOS_VENCIDOS", "Somente acordos vencidos", "-acordos-vencidos-"],
    ["MENSALIDADES_E_ACORDOS", "Mensalidades e acordos", "-mensalidades-e-acordos-"],
  ]) {
    it(`${rotulo}: vai na prévia e na exportação, aparece no resumo e no nome do arquivo`, async () => {
      await montar({ tipo: valor });
      await buscar();
      expect(ultima("acoes_massivas_previa").p_tipo_cobranca).toBe(valor);
      expect(screen.getByText(/filtrado/).textContent).toContain(`Tipo de cobrança: ${rotulo}`);
      await gerar();
      const exp = ultima("acoes_massivas_exportar");
      expect(exp.p_tipo_cobranca).toBe(valor);
      expect(exp.p_arquivo).toContain(sufixo);
    });
  }

  it("a prévia mostra a quantidade por tipo e o total único", async () => {
    previaExtra = {
      contagem_tipo: { mensalidades: 1501, acordos_vencidos: 762, mensalidades_e_acordos_vencidos: 281, total_unico: 2263 },
    };
    await montar({ tipo: "MENSALIDADES_E_ACORDOS" });
    await buscar();
    const linha = screen.getByTestId("contagem-tipo").textContent;
    expect(linha).toContain("Mensalidades: 1501");
    expect(linha).toContain("Acordos vencidos: 762");
    expect(linha).toContain("Total único de alunos: 2263");
    expect(linha).toContain("281 dos acordos vencidos também têm mensalidade");
  });

  it("combina com operador, borderô, nunca acionados, unidade, modalidade e prazo", async () => {
    await montar({ tipo: "ACORDOS_VENCIDOS" });
    fireEvent.change(screen.getByLabelText("Operador responsável"), { target: { value: "cobranca03@teste.local" } });
    fireEvent.click(await screen.findByLabelText(/bordero-ead/));
    fireEvent.change(screen.getByDisplayValue("Todos"), { target: { value: "nunca" } });
    fireEvent.click(screen.getByLabelText("CANOAS"));
    fireEvent.change(screen.getByDisplayValue("Todas as modalidades"), { target: { value: "EAD" } });
    fireEvent.change(screen.getByDisplayValue("Qualquer período"), { target: { value: "30" } });
    await buscar();
    expect(ultima("acoes_massivas_previa")).toMatchObject({
      p_tipo_cobranca: "ACORDOS_VENCIDOS", p_operador_email: "cobranca03@teste.local",
      p_importacao_ids: ["imp-1"], p_apenas_nunca_acionado: true, p_unidade: "CANOAS", p_curso: "EAD",
      p_dias_minimo_sem_contato: 30,
    });
    await gerar();
    expect(ultima("acoes_massivas_exportar")).toMatchObject({
      p_tipo_cobranca: "ACORDOS_VENCIDOS", p_operador_email: "cobranca03@teste.local",
    });
  });

  it("trocar o tipo limpa a prévia e a planilha anterior, sem chamar o banco", async () => {
    await montar();
    await buscar();
    await gerar();
    expect(screen.getByRole("button", { name: /Baixar planilha novamente/ })).toBeTruthy();
    const antes = rpcMock.mock.calls.length;
    escolherTipo("ACORDOS_VENCIDOS");
    expect(screen.queryByRole("button", { name: /Exportar planilha/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Baixar planilha novamente/ })).toBeNull();
    expect(screen.queryByTestId("contagem-tipo")).toBeNull();
    expect(rpcMock.mock.calls.length).toBe(antes);
    // a planilha do tipo anterior não volta com a prévia nova
    await buscar();
    expect(screen.getByRole("button", { name: /Exportar planilha/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Baixar planilha novamente/ })).toBeNull();
  });

  it("se o banco não confirmar o tipo aplicado, nada é listado", async () => {
    previaExtra = { tipo_cobranca: "REGRA_ANTERIOR" };
    await montar({ tipo: "ACORDOS_VENCIDOS" });
    await buscar();
    expect(screen.getByText(/o banco não aplicou o tipo de cobrança escolhido/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Exportar planilha/ })).toBeNull();
  });

  it("o lote aguardando confirmação mostra o tipo; a confirmação conta quem saiu do tipo", async () => {
    lotes = [
      {
        id: "lote-9", canal: "WHATSAPP", operador_email: null, operador_nome: null, tipo_cobranca: "ACORDOS_VENCIDOS",
        arquivo: "acao-massiva-whatsapp-acordos-vencidos-2026-09-16.xlsx", total: 4,
        exportado_por_email: "gestao@reativa", exportado_em: "2026-09-16T14:00:00Z",
      },
      {
        id: "lote-8", canal: "WHATSAPP", operador_email: null, operador_nome: null, tipo_cobranca: "REGRA_ANTERIOR",
        arquivo: "acao-massiva-whatsapp-2026-09-16.xlsx", total: 2,
        exportado_por_email: "gestao@reativa", exportado_em: "2026-09-16T13:00:00Z",
      },
    ];
    concluirExtra = { excluidos_tipo_cobranca: 2, tipo_cobranca: "ACORDOS_VENCIDOS" };
    await montar();
    await screen.findByText("Planilhas exportadas aguardando confirmação");
    expect(screen.getByRole("columnheader", { name: "Tipo de cobrança" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "Somente acordos vencidos" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "Sem tipo (tela anterior)" })).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: /Confirmar ação realizada/ })[0]);
    expect(screen.getByText(/não corresponde mais ao tipo de cobrança do lote fica de fora/)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Sim, o disparo foi concluído/ })); });
    expect(screen.getByText(/2 caso\(s\) não correspondem mais ao tipo de cobrança do lote/)).toBeTruthy();
  });
});
