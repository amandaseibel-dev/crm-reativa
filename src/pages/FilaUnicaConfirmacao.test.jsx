// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const rpcMock = vi.fn();
// Quem esta logado decide se o botao de decisao aparece -- a MESMA regra da
// ficha (`podeGerirFinanceiro`). Por padrao, gestao financeira.
let emailLogado = "cobranca07@aelbra.com.br";
vi.mock("../services/supabase", () => ({
  supabase: {
    rpc: (...a) => rpcMock(...a),
    auth: { getUser: () => Promise.resolve({ data: { user: { email: emailLogado } }, error: null }) },
  },
}));
// A ficha EMBUTIDA e a de verdade (`src/pages/Aluno.jsx`); aqui ela e trocada
// por um marcador, como os outros testes da casa fazem (CasosSemValor,
// ConfirmacoesSemValor), para o teste medir a FILA e nao montar a ficha inteira.
// O marcador declara qual aluno recebeu -- e isso que prova que a ficha certa
// abriu.
vi.mock("./Aluno", () => ({
  default: ({ fichaEmbedId }) => <div data-testid="ficha-embutida">{"ficha:" + fichaEmbedId}</div>,
}));
vi.mock("../ui/cards", () => ({ modalBox: {} }));

import FilaUnicaConfirmacao from "./FilaUnicaConfirmacao";

// O QUE ESTE TESTE PROVA
//  1. a fila chega ao REGISTRO INDIVIDUAL: aluno, CPF, título, safra, valor,
//     motivo, situação, evidência, responsável e data de entrada;
//  2. "Em confirmação de pagamento" REAPROVEITA o fluxo que já existe — o
//     componente `ResolverEmConfirmacao`, chamando as RPCs da Conferência
//     Prime. A fila não tem rota de resolução própria;
//  3. motivo sem regra segura NÃO ganha botão de resolução, e a tela diz por
//     quê — em vez de oferecer uma ação genérica que edite valor ou status;
//  4. depois de resolver, a fila refaz a contagem e a lista, sem reload;
//  5. a fila não é paralela: ela só LÊ as RPCs de pendência e delega a escrita.

const RESUMO_2024 = {
  recorte: "2024",
  gerado_em: "2026-10-07T19:30:00Z",
  snapshot: { gerado_em: "2026-10-07T23:40:00Z", duracao_ms: 1800, bloco: "pendencias_por_motivo" },
  contagens_somaveis: true,
  total: { alunos: 19, titulos: 52, valor: 39686.19 },
  motivos: [
    { chave: "em_confirmacao", rotulo: "Em confirmação de pagamento",
      acao: "CONFERENCIA_PRIME", alunos: 7, titulos: 11, valor: 14401.19 },
    { chave: "pago_sem_lastro", rotulo: "Pago sem lastro",
      acao: "SEM_ACAO_AUTOMATICA_SEGURA", alunos: 12, titulos: 41, valor: 25285.00 },
  ],
  conferencia: { total_valor: 39686.19, soma_das_linhas: 39686.19, diferenca: 0, fecha: true },
};

const ITEM_CONFIRMACAO = {
  aluno_id: "aaaaaaaa-0000-4000-8000-000000000001",
  aluno_nome: "ALUNA TESTE ALFA",
  cpf: "12345678901",
  titulo_id: "tttttttt-0000-4000-8000-000000000001",
  documento: "4445066",
  vencimento: "2024-03-10",
  safra: "2024",
  valor: 3987.54,
  motivo: "em_confirmacao",
  motivo_rotulo: "Em confirmação de pagamento",
  situacao_titulo: "EM_CONFIRMACAO",
  evidencia: "Titulo em EM_CONFIRMACAO: ha pagamento ou liquidacao a conferir.",
  responsavel_email: "cobranca03@aelbra.com.br",
  desde: "2026-09-21T12:00:00Z",
  acao: "CONFERENCIA_PRIME",
};

