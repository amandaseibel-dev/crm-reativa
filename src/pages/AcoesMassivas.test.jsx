// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup, within, waitFor } from "@testing-library/react";

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
let propsPenetracao = null;
vi.mock("../components/PenetracaoPorAno", () => ({ default: (p) => { propsPenetracao = p; return null; } }));
// Guarda as linhas que a tela mandou para a planilha: é o que prova o conteúdo
// exportado sem precisar abrir um .xlsx de verdade.
let linhasPlanilha = null;
vi.mock("xlsx", () => ({
  utils: {
    json_to_sheet: (linhas) => { linhasPlanilha = linhas; return {}; },
    book_new: () => ({}),
    book_append_sheet: () => {},
  },
  writeFile: () => {},
}));

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

// acoes_massivas_responsaveis: quem TEM caso ou acordo. Inclui o que
// acoes_massivas_filtros nunca trouxe, porque só lista `ativo and
// perfil='operador'`: a Olga desligada, a gestão e a Carteira Geral.
const RESPONSAVEIS = [
  { email: "SEM_RESPONSAVEL", nome: "Sem responsável", classe: "SEM_RESPONSAVEL", casos: 13, acordos: 34, acordos_ativos: 4 },
  { email: "cobranca05@teste.local", nome: "Luana", classe: "OPERADOR_ATIVO", casos: 234, acordos: 40, acordos_ativos: 33 },
  { email: "cobranca03@teste.local", nome: "Olga", classe: "INATIVO", casos: 681, acordos: 130, acordos_ativos: 119 },
  { email: "amanda.seibel@teste.local", nome: "Amanda Gestora", classe: "NAO_OPERADOR", casos: 11, acordos: 753, acordos_ativos: 653 },
  { email: "carteira.geral@reativa.local", nome: "Carteira Geral", classe: "CARTEIRA_GERAL", casos: 8, acordos: 189, acordos_ativos: 150 },
];

let previaExtra = {};
let resumoExtra = {};
let regExtra = {};
let lotes = [];
let concluirExtra = {};
let lotesWhats = [];
let emailDoLote = null;

beforeEach(() => {
  previaExtra = { prime_extrato_em: "2026-09-05" };
  resumoExtra = {};
  regExtra = {};
  lotes = [];
  concluirExtra = {};
  lotesWhats = [];
  emailDoLote = null;
  linhasPlanilha = null;
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
    if (nome === "acoes_massivas_responsaveis") {
      return { data: RESPONSAVEIS };
    }
    if (nome === "acoes_massivas_borderos") {
      return { data: [{ importacao_id: "imp-1", arquivo_nome: "bordero-ead.xlsx", qtd_alunos: 10 }] };
    }
    if (nome === "acoes_massivas_previa") {
      // O banco devolve o recorte que aplicou (NULL = base livre / regra atual).
      return {
        data: {
          elegiveis: [ELEGIVEL], excluidos_confirmacao: [],
          // o banco devolve o recorte em minúsculas ('todos' | 'livres' | e-mail)
          operador_email: String(args.p_operador_email ?? "").toLowerCase(),
          tipo_cobranca: args.p_tipo_cobranca ?? "REGRA_ANTERIOR",
          previa_id: "previa-1",
          resumo: {
            solicitado: args.p_limite, universo_base: 10, disponiveis: 4, elegiveis: 1, fora_do_filtro_acionamento: 0,
            selecionado: 1, indisponiveis: 6, motivos: { quitado: 4, acao_massiva_recente: 2 },
            com_responsavel: 0, com_fidelizacao_ativa: 0, menos_que_solicitado: false,
            filtros: { valor_min: args.p_valor_min, valor_max: args.p_valor_max, recencia_dias: args.p_recencia_dias, acionamento: args.p_acionamento, canal: args.p_canal },
            ...resumoExtra,
          },
          total_elegivel_filtros: 1,
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
          lote_id: "lote-novo", exportados: 1, selecionados: 1, registrados: 1, registro_automatico: true,
          enviados: null, falhas_envio: null,
          ids_exportados: [args.p_aluno_ids[0]], excluidos_confirmacao: 0,
          operador_email: args.p_operador_email ?? null,
          tipo_cobranca: args.p_tipo_cobranca ?? "REGRA_ANTERIOR",
          contatos: [{ aluno_id: "a1", nome: "Ana", telefone: "51999999999", email: "a@x.com" }],
          ...regExtra,
        },
      };
    }
    if (nome === "acoes_massivas_lotes_pendentes") return { data: lotes };
    if (nome === "acoes_massivas_lotes_whatsapp") return { data: lotesWhats };
    if (nome === "acoes_massivas_exportar_emails_do_lote") {
      if (emailDoLote?.erro) return { data: null, error: new Error(emailDoLote.erro) };
      return {
        data: {
          lote_id: "lote-email-1",
          lote_origem_id: args.p_lote_id,
          arquivo: args.p_arquivo,
          total_lote_whatsapp: 10,
          com_email: 7,
          sem_email: 3,
          registrados: 7,
          contatos: [{ aluno_id: "a1", nome: "Ana", email: "a@x.com" }],
          ids_excluidos: [],
          ...(emailDoLote || {}),
        },
      };
    }
    if (nome === "acoes_massivas_concluir_lote") {
      return { data: { lote_id: args.p_lote_id, registrados: 3, ...concluirExtra } };
    }
    return { data: null };
  });
});
afterEach(cleanup);

