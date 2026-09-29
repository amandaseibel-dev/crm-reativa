// @vitest-environment jsdom
//
// Testes do piloto. O que eles protegem, em ordem de gravidade:
//   1. UMA CHAMADA POR VEZ -- nunca duas consultas em voo;
//   2. 401/403/429 interrompe o laço na hora;
//   3. Pausar interrompe de verdade (o laço lê um ref, não um estado velho);
//   4. o lote inteiro roda com UM clique, não um clique por aluno;
//   5. quem a ficha já consultou é pulado sem gastar chamada;
//   6. preparar não consulta nada.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, act } from "@testing-library/react";

const rpc = vi.fn();
const invoke = vi.fn();
vi.mock("../services/supabase", () => ({
  supabase: { rpc: (...a) => rpc(...a), functions: { invoke: (...a) => invoke(...a) } },
}));

const { default: PilotoAcademico } = await import("./PilotoAcademico");

const LOTE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function painel(over = {}) {
  return [{
    lote_id: LOTE, recorte: "2026/1", estado: "PRONTO", motivo: null,
    criado_em: "2026-09-29T12:00:00Z", criado_por: "gestao@exemplo.test", encerrado_em: null,
    limite_alunos: 100, limite_requisicoes: 300,
    itens: 3, concluidos: 0, falhas: 0, pendentes: 3, requisicoes_gastas: 0, ...over,
  }];
}

// Fila que entrega N itens e depois manda parar.
function filaDe(n, motivoFinal = "fila vazia") {
  let i = 0;
  return async () => (i < n
    ? { data: { parar: false, item_id: `item-${++i}`, aluno_id: `aluno-${i}`, ordem: i,
                requisicoes_gastas: i - 1, limite_requisicoes: 300 }, error: null }
    : { data: { parar: true, motivo: motivoFinal }, error: null });
}

beforeEach(() => {
  rpc.mockReset(); invoke.mockReset();
  invoke.mockResolvedValue({ data: { ok: true, resultado: "COM_VINCULOS", requisicoes: 1 }, error: null });
});
afterEach(() => cleanup());

async function montarComFila(proximo, over = {}) {
  rpc.mockImplementation(async (nome, args) => {
    if (nome === "prime_academico_piloto_painel") return { data: painel(over), error: null };
    if (nome === "prime_academico_piloto_proximo") return proximo(args);
    if (nome === "prime_academico_piloto_pausar") return { data: { ok: true }, error: null };
    if (nome === "prime_academico_piloto_retomar") return { data: { ok: true }, error: null };
    if (nome === "prime_academico_piloto_criar") return { data: { lote_id: LOTE, itens: 3 }, error: null };
    return { data: null, error: null };
  });
  render(<PilotoAcademico ano="2026" semestre="1" />);
  await screen.findByText(/Piloto da consulta acadêmica/i);
}

describe("piloto — o laço", () => {
  it("UM clique processa o lote inteiro, um aluno por vez", async () => {
    await montarComFila(filaDe(3));
    invoke.mockResolvedValue({ data: { ok: true, resultado: "COM_VINCULOS", requisicoes: 1 }, error: null });

    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: /Iniciar lote/i })); });

    // três alunos, um clique
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(3));
    expect(invoke.mock.calls.map((c) => c[1].body.aluno_id)).toEqual(["aluno-1", "aluno-2", "aluno-3"]);
    // e cada chamada levou o item do piloto junto
    for (const c of invoke.mock.calls) expect(c[1].body.piloto_item_id).toMatch(/^item-\d$/);
  });

  it("nunca há duas consultas em voo ao mesmo tempo", async () => {
    await montarComFila(filaDe(4));
    let emVoo = 0, maximo = 0;
    invoke.mockImplementation(async () => {
      emVoo += 1; maximo = Math.max(maximo, emVoo);
      await new Promise((r) => setTimeout(r, 5));
      emVoo -= 1;
      return { data: { ok: true, resultado: "COM_VINCULOS", requisicoes: 1 }, error: null };
    });

    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: /Iniciar lote/i })); });
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(4));
    expect(maximo).toBe(1);
  });

  it("401/403/429 interrompe o laço na hora, sem tentar o próximo", async () => {
    await montarComFila(filaDe(5));
    invoke.mockResolvedValueOnce({ data: { ok: true, resultado: "COM_VINCULOS", requisicoes: 1 }, error: null })
          .mockResolvedValueOnce({ data: { ok: true, resultado: "FALHA_COMUNICACAO", requisicoes: 1,
                                           piloto: { parar: true, motivo: "API respondeu 429 -- limitacao; lote interrompido" } },
                                   error: null });

    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: /Iniciar lote/i })); });

    expect(await screen.findByText(/429/)).toBeTruthy();
    // parou no segundo: o terceiro nunca foi chamado
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("erro ao falar com a função para o laço, sem insistir", async () => {
    await montarComFila(filaDe(5));
    invoke.mockResolvedValueOnce({ data: { ok: true, resultado: "COM_VINCULOS", requisicoes: 1 }, error: null })
          .mockResolvedValueOnce({ data: null, error: { message: "network down" } });

    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: /Iniciar lote/i })); });

    expect(await screen.findByText(/network down/i)).toBeTruthy();
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("teto de requisições para o laço", async () => {
    await montarComFila(async () => ({
      data: { parar: true, motivo: "teto de requisicoes atingido: 300 de 300" }, error: null }));
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: /Iniciar lote/i })); });
    expect(await screen.findByText(/teto de requisicoes atingido/i)).toBeTruthy();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("piloto — preparar e pausar", () => {
  it("preparar cria a fila e NÃO consulta nada", async () => {
    await montarComFila(filaDe(0));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Preparar lote/i })); });

    await waitFor(() => expect(rpc).toHaveBeenCalledWith("prime_academico_piloto_criar", expect.objectContaining({
      p_ano: "2026", p_semestre: "1", p_limite_alunos: 100, p_limite_requisicoes: 300,
    })));
    expect(invoke).not.toHaveBeenCalled();
    expect(await screen.findByText(/Nenhuma consulta foi feita/i)).toBeTruthy();
  });

  it("o lote interrompido pede retomada explícita antes de rodar", async () => {
    await montarComFila(filaDe(1), { estado: "INTERROMPIDO", motivo: "API respondeu 429" });
    expect(await screen.findByRole("button", { name: /Retomar mesmo assim/i })).toBeTruthy();

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Retomar mesmo assim/i })); });
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("prime_academico_piloto_retomar",
      { p_lote: LOTE, p_forcar: true }));
  });

  it("mostra progresso, requisições e o que foi pulado", async () => {
    await montarComFila(filaDe(0), { itens: 100, concluidos: 80, falhas: 2, pendentes: 5,
                                     requisicoes_gastas: 96, estado: "EM_ANDAMENTO" });
    // O texto e quebrado por <b>, entao a assercao e no PARAGRAFO inteiro --
    // procurar o trecho solto falharia por causa da marcacao, nao do numero.
    await waitFor(() => expect(document.body.textContent).toMatch(/95 de 100/));
    const linhas = [...document.querySelectorAll("p")].map((p) => p.textContent).join(" | ");
    expect(linhas).toMatch(/95 de 100/);      // 100 - 5 pendentes
    expect(linhas).toMatch(/80 consultados/);
    expect(linhas).toMatch(/2 com falha/);
    expect(linhas).toMatch(/13 pulados/);     // 100 - 5 - 80 - 2
    expect(linhas).toMatch(/Requisições: 96 de 300/);
  });
});