const ITEM_SEM_LASTRO = {
  ...ITEM_CONFIRMACAO,
  titulo_id: "tttttttt-0000-4000-8000-000000000002",
  documento: "7788991",
  valor: 1200.00,
  motivo: "pago_sem_lastro",
  motivo_rotulo: "Pago sem lastro",
  situacao_titulo: "PAGO",
  evidencia: "Marcado PAGO sem lastro: sem acordo, sem pagamento casado pelo numero do titulo.",
  acao: "SEM_ACAO_AUTOMATICA_SEGURA",
};

const txt = (el) => el.textContent.replace(/\u00a0/g, " ");

function responder({ resumo = RESUMO_2024, itens = [ITEM_CONFIRMACAO], emConfirmacao = [] } = {}) {
  rpcMock.mockImplementation((nome, args) => {
    if (nome === "carteira_efetividade_ler") return Promise.resolve({ data: resumo, error: null });
    if (nome === "carteira_pendencias_itens_ler") {
      return Promise.resolve({ data: itens.filter((i) => i.motivo === args.p_motivo), error: null });
    }
    // RPCs do fluxo EXISTENTE de EM_CONFIRMACAO, usadas por ResolverEmConfirmacao
    if (nome === "conferencia_em_confirmacao_do_aluno") return Promise.resolve({ data: emConfirmacao, error: null });
    if (nome === "conferencia_acordos_do_aluno") return Promise.resolve({ data: [], error: null });
    return Promise.resolve({ data: null, error: null });
  });
}

const montar = (busca = "?ano=2024&motivo=em_confirmacao") =>
  act(async () => {
    render(<MemoryRouter initialEntries={["/fila-unica-confirmacao" + busca]}>
      <FilaUnicaConfirmacao />
    </MemoryRouter>);
  });

beforeEach(() => { rpcMock.mockReset(); emailLogado = "cobranca07@aelbra.com.br"; responder(); });
afterEach(() => cleanup());

describe("Fila Única — o registro individual", () => {
  it("lê o motivo e a safra da URL, que é como a Efetividade entrega o caso", async () => {
    await montar();
    expect(rpcMock).toHaveBeenCalledWith("carteira_efetividade_ler",
      { p_bloco: "pendencias_por_motivo", p_ano: "2024", p_semestre: null });
    expect(rpcMock).toHaveBeenCalledWith("carteira_pendencias_itens_ler",
      expect.objectContaining({ p_motivo: "em_confirmacao", p_ano: "2024", p_semestre: null }));
    // as consultas pesadas não são alcançadas pela fila
    const nomes = rpcMock.mock.calls.map((c) => c[0]);
    expect(nomes).not.toContain("carteira_pendencias_por_motivo");
    expect(nomes).not.toContain("carteira_pendencias_itens");
  });

  it("mostra tudo o que a gestão precisa para identificar o caso", async () => {
    await montar();
    const caso = screen.getByText("ALUNA TESTE ALFA").closest("article");
    expect(txt(caso)).toContain("123.456.789-01");       // CPF
    expect(txt(caso)).toContain("4445066");              // título
    expect(txt(caso)).toContain("10/03/2024");           // vencimento
    expect(txt(caso)).toContain("safra 2024");
    expect(txt(caso)).toContain("R$ 3.987,54");          // valor
    expect(txt(caso)).toContain("Em confirmação de pagamento"); // motivo
    expect(txt(caso)).toContain("EM_CONFIRMACAO");       // situação atual
    expect(txt(caso)).toContain("ha pagamento ou liquidacao a conferir"); // evidência
    expect(txt(caso)).toContain("cobranca03@aelbra.com.br"); // responsável
    expect(txt(caso)).toContain("21/09/2026");           // data de entrada
  });

  it("paginação pede limite e deslocamento — nunca a base inteira", async () => {
    await montar();
    const chamada = rpcMock.mock.calls.find((c) => c[0] === "carteira_pendencias_itens_ler")[1];
    expect(chamada.p_limite).toBeLessThanOrEqual(500);
    expect(chamada.p_offset).toBe(0);
  });
});