// Por padrão escolhe "Somente mensalidades": a tela não busca sem tipo de
// cobrança. `montar({ tipo: null })` deixa sem escolher.
async function montar({ tipo = "MENSALIDADES", responsavel = "SEM_RESPONSAVEL",
                        donoAcordo = "amanda.seibel@teste.local" } = {}) {
  await act(async () => { render(<AcoesMassivas />); });
  await screen.findByLabelText("Matriculado");
  await screen.findByTestId("resp-caso");
  // O default antigo era o <select> em "LIVRES"; o equivalente agora e marcar
  // "Sem responsável". A acao em massa nao gera previa sem recorte explicito,
  // entao sem isto todo teste que gera previa cairia na guarda.
  if (responsavel) {
    await act(async () => { fireEvent.click(document.getElementById(`resp-caso-${responsavel}`)); });
  }
  if (tipo) await escolherTipo(tipo, { donoAcordo });
}
// O controle deixou de ser <select> e virou lista de marcação, com duas
// dimensões independentes. Marcar é o equivalente a escolher.
function escolherOperador(email) {
  // tira o "Sem responsável" que `montar` marcou, para o recorte ser só dele
  const livre = document.getElementById("resp-caso-SEM_RESPONSAVEL");
  if (livre?.checked) fireEvent.click(livre);
  fireEvent.click(document.getElementById(`resp-caso-${email}`));
}
function escolherDonoAcordo(email) {
  fireEvent.click(document.getElementById(`resp-acordo-${email}`));
}

// Trocar a modalidade pode passar a exigir dono de acordo. Este ajudante marca
// um por padrão, para o teste seguir sendo sobre o seu assunto; passe
// `donoAcordo: null` quando o assunto FOR a exigência.
async function escolherTipo(tipo, { donoAcordo = "amanda.seibel@teste.local" } = {}) {
  await act(async () => {
    fireEvent.change(screen.getByLabelText("Tipo de cobrança"), { target: { value: tipo } });
  });
  // o controle de acordo fica `disabled` enquanto carrega E em MENSALIDADES:
  // esperar em vez de pular, senão o clique some em silêncio
  if (donoAcordo && ["ACORDOS_VENCIDOS", "MENSALIDADES_E_ACORDOS"].includes(tipo)) {
    const id = `resp-acordo-${donoAcordo}`;
    await waitFor(() => {
      const c = document.getElementById(id);
      if (!c || c.disabled) throw new Error("controle de acordo ainda desabilitado");
    });
    const c = document.getElementById(id);
    if (!c.checked) await act(async () => { fireEvent.click(c); });
  }
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

  it("lista QUEM TEM caso ou acordo, com a classe, e sem opção 'todos'", async () => {
    await montar({ responsavel: null });
    const lista = await screen.findByTestId("resp-caso");
    // acoes_massivas_filtros só trazia `ativo and perfil='operador'`: a Olga
    // desligada, a gestão e a Carteira Geral ficavam de fora do filtro.
    expect(lista.textContent).toMatch(/Olga.*desligado/);
    expect(lista.textContent).toMatch(/Amanda Gestora.*não é da fila/);
    expect(lista.textContent).toMatch(/Carteira Geral.*gestão/);
    expect(lista.textContent).toMatch(/Sem responsável.*fila livre/);
    // e NÃO existe um "todos" que dispare sem recorte
    expect(lista.textContent).not.toMatch(/todos/i);
  });

  it("sem nenhum responsável marcado, não gera prévia", async () => {
    await montar({ responsavel: null });
    await buscar();
    expect(rpcMock.mock.calls.some(([n]) => n === "acoes_massivas_previa")).toBe(false);
    expect(screen.getAllByText(/não dispara sem recorte explícito/i).length)
      .toBeGreaterThan(0);
  });

  it("por padrão manda LIVRES (nunca null) e a exportação repete o mesmo valor e a prévia", async () => {
    await montar();
    await buscar();
    const previa = ultimaChamada("acoes_massivas_previa");
    expect(previa.p_operador_email).toBe("CASO:SEM_RESPONSAVEL");
    expect(Object.keys(previa).sort()).toEqual([
      "p_acionamento", "p_ano_vencimento", "p_canal", "p_curso",
      "p_dias_minimo_sem_contato", "p_importacao_ids", "p_limite", "p_matricula", "p_operador_email",
      "p_recencia_dias", "p_sem_telefone", "p_situacao_academica", "p_tipo_cobranca", "p_unidade",
      "p_valor_max", "p_valor_min",
    ]);
    expect(screen.getByText(/Responsável filtrado/).textContent).toContain("sem responsável / livres");
    await gerar();
    const reg = ultimaChamada("acoes_massivas_exportar");
    expect(reg.p_operador_email).toBe("CASO:SEM_RESPONSAVEL");
    expect(reg.p_previa_id).toBe("previa-1");
    // o recorte passa a aparecer no nome, inclusive a fila livre
    expect(reg.p_arquivo).toMatch(/^acao-massiva-whatsapp-sem-responsavel-mensalidades-\d{4}-\d{2}-\d{2}\.xlsx$/);
  });

  it("com operador, a prévia manda o e-mail e mostra qual carteira foi filtrada", async () => {
    await montar();
    escolherOperador("cobranca03@teste.local");
    await buscar();
    expect(ultimaChamada("acoes_massivas_previa").p_operador_email).toBe("CASO:cobranca03@teste.local");
    expect(screen.getByText(/Responsável filtrado/).textContent).toContain("Olga");
    // sem a dimensão de acordo marcada, a tela diz que entra acordo de qualquer um
    // em MENSALIDADES a tela diz que acordo não entra nesta modalidade
    expect(screen.getByText(/Responsável filtrado/).textContent).toMatch(/Sem acordo/);
    expect(screen.getByText(/caso\(s\) de Olga/)).toBeTruthy();
  });

  it("vários responsáveis viram uma lista explícita — não um 'todos'", async () => {
    await montar({ responsavel: null });
    await screen.findByTestId("resp-caso");
    escolherOperador("cobranca03@teste.local");
    fireEvent.click(document.getElementById("resp-caso-cobranca05@teste.local"));
    await buscar();
    expect(ultimaChamada("acoes_massivas_previa").p_operador_email)
      .toBe("CASO:cobranca03@teste.local|cobranca05@teste.local");
    await gerar();
    // o nome do arquivo não pode levar ':' nem '|'
    const arq = ultimaChamada("acoes_massivas_exportar").p_arquivo;
    expect(arq).toMatch(/-2responsaveis-/);
    expect(arq).not.toMatch(/[:|]/);
  });

  it("a dimensão de ACORDO vai separada, e a tela diz que ela recorta", async () => {
    await montar({ responsavel: null, tipo: "ACORDOS_VENCIDOS", donoAcordo: null });
    await screen.findByTestId("resp-caso");
    escolherOperador("cobranca03@teste.local");
    escolherDonoAcordo("amanda.seibel@teste.local");
    await buscar();
    expect(ultimaChamada("acoes_massivas_previa").p_operador_email)
      .toBe("CASO:cobranca03@teste.local;ACORDO:amanda.seibel@teste.local");
    expect(screen.getByText(/Responsável filtrado/).textContent).toMatch(/Acordos só de/);
  });

  it("em 'Todos os operadores' a lista mostra o responsável, marca quem está fidelizado e o livre aparece como Livre", async () => {
    previaExtra = {
      elegiveis: [
        { ...ELEGIVEL, id: "a1", tem_responsavel: true, responsavel_email: "op1@x.com", fidelizacao_ativa: true },
        { ...ELEGIVEL, id: "a2", nome: "Bia ***", tem_responsavel: false },
      ],
    };
    await montar({ responsavel: null });
    await screen.findByTestId("resp-caso");
    // o equivalente do antigo "todos": marcar explicitamente quem se quer
    escolherOperador("cobranca03@teste.local");
    fireEvent.click(document.getElementById("resp-caso-cobranca05@teste.local"));
    await buscar();
    expect(screen.getByRole("columnheader", { name: "Responsável" })).toBeTruthy();
    expect(screen.getByText("op1@x.com")).toBeTruthy();
    expect(screen.getByText("fidelizado")).toBeTruthy();
    expect(screen.getByText("Livre")).toBeTruthy();
  });

  it("sem nenhum responsável na lista, a coluna Responsável não aparece", async () => {
    await montar();
    await buscar();
    expect(screen.queryByRole("columnheader", { name: "Responsável" })).toBeNull();
  });

  it("a exportação usa o mesmo operador da prévia e avisa quem saiu da carteira", async () => {
    regExtra = { excluidos_outro_operador: 2 };
    await montar();
    escolherOperador("cobranca05@teste.local");
    await buscar();
    await gerar();
    const reg = ultimaChamada("acoes_massivas_exportar");
    expect(reg.p_operador_email).toBe("CASO:cobranca05@teste.local");
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
    expect(screen.queryByText(/Responsável filtrado/)).toBeNull();
    // nenhuma RPC foi chamada pela troca (nada de registrar/atribuir)
    expect(rpcMock.mock.calls.length).toBe(chamadasAntes);
    escolherOperador("SEM_RESPONSAVEL");
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
    fireEvent.change(screen.getByLabelText("Acionamento"), { target: { value: "NUNCA" } });
    await buscar();
    const c = ultimaChamada("acoes_massivas_previa");
    expect(c.p_operador_email).toBe("CASO:cobranca03@teste.local");
    expect(c.p_importacao_ids).toEqual(["imp-1"]);
    expect(c.p_acionamento).toBe("NUNCA");
  });

  it("operador + unidade + modalidade vão juntos ao banco", async () => {
    await montar();
    escolherOperador("cobranca05@teste.local");
    fireEvent.click(screen.getByLabelText("CANOAS"));
    fireEvent.change(screen.getByDisplayValue("Todas as modalidades"), { target: { value: "EAD" } });
    await buscar();
    const c = ultimaChamada("acoes_massivas_previa");
    expect(c.p_operador_email).toBe("CASO:cobranca05@teste.local");
    expect(c.p_unidade).toBe("CANOAS");
    expect(c.p_curso).toBe("EAD");
  });
});