describe("piloto — o que a revisão pediu", () => {
  it("registro do item falhou DEPOIS de gravar a consulta: para e explica que dá para reconciliar", async () => {
    await montarComFila(filaDe(3));
    invoke.mockResolvedValueOnce({
      data: { erro: "PILOTO_REGISTRO_FALHOU", detalhe: "deadlock detected",
              consulta_id: "c-1", requisicoes: 2, recuperavel: true },
      error: null });

    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: /Iniciar lote/i })); });

    const msg = await screen.findByText(/a consulta foi gravada/i);
    expect(msg.textContent).toMatch(/deadlock detected/);
    expect(msg.textContent).toMatch(/sem consultar o Prime de novo/i);
    // e o laço parou: o segundo aluno nunca foi chamado
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("sem orçamento, a função recusa e o laço para sem gastar mais", async () => {
    await montarComFila(filaDe(3));
    invoke.mockResolvedValueOnce({
      data: { erro: "PILOTO_SEM_ORCAMENTO", detalhe: "teto de requisicoes esgotado" }, error: null });
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: /Iniciar lote/i })); });
    expect(await screen.findByText(/PILOTO_SEM_ORCAMENTO/)).toBeTruthy();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("item que não é do aluno informado para o laço", async () => {
    await montarComFila(filaDe(3));
    invoke.mockResolvedValueOnce({
      data: { erro: "PILOTO_ITEM_INVALIDO", detalhe: "ITEM_NAO_E_DESTE_ALUNO" }, error: null });
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: /Iniciar lote/i })); });
    expect(await screen.findByText(/ITEM_NAO_E_DESTE_ALUNO/)).toBeTruthy();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("a reconciliação aparece na tela, em vez de acontecer em silêncio", async () => {
    let i = 0;
    await montarComFila(async () => {
      i += 1;
      return i === 1
        ? { data: { parar: false, item_id: "item-1", aluno_id: "aluno-1", ordem: 1,
                    orcamento: 10, reconciliacao: { reconciliados: 2, devolvidos: 1 } }, error: null }
        : { data: { parar: true, motivo: "fila vazia" }, error: null };
    });
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: /Iniciar lote/i })); });
    await waitFor(() => expect(document.body.textContent).toMatch(/2 fechado\(s\) por consulta já gravada/));
    expect(document.body.textContent).toMatch(/1 devolvido\(s\) à fila/);
  });

  it("outra aba segurando os itens: o laço para em vez de concluir o lote", async () => {
    // O servidor responde "itens em processamento em outra aba". Concluir aqui
    // perderia o resultado que a outra aba ainda vai gravar.
    await montarComFila(async () => ({
      data: { parar: true, motivo: "itens em processamento em outra aba" }, error: null }));
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: /Iniciar lote/i })); });
    expect(await screen.findByText(/itens em processamento em outra aba/i)).toBeTruthy();
    expect(invoke).not.toHaveBeenCalled();
  });
});