describe("Fila Única — reaproveita o fluxo de EM_CONFIRMACAO, não cria outro", () => {
  it("em confirmação monta o resolvedor existente, que consulta a Conferência Prime", async () => {
    await montar();
    const nomes = rpcMock.mock.calls.map((c) => c[0]);
    expect(nomes).toContain("conferencia_em_confirmacao_do_aluno");
    expect(nomes).toContain("conferencia_acordos_do_aluno");
  });

  it("não existe rota de resolução própria da fila: toda escrita é das RPCs do fluxo", async () => {
    responder({ emConfirmacao: [{
      titulo_id: ITEM_CONFIRMACAO.titulo_id, documento: "4445066", valor: 3987.54,
      vencimento: "2024-03-10", efeito: "VIRA_PAGO", efeito_texto: "Vincular quita o título",
      acordo_id: "ac-1", acordo_numero: "4691", exige_motivo: true, dias_pendente: 16,
      pode_seguir_pagamento: true,
    }] });
    await montar();
    expect(screen.getByText(/Vincular quita o título/)).toBeTruthy();
    // nenhuma RPC inventada por esta tela
    const nomes = rpcMock.mock.calls.map((c) => c[0]);
    expect(nomes.some((n) => /fila_unica/.test(n))).toBe(false);
  });
});

describe("Fila Única — submotivo sem ação segura", () => {
  it("não ganha botão de resolução, e a tela explica a ausência", async () => {
    responder({ itens: [ITEM_SEM_LASTRO] });
    await montar("?ano=2024&motivo=pago_sem_lastro");
    expect(screen.getByText("Sem ação automática segura — análise humana")).toBeTruthy();
    expect(screen.getByText(/Não existe regra de resolução por caso para este motivo/)).toBeTruthy();
    // o fluxo de confirmação não é montado para quem não é de confirmação
    const nomes = rpcMock.mock.calls.map((c) => c[0]);
    expect(nomes).not.toContain("conferencia_em_confirmacao_do_aluno");
  });

  it("ainda assim mostra o caso, com motivo e evidência — não o esconde", async () => {
    responder({ itens: [ITEM_SEM_LASTRO] });
    await montar("?ano=2024&motivo=pago_sem_lastro");
    const caso = screen.getByText("ALUNA TESTE ALFA").closest("article");
    expect(txt(caso)).toContain("Pago sem lastro");
    expect(txt(caso)).toContain("sem acordo, sem pagamento casado");
  });
});

describe("Fila Única — atualização sem reload", () => {
  it("“Atualizar dados” refaz a contagem e a lista", async () => {
    await montar();
    const antes = rpcMock.mock.calls.filter((c) => c[0] === "carteira_pendencias_itens_ler").length;
    await act(async () => { fireEvent.click(screen.getByText("Atualizar dados")); });
    const depois = rpcMock.mock.calls.filter((c) => c[0] === "carteira_pendencias_itens_ler").length;
    expect(depois).toBeGreaterThan(antes);
    const contagens = rpcMock.mock.calls.filter((c) => c[0] === "carteira_efetividade_ler").length;
    expect(contagens).toBeGreaterThan(1);
  });

  it("trocar de motivo volta para a primeira página e refaz a consulta", async () => {
    responder({ itens: [ITEM_CONFIRMACAO, ITEM_SEM_LASTRO] });
    await montar();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Pago sem lastro/ }));
    });
    const ultima = [...rpcMock.mock.calls].reverse()
      .find((c) => c[0] === "carteira_pendencias_itens_ler")[1];
    expect(ultima.p_motivo).toBe("pago_sem_lastro");
    expect(ultima.p_offset).toBe(0);
  });
});