describe("Ações Massivas — exportar já registra (02/10); lotes antigos ficam pendentes de registro", () => {
  const LOTE = {
    id: "lote-1", canal: "WHATSAPP", operador_email: "cobranca03@teste.local", operador_nome: "Olga",
    arquivo: "acao-massiva-whatsapp-cobranca03-2026-09-16.xlsx", total: 3,
    exportado_por_email: "gestao@reativa", exportado_em: "2026-09-16T14:00:00Z",
  };

  it("exportar é a única chamada: o próprio banco registra, sem segunda etapa", async () => {
    await montar();
    await buscar();
    await gerar();
    expect(nomesChamados()).toContain("acoes_massivas_exportar");
    expect(nomesChamados()).not.toContain("registrar_acao_massiva");
    expect(nomesChamados()).not.toContain("acoes_massivas_concluir_lote");
    expect(screen.getByText(/registrado\(s\) no CRM como ação massiva/)).toBeTruthy();
    // a lista de lotes abertos é recarregada para mostrar o que falta confirmar
    expect(nomesChamados().filter((n) => n === "acoes_massivas_lotes_pendentes").length).toBe(2);
  });

  it("o resultado separa Selecionados, Registrados e Excluídos, e marca Enviados/Falhas como indisponíveis", async () => {
    await montar();
    await buscar();
    await gerar();
    expect(screen.getByText("Selecionados")).toBeTruthy();
    expect(screen.getByText("Registrados no CRM")).toBeTruthy();
    expect(screen.getByText("Excluídos na revalidação")).toBeTruthy();
    expect(screen.getByText("Enviados")).toBeTruthy();
    expect(screen.getByText("Falhas de envio")).toBeTruthy();
    // "não disponível" aparece nos dois que não são mensuráveis, e em nenhum outro
    expect(screen.getAllByText("não disponível").length).toBe(2);
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
    expect(await screen.findByText("Planilhas pendentes de registro")).toBeTruthy();
    expect(within(screen.getByTestId("resp-caso")).getByText(/Olga/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Confirmar ação realizada/ }));
    expect(nomesChamados()).not.toContain("acoes_massivas_concluir_lote");
    expect(screen.getByText(/Confirme só se o disparo já foi concluído/)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Sim, o disparo foi concluído/ })); });
    const c = rpcMock.mock.calls.filter(([n]) => n === "acoes_massivas_concluir_lote").at(-1)[1];
    expect(c).toEqual({ p_lote_id: "lote-1", p_acao: "CONFIRMAR" });
    expect(screen.getByText(/Ação confirmada: 3 aluno\(s\) registrados como ação massiva e contados na cobertura/)).toBeTruthy();
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

  it("trocar de operador não esconde os lotes pendentes de registro", async () => {
    lotes = [LOTE];
    await montar();
    await screen.findByText("Planilhas pendentes de registro");
    escolherOperador("cobranca05@teste.local");
    expect(screen.getByText("Planilhas pendentes de registro")).toBeTruthy();
  });

  it("escolher operador NÃO aplica “Sem acionamento há” sozinho; o filtro segue opcional", async () => {
    await montar();
    escolherOperador("cobranca03@teste.local");
    expect(screen.getByDisplayValue("Qualquer período")).toBeTruthy();
    await buscar();
    expect(ultimaChamadaPrevia().p_dias_minimo_sem_contato).toBeNull();
    // e quem quiser, escolhe
    fireEvent.change(screen.getByDisplayValue("Qualquer período"), { target: { value: "15" } });
    await buscar();
    expect(ultimaChamadaPrevia().p_dias_minimo_sem_contato).toBe(15);
    expect(ultimaChamadaPrevia().p_operador_email).toBe("CASO:cobranca03@teste.local");
  });
});

