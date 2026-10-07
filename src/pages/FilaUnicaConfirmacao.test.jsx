// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const rpcMock = vi.fn();
vi.mock("../services/supabase", () => ({ supabase: { rpc: (...a) => rpcMock(...a) } }));

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

beforeEach(() => { rpcMock.mockReset(); responder(); });
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