describe("Fila Única — o que ela declara ser", () => {
  it("diz explicitamente que não substitui as filas existentes", async () => {
    await montar();
    expect(screen.getByText(/Esta fila não substitui nenhuma outra/)).toBeTruthy();
    expect(screen.getAllByText(/Conferência Prime/).length).toBeGreaterThanOrEqual(1);
  });

  it("erro na contagem aparece, sem derrubar a lista", async () => {
    rpcMock.mockImplementation((nome) =>
      nome === "carteira_efetividade_ler"
        ? Promise.resolve({ data: null, error: { message: "Acesso negado." } })
        : Promise.resolve({ data: [], error: null }));
    await montar();
    expect(screen.getByText(/Não foi possível contar as pendências: Acesso negado/)).toBeTruthy();
  });
});

// POLITICA DE ATUALIZACAO (08/10/2026). Antes disso a fila, depois de resolver,
// RELIA a fotografia -- que ainda nao havia sido reconstruida -- e o caso
// resolvido voltava para a lista. Estes testes travam o comportamento novo.
describe("Fila Única — política de atualização da fotografia", () => {
  const RESOLVIVEL = [{
    titulo_id: ITEM_CONFIRMACAO.titulo_id, documento: "4445066", valor: 3987.54,
    vencimento: "2024-03-10", efeito: "VIRA_PAGO", efeito_texto: "Vincular quita o título",
    acordo_id: "ac-1", acordo_numero: "4691", exige_motivo: true, dias_pendente: 16,
    pode_seguir_pagamento: true,
  }];

  it("declara a data E a hora da fotografia, não só o dia", async () => {
    await montar();
    // 2026-10-07T23:40:00Z — a hora local precisa aparecer junto da data.
    expect(screen.getByText(/Dados atualizados em/)).toBeTruthy();
    const esperado = new Date("2026-10-07T23:40:00Z")
      .toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
    expect(txt(document.body)).toContain(esperado);
  });

  it("avisa “Atualização pendente” quando houve mudança depois da fotografia", async () => {
    responder({ resumo: { ...RESUMO_2024,
      snapshot: { ...RESUMO_2024.snapshot, atualizacao_pendente: true } } });
    await montar();
    expect(screen.getByText(/Atualização pendente/)).toBeTruthy();
  });

  it("sem mudança posterior, não inventa pendência", async () => {
    responder({ resumo: { ...RESUMO_2024,
      snapshot: { ...RESUMO_2024.snapshot, atualizacao_pendente: false } } });
    await montar();
    expect(screen.queryByText(/Atualização pendente/)).toBeNull();
  });

  it("resolvido o caso, a linha sai da lista NA HORA e a reconstrução é solicitada", async () => {
    responder({ emConfirmacao: RESOLVIVEL });
    await montar();
    expect(screen.getByText("ALUNA TESTE ALFA")).toBeTruthy();

    // Resolver pelo fluxo existente. Depois da acao o titulo nao esta mais em
    // confirmacao -- e isso que a resposta da acao devolve.
    rpcMock.mockImplementation((nome, args) => {
      if (nome === "carteira_efetividade_ler") return Promise.resolve({ data: RESUMO_2024, error: null });
      if (nome === "carteira_pendencias_itens_ler") {
        // A FOTOGRAFIA AINDA TRAZ O CASO: ela so sera reconstruida pelo dreno.
        return Promise.resolve({ data: [ITEM_CONFIRMACAO].filter((i) => i.motivo === args.p_motivo), error: null });
      }
      if (nome === "conferencia_em_confirmacao_do_aluno") return Promise.resolve({ data: [], error: null });
      if (nome === "conferencia_acordos_do_aluno") return Promise.resolve({ data: [], error: null });
      return Promise.resolve({ data: { ok: true, previsao: "no próximo dreno" }, error: null });
    });

    // O motivo da auditoria e pedido por `window.prompt` (ver utils/emConfirmacao).
    vi.spyOn(window, "prompt").mockReturnValue("confirmado com a unidade em 07/10");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Vincular/ })); });

    // 1. a linha saiu, apesar de a fotografia ainda traze-la
    expect(screen.queryByText("ALUNA TESTE ALFA")).toBeNull();
    // 2. a reconstrucao foi pedida -- e a funcao PESADA nunca foi chamada
    const nomes = rpcMock.mock.calls.map((c) => c[0]);
    expect(nomes).toContain("carteira_efetividade_solicitar_atualizacao");
    expect(nomes).not.toContain("carteira_efetividade_recalcular");
    expect(nomes).not.toContain("carteira_efetividade_recalcular_pendentes");
  });

  it("se o título ainda tem item em confirmação, a linha FICA — não some por otimismo", async () => {
    responder({ emConfirmacao: RESOLVIVEL });
    await montar();
    rpcMock.mockImplementation((nome, args) => {
      if (nome === "carteira_efetividade_ler") return Promise.resolve({ data: RESUMO_2024, error: null });
      if (nome === "carteira_pendencias_itens_ler") {
        return Promise.resolve({ data: [ITEM_CONFIRMACAO].filter((i) => i.motivo === args.p_motivo), error: null });
      }
      // AINDA pendente depois da acao
      if (nome === "conferencia_em_confirmacao_do_aluno") return Promise.resolve({ data: RESOLVIVEL, error: null });
      if (nome === "conferencia_acordos_do_aluno") return Promise.resolve({ data: [], error: null });
      return Promise.resolve({ data: { ok: true }, error: null });
    });
    vi.spyOn(window, "prompt").mockReturnValue("resolucao parcial conferida na unidade");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Vincular/ })); });

    expect(screen.getByText("ALUNA TESTE ALFA")).toBeTruthy();
    expect(screen.getByText(/Ainda há item em confirmação/)).toBeTruthy();
  });

  it("“Atualizar dados” relê e, havendo pendência, solicita — sem rodar a consulta pesada", async () => {
    responder({ resumo: { ...RESUMO_2024,
      snapshot: { ...RESUMO_2024.snapshot, atualizacao_pendente: true } } });
    await montar();
    await act(async () => { fireEvent.click(screen.getByText("Atualizar dados")); });
    const nomes = rpcMock.mock.calls.map((c) => c[0]);
    expect(nomes).toContain("carteira_efetividade_solicitar_atualizacao");
    expect(nomes).not.toContain("carteira_efetividade_recalcular");
  });

  it("sem pendência, “Atualizar dados” só relê e NÃO pede reconstrução à toa", async () => {
    responder({ resumo: { ...RESUMO_2024,
      snapshot: { ...RESUMO_2024.snapshot, atualizacao_pendente: false } } });
    await montar();
    await act(async () => { fireEvent.click(screen.getByText("Atualizar dados")); });
    const nomes = rpcMock.mock.calls.map((c) => c[0]);
    expect(nomes).not.toContain("carteira_efetividade_solicitar_atualizacao");
    expect(nomes.filter((n) => n === "carteira_efetividade_ler").length).toBeGreaterThan(1);
  });
});