function ultimaChamadaPrevia() {
  return rpcMock.mock.calls.filter(([n]) => n === "acoes_massivas_previa").at(-1)[1];
}

describe("Ações Massivas — filtro Tipo de cobrança", () => {
  const ultima = (nome) => rpcMock.mock.calls.filter(([n]) => n === nome).at(-1)[1];
  // usa o escolherTipo do módulo: ele marca o dono do acordo quando exigido

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
    expect(linha).toContain("Por tipo, após os filtros: Mensalidades 1501");
    expect(linha).toContain("Acordos vencidos 762");
    expect(linha).toContain("Total único 2263");
    expect(linha).toContain("281 dos acordos vencidos também têm mensalidade");
  });

  it("combina com operador, borderô, nunca acionados, unidade, modalidade e prazo", async () => {
    await montar({ tipo: "ACORDOS_VENCIDOS" });
    escolherOperador("cobranca03@teste.local");
    fireEvent.click(await screen.findByLabelText(/bordero-ead/));
    fireEvent.change(screen.getByLabelText("Acionamento"), { target: { value: "NUNCA" } });
    fireEvent.click(screen.getByLabelText("CANOAS"));
    fireEvent.change(screen.getByDisplayValue("Todas as modalidades"), { target: { value: "EAD" } });
    fireEvent.change(screen.getByDisplayValue("Qualquer período"), { target: { value: "30" } });
    await buscar();
    expect(ultima("acoes_massivas_previa")).toMatchObject({
      p_tipo_cobranca: "ACORDOS_VENCIDOS",
      // a modalidade de acordo exige o dono do acordo: ele vai junto
      p_operador_email: "CASO:cobranca03@teste.local;ACORDO:amanda.seibel@teste.local",
      p_importacao_ids: ["imp-1"], p_acionamento: "NUNCA", p_unidade: "CANOAS", p_curso: "EAD",
      p_dias_minimo_sem_contato: 30,
    });
    await gerar();
    expect(ultima("acoes_massivas_exportar")).toMatchObject({
      p_tipo_cobranca: "ACORDOS_VENCIDOS",
      p_operador_email: "CASO:cobranca03@teste.local;ACORDO:amanda.seibel@teste.local",
    });
  });

  it("trocar o tipo limpa a prévia e a planilha anterior, sem chamar o banco", async () => {
    await montar();
    await buscar();
    await gerar();
    expect(screen.getByRole("button", { name: /Baixar planilha novamente/ })).toBeTruthy();
    const antes = rpcMock.mock.calls.length;
    await escolherTipo("ACORDOS_VENCIDOS");
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

  it("o lote pendente de registro mostra o tipo; a confirmação conta quem saiu do tipo", async () => {
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
    await screen.findByText("Planilhas pendentes de registro");
    expect(screen.getByRole("columnheader", { name: "Tipo de cobrança" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "Somente acordos vencidos" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "Sem tipo (tela anterior)" })).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: /Confirmar ação realizada/ })[0]);
    expect(screen.getByText(/deixou de estar disponível, fica de fora/)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Sim, o disparo foi concluído/ })); });
    expect(screen.getByText(/2 caso\(s\) não correspondem mais ao tipo de cobrança do lote/)).toBeTruthy();
  });
});