// AS DUAS FALHAS RELATADAS EM 08/10/2026
//   1. "ao clicar no aluno, a ficha nao abre na tela" -- o nome nao era
//      controle nenhum, e o unico caminho NAVEGAVA para fora da fila;
//   2. "os botoes de correcao/decisao nao aparecem ou nao funcionam" -- em 81
//      dos 92 casos resolviveis de producao o aluno tem outro titulo em
//      confirmacao, e a fila lia a resposta da acao (que cobre o ALUNO) como se
//      fosse do titulo da linha: recusava-se a tirar a linha e dizia que ainda
//      havia item naquele titulo, depois de a RPC JA ter executado a decisao.
describe("Fila Única — a ficha abre na própria tela", () => {
  it("clicar no nome do aluno abre a ficha embutida, sem sair da fila", async () => {
    await montar();
    expect(screen.queryByTestId("ficha-embutida")).toBeNull();
    await act(async () => { fireEvent.click(screen.getByText("ALUNA TESTE ALFA")); });
    expect(screen.getByTestId("ficha-embutida").textContent)
      .toBe("ficha:" + ITEM_CONFIRMACAO.aluno_id);
    // a fila continua montada por tras -- nao houve navegacao
    expect(screen.getByText("Fila Única de Confirmação")).toBeTruthy();
  });

  it("o nome do aluno é um controle de verdade, não texto morto", async () => {
    await montar();
    expect(screen.getByRole("button", { name: "ALUNA TESTE ALFA" })).toBeTruthy();
  });

  it("“Abrir ficha do aluno” abre a MESMA ficha embutida", async () => {
    await montar();
    await act(async () => { fireEvent.click(screen.getByText("Abrir ficha do aluno")); });
    expect(screen.getByTestId("ficha-embutida").textContent)
      .toBe("ficha:" + ITEM_CONFIRMACAO.aluno_id);
  });

  it("fechar a ficha relê a fila, sem recarregar a aplicação", async () => {
    await montar();
    await act(async () => { fireEvent.click(screen.getByText("ALUNA TESTE ALFA")); });
    const antes = rpcMock.mock.calls.filter((c) => c[0] === "carteira_pendencias_itens_ler").length;
    await act(async () => { fireEvent.click(screen.getByText("Fechar ✕")); });
    expect(screen.queryByTestId("ficha-embutida")).toBeNull();
    const depois = rpcMock.mock.calls.filter((c) => c[0] === "carteira_pendencias_itens_ler").length;
    expect(depois).toBeGreaterThan(antes);
    // e nunca a consulta pesada
    expect(rpcMock.mock.calls.map((c) => c[0])).not.toContain("carteira_pendencias_itens");
  });

  it("a ficha é a do CRM, não uma segunda ficha da fila", async () => {
    await montar();
    await act(async () => { fireEvent.click(screen.getByText("ALUNA TESTE ALFA")); });
    // nenhuma RPC de ficha propria: quem carrega o aluno e o modulo da ficha
    expect(rpcMock.mock.calls.map((c) => c[0]).some((n) => /fila_unica|ficha_fila/.test(n)))
      .toBe(false);
  });
});