describe("Ações Massivas — universo no banco: limite exato, sem corte no cliente", () => {
  const ultimaPrevia = () => rpcMock.mock.calls.filter(([n]) => n === "acoes_massivas_previa").at(-1)[1];

  it("envia p_limite exato (não qtd*3), valor mínimo 0 por padrão e recência 10", async () => {
    await montar();
    fireEvent.change(screen.getByDisplayValue("100"), { target: { value: "37" } });
    await buscar();
    expect(ultimaPrevia()).toMatchObject({
      p_limite: 37, p_valor_min: 0, p_valor_max: null, p_recencia_dias: 10,
      p_acionamento: "TODOS", p_canal: "WHATSAPP", p_sem_telefone: false, p_situacao_academica: null,
    });
  });

  it("limite máximo 5000 e faixa de valor vão ao banco sem piso oculto", async () => {
    await montar();
    fireEvent.change(screen.getByDisplayValue("100"), { target: { value: "9000" } });
    fireEvent.change(screen.getByPlaceholderText("Ex: 500,00"), { target: { value: "50" } });
    fireEvent.change(screen.getByPlaceholderText("Ex: 3000,00"), { target: { value: "3.000,00" } });
    fireEvent.click(screen.getByRole("button", { name: /E-mail/ }));
    await buscar();
    expect(ultimaPrevia()).toMatchObject({ p_limite: 5000, p_valor_min: 50, p_valor_max: 3000, p_canal: "EMAIL" });
  });

  it("recência 0–60 e acionamento 'Não acionados no mês' vão ao banco", async () => {
    await montar();
    fireEvent.change(screen.getByLabelText(/Recência da ação massiva/), { target: { value: "99" } });
    fireEvent.change(screen.getByLabelText("Acionamento"), { target: { value: "NAO_MES" } });
    await buscar();
    expect(ultimaPrevia()).toMatchObject({ p_recencia_dias: 60, p_acionamento: "NAO_MES" });
    expect(screen.getByText(/Não repete ação massiva no mesmo canal dentro deste prazo/)).toBeTruthy();
  });

  it("'Só sem telefone' do e-mail vai ao banco, sem filtro no cliente", async () => {
    await montar();
    fireEvent.click(screen.getByRole("button", { name: /E-mail/ }));
    fireEvent.click(screen.getByLabelText(/Só sem telefone/));
    await buscar();
    expect(ultimaPrevia().p_sem_telefone).toBe(true);
    // o item devolvido TEM telefone e mesmo assim é exibido: o cliente não recorta
    expect(screen.getByText("Ana ***")).toBeTruthy();
  });

  it("não corta a lista do banco: valor abaixo de R$ 100 e mais itens que a Quantidade aparecem", async () => {
    const mais = [{ ...ELEGIVEL, id: "b1", nome: "Bia ***", valor: 20 }, { ...ELEGIVEL, id: "b2", nome: "Caio ***", valor: 30 }];
    previaExtra = { elegiveis: [ELEGIVEL, ...mais] };
    await montar();
    fireEvent.change(screen.getByDisplayValue("100"), { target: { value: "1" } });
    await buscar();
    expect(screen.getByText("Bia ***")).toBeTruthy();
    expect(screen.getByText("Caio ***")).toBeTruthy();
    await gerar();
    expect(rpcMock.mock.calls.filter(([n]) => n === "acoes_massivas_exportar").at(-1)[1].p_aluno_ids).toEqual(["a1", "b1", "b2"]);
  });

  it("painel da prévia: solicitado, universo, disponíveis, selecionados, motivos e filtros", async () => {
    resumoExtra = { com_responsavel: 1, com_fidelizacao_ativa: 1 };
    await montar();
    await buscar();
    const painel = screen.getByTestId("painel-previa").textContent;
    expect(painel).toContain("Solicitado");
    expect(painel).toContain("No universo (base)");
    expect(painel).toContain("Disponíveis para WhatsApp");
    expect(painel).toContain("Indisponíveis para WhatsApp");
    expect(screen.getByTestId("legenda-disponibilidade-previa").textContent).toMatch(/considera todos os filtros atuais, inclusive o canal/);
    expect(screen.getByTestId("legenda-disponibilidade-previa").textContent).toContain("Sem contato válido para o canal");
    expect(painel).toContain("Serão selecionados");
    expect(screen.getByTestId("motivos-previa").textContent).toContain("Quitado: 4");
    expect(screen.getByTestId("motivos-previa").textContent).toContain("Ação massiva recente neste canal: 2");
    expect(screen.getByTestId("resp-fidelizacao").textContent).toContain("1 com responsável");
    expect(screen.getByTestId("resp-fidelizacao").textContent).toContain("não altera");
    expect(screen.getByTestId("filtros-aplicados").textContent).toMatch(/valor mínimo R\$\s*0,00.*recência 10 dia/);
    expect(screen.queryByTestId("menos-que-solicitado")).toBeNull();
  });

  it("no canal E-mail os cartões da prévia dizem 'para E-mail'", async () => {
    await montar();
    fireEvent.click(screen.getByRole("button", { name: /E-mail/ }));
    await buscar();
    const painel = screen.getByTestId("painel-previa").textContent;
    expect(painel).toContain("Disponíveis para E-mail");
    expect(painel).toContain("Indisponíveis para E-mail");
    expect(painel).not.toContain("para WhatsApp");
  });

  it("menos_que_solicitado mostra a frase 'Somente N disponíveis dentro dos filtros atuais'", async () => {
    resumoExtra = { menos_que_solicitado: true, solicitado: 100, selecionado: 12 };
    await montar();
    await buscar();
    expect(screen.getByTestId("menos-que-solicitado").textContent)
      .toBe("Somente 12 disponíveis dentro dos filtros atuais (solicitado 100)");
  });

  it("passa ao painel de cobertura os filtros de população/operação", async () => {
    await montar({ responsavel: null });
    await screen.findByTestId("resp-caso");
    escolherOperador("cobranca03@teste.local");
    escolherDonoAcordo("amanda.seibel@teste.local");
    fireEvent.click(screen.getByLabelText("CANOAS"));
    // o painel de cobertura recebe as MESMAS chaves que o universo lê
    expect(propsPenetracao.filtrosCobertura).toMatchObject({
      responsaveis_caso: ["cobranca03@teste.local"],
      responsaveis_acordo: ["amanda.seibel@teste.local"],
      unidade: "CANOAS", canal: "WHATSAPP", valor_min: 0, valor_max: null, recencia_dias: 10,
      tipo_cobranca: "MENSALIDADES", sem_telefone: false,
    });
  });
});