describe("Fila Única — o título resolvido não espera os irmãos", () => {
  const OUTRO_TITULO = {
    titulo_id: "tttttttt-0000-4000-8000-000000000099", documento: "9990001", valor: 820.0,
    vencimento: "2024-08-10", efeito: "VIRA_PAGO", efeito_texto: "Vincular quita o título",
    acordo_id: "ac-9", acordo_numero: "5100", exige_motivo: true, dias_pendente: 40,
    pode_seguir_pagamento: true,
  };
  const DESTE_TITULO = { ...OUTRO_TITULO, titulo_id: ITEM_CONFIRMACAO.titulo_id,
                         documento: "4445066", valor: 3987.54 };

  it("resolvido o título da linha, ela sai mesmo com outro título do aluno pendente", async () => {
    responder({ emConfirmacao: [DESTE_TITULO, OUTRO_TITULO] });
    await montar();
    expect(screen.getByText("ALUNA TESTE ALFA")).toBeTruthy();

    rpcMock.mockImplementation((nome, args) => {
      if (nome === "carteira_efetividade_ler") return Promise.resolve({ data: RESUMO_2024, error: null });
      if (nome === "carteira_pendencias_itens_ler") {
        return Promise.resolve({ data: [ITEM_CONFIRMACAO].filter((i) => i.motivo === args.p_motivo), error: null });
      }
      // Depois da acao o titulo DA LINHA saiu; o irmao continua pendente.
      if (nome === "conferencia_em_confirmacao_do_aluno") return Promise.resolve({ data: [OUTRO_TITULO], error: null });
      if (nome === "conferencia_acordos_do_aluno") return Promise.resolve({ data: [], error: null });
      return Promise.resolve({ data: { ok: true, previsao: "no próximo dreno" }, error: null });
    });
    vi.spyOn(window, "prompt").mockReturnValue("pagamento conferido com a unidade");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Vincular e quitar acordo 5100/ }));
    });

    expect(screen.queryByText("ALUNA TESTE ALFA")).toBeNull();
    expect(screen.queryByText(/Ainda há item em confirmação/)).toBeNull();
    expect(rpcMock.mock.calls.map((c) => c[0]))
      .toContain("carteira_efetividade_solicitar_atualizacao");
  });
});