// A lacuna do #537: campo de acordo vazio significava "acordo de qualquer
// pessoa". Nas modalidades que olham acordo, escolher passa a ser obrigatório.
describe("Ações Massivas — acordo exige dono explícito", () => {
  beforeEach(() => { rpcMock.mockClear(); });
  afterEach(cleanup);
  const ultimaChamada = (nome) => rpcMock.mock.calls.filter(([n]) => n === nome).at(-1)[1];

  it("ACORDOS_VENCIDOS sem dono de acordo não chega ao banco", async () => {
    await montar({ responsavel: null, tipo: "ACORDOS_VENCIDOS", donoAcordo: null });
    await screen.findByTestId("resp-caso");
    escolherOperador("cobranca03@teste.local");
    await buscar();
    expect(rpcMock.mock.calls.some(([n]) => n === "acoes_massivas_previa")).toBe(false);
    expect(screen.getByText(/exige escolher ao menos um/)).toBeTruthy();
  });

  it("MENSALIDADES_E_ACORDOS também exige", async () => {
    await montar({ responsavel: null, tipo: "MENSALIDADES_E_ACORDOS", donoAcordo: null });
    await screen.findByTestId("resp-caso");
    escolherOperador("cobranca03@teste.local");
    await buscar();
    expect(rpcMock.mock.calls.some(([n]) => n === "acoes_massivas_previa")).toBe(false);
  });

  it("SOMENTE MENSALIDADES não exige, e o controle fica desabilitado", async () => {
    await montar({ responsavel: null, tipo: "MENSALIDADES" });
    await screen.findByTestId("resp-caso");
    escolherOperador("cobranca03@teste.local");
    const caixa = document.getElementById("resp-acordo-amanda.seibel@teste.local");
    expect(caixa.disabled).toBe(true);
    await buscar();
    expect(ultimaChamada("acoes_massivas_previa").p_operador_email).toBe("CASO:cobranca03@teste.local");
  });

  // o cenário que ela pediu: acordo da Amanda em caso da Olga
  it("com o dono do acordo escolhido, passa e a prévia diz quem foi", async () => {
    await montar({ responsavel: null, tipo: "ACORDOS_VENCIDOS", donoAcordo: null });
    await screen.findByTestId("resp-caso");
    escolherOperador("cobranca03@teste.local");
    escolherDonoAcordo("amanda.seibel@teste.local");
    await buscar();
    expect(ultimaChamada("acoes_massivas_previa").p_operador_email)
      .toBe("CASO:cobranca03@teste.local;ACORDO:amanda.seibel@teste.local");
    expect(screen.getByText(/Responsável filtrado/).textContent)
      .toMatch(/Acordos só de Amanda Gestora.*fora dessa lista foi recusado/);
  });
});

// O rótulo dizia "Responsável pelo caso" mas a consulta filtra
// alunos.responsavel_atual_email — a FICHA. Medido em 27/09/2026: divergem em
// 20 alunos de 13.041.
describe("Ações Massivas — o rótulo diz qual titularidade é", () => {
  beforeEach(() => { rpcMock.mockClear(); });
  afterEach(cleanup);

  it("o campo nomeia a FICHA, não o caso, e explica a diferença", async () => {
    await montar({ responsavel: null });
    await screen.findByTestId("resp-caso");
    expect(screen.getByText("Responsável pela ficha do aluno")).toBeTruthy();
    const ajuda = screen.getByText(/alunos\.responsavel_atual_email/).closest("span").textContent;
    expect(ajuda).toMatch(/dono da\s+ficha/);
    expect(ajuda).toMatch(/Na Carteira Geral o filtro é pelo caso; aqui é pela ficha/);
    expect(ajuda).toMatch(/20.*13\.041/);
  });

  it("a prévia tem a coluna 'Caso em outra mão' e a destaca quando > 0", async () => {
    previaExtra = {
      por_responsavel: [
        { responsavel: "cobranca03@teste.local", alunos: 3, casos: 3, acordos: 2,
          acordos_de_outro_dono: 1, casos_em_outra_mao: 1, valor: 900 },
      ],
    };
    await montar();
    await buscar();
    const tabela = screen.getByTestId("previa-por-responsavel");
    expect(within(tabela).getByText("Caso em outra mão")).toBeTruthy();
    const linha = within(tabela).getByText("cobranca03@teste.local").closest("tr");
    // alunos 3 · casos 3 · acordos 2 · de outro dono 1 · caso em outra mão 1
    expect(linha.textContent).toMatch(/3.*3.*2.*1.*1/);
  });
});