describe("Fila Única — onde estão os casos com botão", () => {
  it("a safra que tem resolução por caso é marcada no seletor", async () => {
    await montar();
    const botao = screen.getByRole("button", { name: /^2024/ });
    expect(txt(botao)).toContain("resolvíveis");
  });

  it("safra sem nenhum motivo resolvível não ganha marca — e a tela diz onde eles estão", async () => {
    rpcMock.mockImplementation((nome, args) => {
      if (nome === "carteira_efetividade_ler") {
        // 2026/1 so tem motivos sem acao; 2024 tem em_confirmacao.
        if (args.p_ano === "2026") {
          return Promise.resolve({ data: { ...RESUMO_2024, recorte: "2026/1", motivos: [
            { chave: "em_validacao", rotulo: "Em validação",
              acao: "SEM_ACAO_AUTOMATICA_SEGURA", alunos: 900, titulos: 1043, valor: 10 },
          ] }, error: null });
        }
        return Promise.resolve({ data: RESUMO_2024, error: null });
      }
      if (nome === "carteira_pendencias_itens_ler") return Promise.resolve({ data: [], error: null });
      return Promise.resolve({ data: [], error: null });
    });
    await montar("?ano=2026&semestre=1&motivo=em_validacao");
    expect(txt(screen.getByRole("button", { name: /^2026/ }))).not.toContain("resolvíveis");
    expect(screen.getByText(/Com resolução por caso hoje/)).toBeTruthy();
    expect(txt(screen.getByText(/Com resolução por caso hoje/))).toContain("2024");
  });
});