// E-MAIL DO LOTE DE WHATSAPP. O que se prova aqui: o recorte sai do LOTE (um
// p_lote_id, nada de filtro refeito nem de "Acionados hoje"), a tela mostra
// quantos daquele lote têm e-mail antes de clicar, a ação pede confirmação
// explícita, a planilha leva nome + e-mail, e um lote que já derivou e-mail não
// oferece o botão de novo.
describe("Ações Massivas — e-mail a partir de um lote de WhatsApp", () => {
  const LOTE_WHATS = {
    id: "lote-wa-1",
    arquivo: "acao-massiva-whatsapp-2026-10-06.xlsx",
    operador_email: null,
    operador_nome: null,
    tipo_cobranca: "MENSALIDADES",
    total: 10,
    com_email: 7,
    sem_email: 3,
    exportado_em: "2026-10-06T12:00:00Z",
    exportado_por_email: "gestao@reativa",
    email_lote_id: null,
    email_exportado_em: null,
  };
  const painel = () => screen.getByTestId("lotes-whatsapp-email");
  const chamadas = (nome) => rpcMock.mock.calls.filter(([n]) => n === nome);

  async function abrirConfirmacao() {
    await act(async () => {
      fireEvent.click(within(painel()).getByRole("button", { name: /Exportar e-mails deste lote/ }));
    });
  }

  it("sem lote de WhatsApp recente, o painel não aparece", async () => {
    await montar();
    expect(screen.queryByTestId("lotes-whatsapp-email")).toBeNull();
  });

  it("mostra o lote com o total, quantos têm e-mail e quantos não têm", async () => {
    lotesWhats = [LOTE_WHATS];
    await montar();
    const linha = within(painel()).getByText(LOTE_WHATS.arquivo).closest("tr");
    expect(within(linha).getByText("10")).toBeTruthy();
    expect(within(linha).getByText("7")).toBeTruthy();
    expect(within(linha).getByText("3")).toBeTruthy();
  });

  it("não exporta no primeiro clique: pede confirmação dizendo o que vai registrar", async () => {
    lotesWhats = [LOTE_WHATS];
    await montar();
    await abrirConfirmacao();
    expect(within(painel()).getByText(/Gera a planilha de e-mail com 7 aluno\(s\)/)).toBeTruthy();
    expect(within(painel()).getByText(/3 sem e-mail válido ficam fora/)).toBeTruthy();
    expect(chamadas("acoes_massivas_exportar_emails_do_lote")).toHaveLength(0);
  });

  it("confirmado, chama o banco só com o id do lote — sem refazer filtro", async () => {
    lotesWhats = [LOTE_WHATS];
    await montar();
    await abrirConfirmacao();
    await act(async () => {
      fireEvent.click(within(painel()).getByRole("button", { name: /Sim, exportar e registrar/ }));
    });
    const [, args] = chamadas("acoes_massivas_exportar_emails_do_lote").at(-1);
    expect(args.p_lote_id).toBe("lote-wa-1");
    expect(args.p_arquivo).toMatch(/^acao-massiva-email-do-lote-whatsapp-\d{4}-\d{2}-\d{2}\.xlsx$/);
    // Nada de prévia nem de exportação normal foi acionado por este caminho.
    expect(chamadas("acoes_massivas_previa")).toHaveLength(0);
    expect(chamadas("acoes_massivas_exportar")).toHaveLength(0);
  });

  it("conta na mensagem o que saiu, o que foi registrado e o que ficou fora por e-mail", async () => {
    lotesWhats = [LOTE_WHATS];
    await montar();
    await abrirConfirmacao();
    await act(async () => {
      fireEvent.click(within(painel()).getByRole("button", { name: /Sim, exportar e registrar/ }));
    });
    expect(screen.getByText(/7 de 10 aluno\(s\) com e-mail válido e 7 registrado\(s\)/)).toBeTruthy();
    expect(screen.getByText(/3 ficaram fora por não ter e-mail válido/)).toBeTruthy();
    expect(screen.getByText(/lote de WhatsApp não foi alterado/)).toBeTruthy();
  });

  it("nenhum com e-mail: diz que nada foi exportado nem registrado", async () => {
    lotesWhats = [LOTE_WHATS];
    emailDoLote = { lote_id: null, com_email: 0, sem_email: 10, registrados: 0, contatos: [] };
    await montar();
    await abrirConfirmacao();
    await act(async () => {
      fireEvent.click(within(painel()).getByRole("button", { name: /Sim, exportar e registrar/ }));
    });
    expect(screen.getByText(/Nenhum dos 10 aluno\(s\) do lote de WhatsApp tem e-mail válido/)).toBeTruthy();
  });

  it("lote sem ninguém com e-mail não oferece a exportação", async () => {
    lotesWhats = [{ ...LOTE_WHATS, com_email: 0, sem_email: 10 }];
    await montar();
    expect(within(painel()).getByRole("button", { name: /Exportar e-mails deste lote/ }).disabled).toBe(true);
  });

  it("lote que já derivou e-mail não oferece o botão de novo", async () => {
    lotesWhats = [{ ...LOTE_WHATS, email_lote_id: "lote-email-1", email_exportado_em: "2026-10-06T15:00:00Z" }];
    await montar();
    expect(within(painel()).queryByRole("button", { name: /Exportar e-mails deste lote/ })).toBeNull();
    expect(within(painel()).getByText(/E-mail já exportado deste lote/)).toBeTruthy();
  });

  it("erro do banco aparece na tela e não vira sucesso", async () => {
    lotesWhats = [LOTE_WHATS];
    emailDoLote = { erro: "Este lote de WhatsApp ja gerou a acao de e-mail" };
    await montar();
    await abrirConfirmacao();
    await act(async () => {
      fireEvent.click(within(painel()).getByRole("button", { name: /Sim, exportar e registrar/ }));
    });
    expect(screen.getByText(/Erro ao exportar e-mails do lote/)).toBeTruthy();
    expect(screen.queryByText(/com e-mail válido e/)).toBeNull();
  });

  it("a planilha leva nome e e-mail dos alunos do lote", async () => {
    lotesWhats = [LOTE_WHATS];
    emailDoLote = {
      contatos: [
        { aluno_id: "a1", nome: "Ana", email: " ana@x.com " },
        { aluno_id: "a2", nome: "Bia", email: "bia@x.com" },
      ],
      com_email: 2, sem_email: 8, registrados: 2,
    };
    await montar();
    await abrirConfirmacao();
    await act(async () => {
      fireEvent.click(within(painel()).getByRole("button", { name: /Sim, exportar e registrar/ }));
    });
    expect(linhasPlanilha).toEqual([
      { "Nome do aluno": "Ana", "E-mail": "ana@x.com" },
      { "Nome do aluno": "Bia", "E-mail": "bia@x.com" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// ATALHOS DE SELEÇÃO. Pedido da gestão: poder pegar todos os responsáveis de
// uma vez, sem marcar um a um, em cada uma das duas dimensões — e voltar atrás
// sem desmarcar um a um. A marcação individual continua existindo, e nada do
// recorte muda: o banco segue recebendo a RELAÇÃO NOMINAL, nunca um 'todos'
// genérico que desligaria o recorte.
describe("Ações Massivas — Selecionar todos / Limpar seleção por dimensão", () => {
  const ultimaChamada = (nome) => rpcMock.mock.calls.filter(([n]) => n === nome).at(-1)[1];
  const todosDaFicha = RESPONSAVEIS.map((o) => o.email);
  const todosDeAcordo = RESPONSAVEIS.filter((o) => o.acordos > 0).map((o) => o.email);
  const marcadosEm = (testId) =>
    within(screen.getByTestId(testId)).getAllByRole("checkbox").filter((c) => c.checked)
      .map((c) => c.id.replace(`${testId}-`, ""));
  const clicar = (id) => fireEvent.click(document.getElementById(id));

  it("“Selecionar todos” da ficha marca TODOS os responsáveis daquela lista", async () => {
    await montar({ responsavel: null, tipo: null });
    clicar("resp-caso-selecionar-todos");
    // cobre as cinco classes, inclusive a fila livre, a Olga desligada, a
    // gestão e a Carteira Geral — ninguém fica de fora
    expect(marcadosEm("resp-caso").sort()).toEqual([...todosDaFicha].sort());
    expect(marcadosEm("resp-caso")).toHaveLength(5);
  });

  it("manda a relação nominal ao banco, não um 'todos' genérico, e sem repetir e-mail", async () => {
    await montar({ responsavel: null, tipo: null });
    clicar("resp-caso-selecionar-todos");
    await escolherTipo("MENSALIDADES");
    await buscar();
    const enviado = ultimaChamada("acoes_massivas_previa").p_operador_email;
    expect(enviado).toBe(`CASO:${todosDaFicha.join("|")}`);
    expect(enviado).not.toMatch(/(^|:)todos(\||;|$)/i);
    const nomes = enviado.replace(/^CASO:/, "").split("|");
    expect(new Set(nomes).size).toBe(nomes.length); // nenhum e-mail duplicado
  });

  it("os dois lados são independentes: marcar todos num não toca no outro", async () => {
    await montar({ responsavel: null, tipo: "ACORDOS_VENCIDOS", donoAcordo: null });
    clicar("resp-caso-selecionar-todos");
    expect(marcadosEm("resp-caso")).toHaveLength(5);
    expect(marcadosEm("resp-acordo")).toHaveLength(0); // a outra dimensão intacta

    clicar("resp-acordo-selecionar-todos");
    expect(marcadosEm("resp-acordo").sort()).toEqual([...todosDeAcordo].sort());
    expect(marcadosEm("resp-caso")).toHaveLength(5); // e esta segue intacta

    clicar("resp-caso-limpar-selecao");
    expect(marcadosEm("resp-caso")).toHaveLength(0);
    expect(marcadosEm("resp-acordo")).toHaveLength(todosDeAcordo.length);
  });

  it("com as duas listas cheias, a prévia leva CASO e ACORDO na mesma chamada", async () => {
    await montar({ responsavel: null, tipo: "MENSALIDADES_E_ACORDOS", donoAcordo: null });
    clicar("resp-caso-selecionar-todos");
    clicar("resp-acordo-selecionar-todos");
    await buscar();
    expect(ultimaChamada("acoes_massivas_previa").p_operador_email)
      .toBe(`CASO:${todosDaFicha.join("|")};ACORDO:${todosDeAcordo.join("|")}`);
  });

  it("“Limpar seleção” na ficha volta a barrar a prévia: recorte explícito segue obrigatório", async () => {
    await montar();
    clicar("resp-caso-limpar-selecao");
    const antes = rpcMock.mock.calls.length;
    await buscar();
    expect(rpcMock.mock.calls.length).toBe(antes); // nem foi ao banco
    expect(screen.getByText(/Escolha ao menos um responsável pelo caso/)).toBeTruthy();
  });

  it("a marcação individual continua funcionando depois dos atalhos", async () => {
    await montar({ responsavel: null, tipo: null });
    clicar("resp-caso-selecionar-todos");
    clicar("resp-caso-cobranca03@teste.local"); // desmarca só a Olga
    expect(marcadosEm("resp-caso")).toHaveLength(4);
    expect(marcadosEm("resp-caso")).not.toContain("cobranca03@teste.local");
    clicar("resp-caso-cobranca03@teste.local"); // e volta
    expect(marcadosEm("resp-caso")).toHaveLength(5);
  });

  it("usar os atalhos limpa a prévia na tela, como qualquer mudança de recorte", async () => {
    await montar();
    await buscar();
    expect(screen.getByRole("button", { name: /Exportar planilha/ })).toBeTruthy();
    const antes = rpcMock.mock.calls.length;
    clicar("resp-caso-selecionar-todos");
    expect(screen.queryByRole("button", { name: /Exportar planilha/ })).toBeNull();
    expect(rpcMock.mock.calls.length).toBe(antes); // nada foi escrito
  });

  it("em “Somente mensalidades” os atalhos de acordo ficam desabilitados, como a lista", async () => {
    await montar({ tipo: "MENSALIDADES" });
    expect(document.getElementById("resp-acordo-selecionar-todos").disabled).toBe(true);
    expect(document.getElementById("resp-acordo-limpar-selecao").disabled).toBe(true);
  });

  it("“Selecionar todos” desabilita quando já está tudo marcado; “Limpar” quando não há nada", async () => {
    await montar({ responsavel: null, tipo: null });
    expect(document.getElementById("resp-caso-limpar-selecao").disabled).toBe(true);
    clicar("resp-caso-selecionar-todos");
    expect(document.getElementById("resp-caso-selecionar-todos").disabled).toBe(true);
    expect(document.getElementById("resp-caso-limpar-selecao").disabled).toBe(false);
  });

  it("a lista de marcação não ganhou nenhuma opção 'todos' dentro dela", async () => {
    await montar({ responsavel: null, tipo: null });
    // o atalho é um botão FORA da caixa; a caixa segue só com gente nominal
    expect(screen.getByTestId("resp-caso").textContent).not.toMatch(/todos/i);
    expect(within(screen.getByTestId("resp-caso")).getAllByRole("checkbox")).toHaveLength(5);
  });
});