describe("Fila Única — só a gestão financeira decide", () => {
  const RESOLVIVEL_AQUI = [{
    titulo_id: ITEM_CONFIRMACAO.titulo_id, documento: "4445066", valor: 3987.54,
    vencimento: "2024-03-10", efeito: "VIRA_PAGO", efeito_texto: "Vincular quita o título",
    acordo_id: "ac-1", acordo_numero: "4691", exige_motivo: true, dias_pendente: 16,
    pode_seguir_pagamento: true,
  }];

  it("para a gestão financeira, os botões do caso aparecem", async () => {
    responder({ emConfirmacao: RESOLVIVEL_AQUI });
    await montar();
    expect(screen.getByRole("button", { name: /Vincular e quitar acordo 4691/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rejeitar" })).toBeTruthy();
  });

  it("para quem não é gestão financeira, o caso aparece SEM botão de decisão", async () => {
    emailLogado = "cobranca03@aelbra.com.br";
    responder({ emConfirmacao: RESOLVIVEL_AQUI });
    await montar();
    // o caso continua visível, com o efeito que o banco calculou
    expect(screen.getByText(/Vincular quita o título/)).toBeTruthy();
    // mas nenhuma decisão é oferecida — e a tela diz de quem ela é
    expect(screen.queryByRole("button", { name: /Vincular e quitar/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Rejeitar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Seguir pagamento" })).toBeNull();
    expect(screen.getByText(/A decisão é da gestão financeira/)).toBeTruthy();
  });
});

// ENTRAR ONDE HA O QUE FAZER (08/10/2026). Amanda: "fila unica de confirmacao
// nao tem um botao". A tela abria SEMPRE em 2026/1 -- a safra corrente -- e em
// 2026/1 nenhum motivo tem resolucao por caso. Quem entrava pelo menu caia na
// unica safra sem botao possivel.
describe("Fila Única — a entrada cai onde há caso a tratar", () => {
  const RESUMO = (recorte, motivos) => ({
    ...RESUMO_2024, recorte, motivos,
    snapshot: { ...RESUMO_2024.snapshot },
  });
  const SEM_ACAO = (chave, titulos) => ({
    chave, rotulo: chave, acao: "SEM_ACAO_AUTOMATICA_SEGURA",
    alunos: titulos, titulos, valor: titulos * 10,
  });
  const COM_ACAO = (titulos) => ({
    chave: "em_confirmacao", rotulo: "Em confirmação de pagamento",
    acao: "CONFERENCIA_PRIME", alunos: titulos, titulos, valor: titulos * 100,
  });

  // O retrato de producao de 08/10/2026: resolvivel so em 2024 (15) e 2025 (77);
  // 2026/1 e a corrente e tem 2.399 titulos, nenhum com acao.
  function comoProducao({ resolvivel2026 = 0 } = {}) {
    rpcMock.mockImplementation((nome, args) => {
      if (nome === "carteira_efetividade_ler") {
        if (args.p_ano === "2024") return Promise.resolve({ data: RESUMO("2024", [SEM_ACAO("pago_sem_lastro", 41), COM_ACAO(15)]), error: null });
        if (args.p_ano === "2025") return Promise.resolve({ data: RESUMO("2025", [SEM_ACAO("pago_sem_lastro", 289), COM_ACAO(77)]), error: null });
        return Promise.resolve({ data: RESUMO("2026/1", [
          SEM_ACAO("convertido_origem_comprovada", 1321), SEM_ACAO("em_validacao", 1043),
          ...(resolvivel2026 ? [COM_ACAO(resolvivel2026)] : []),
        ]), error: null });
      }
      if (nome === "carteira_pendencias_itens_ler") return Promise.resolve({ data: [], error: null });
      return Promise.resolve({ data: [], error: null });
    });
  }
  const safrasPedidas = () => rpcMock.mock.calls
    .filter((c) => c[0] === "carteira_pendencias_itens_ler")
    .map((c) => c[1].p_ano + (c[1].p_semestre ? "/" + c[1].p_semestre : ""));

  it("sem parâmetro na URL, abre na safra com MAIS casos resolvíveis", async () => {
    comoProducao();
    await montar("");
    // 2025 tem 77 resolvíveis contra 15 de 2024 e nenhum de 2026/1
    expect(screen.getByRole("button", { name: /^2025/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /^2026/ }).getAttribute("aria-pressed")).toBe("false");
  });

  it("e cai no motivo que TEM botão, não no de maior valor", async () => {
    comoProducao();
    await montar("");
    // em 2025 o de maior valor é pago_sem_lastro (289), que não tem ação
    expect(screen.getByRole("button", { name: /Em confirmação de pagamento/ })
      .getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("resolve pela Conferência Prime")).toBeTruthy();
    expect(safrasPedidas()).toEqual(["2025"]);
  });

  it("não gasta a consulta ao vivo de 2026/1 para jogar fora", async () => {
    comoProducao();
    await montar("");
    // nenhuma busca de itens em 2026/1 (que passa de 8s ao vivo)
    expect(safrasPedidas()).not.toContain("2026/1");
  });

  it("se 2026/1 passar a ter caso resolvível, a tela abre nela sozinha", async () => {
    comoProducao({ resolvivel2026: 900 });
    await montar("");
    expect(screen.getByRole("button", { name: /^2026/ }).getAttribute("aria-pressed")).toBe("true");
  });

  it("nenhuma safra com caso resolvível: volta a abrir na corrente", async () => {
    rpcMock.mockImplementation((nome) => {
      if (nome === "carteira_efetividade_ler") {
        return Promise.resolve({ data: RESUMO("x", [SEM_ACAO("em_validacao", 1043)]), error: null });
      }
      return Promise.resolve({ data: [], error: null });
    });
    await montar("");
    expect(screen.getByRole("button", { name: /^2026/ }).getAttribute("aria-pressed")).toBe("true");
  });

  it("a URL manda: link da Efetividade leva à safra que aponta, mesmo sem botão", async () => {
    comoProducao();
    await montar("?ano=2026&semestre=1&motivo=em_validacao");
    expect(screen.getByRole("button", { name: /^2026/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("sem ação automática segura")).toBeTruthy();
    expect(safrasPedidas()).toEqual(["2026/1"]);
  });
});
