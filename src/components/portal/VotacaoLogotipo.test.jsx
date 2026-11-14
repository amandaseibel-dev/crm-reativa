// @vitest-environment jsdom
// Votação do logotipo -- a tela. A garantia de que a contagem não vaza e de que o
// voto é único está em supabase/tests/portal_votacao_logotipo.test.js (banco real);
// aqui se verifica o que a pessoa vê em cada caso.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

const rpcMock = vi.fn();
vi.mock("../../services/supabase", () => ({
  supabase: { rpc: (...a) => rpcMock(...a) },
}));

import VotacaoLogotipo from "./VotacaoLogotipo";
import { mensagemErroVotacao, percentuais, OPCOES_LOGOTIPO } from "./votacaoLogotipo";

const OPCOES_ZERADAS = [1, 2, 3, 4].map((opcao) => ({ opcao, votos: 0 }));

// Responde às RPCs pelo nome. `apuracao` pode ser um erro, para simular o banco recusando.
function responder({ situacao, apuracao = { error: { message: "resultado_indisponivel" } }, votar, encerrar }) {
  rpcMock.mockImplementation(async (nome) => {
    if (nome === "portal_logotipo_situacao") return { data: situacao, error: null };
    if (nome === "portal_logotipo_apuracao") return apuracao.error ? { data: null, error: apuracao.error } : { data: apuracao, error: null };
    if (nome === "portal_logotipo_votar") return votar ?? { data: { ok: true, minha_opcao: 2 }, error: null };
    if (nome === "portal_logotipo_encerrar") return encerrar ?? { data: { ok: true, status: "encerrada" }, error: null };
    throw new Error(`rpc inesperada: ${nome}`);
  });
}

beforeEach(() => {
  rpcMock.mockReset();
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("operador com a votação aberta", () => {
  const situacaoOperador = { existe: true, status: "aberta", minha_opcao: null, gestao: false };

  it("mostra as quatro propostas numeradas, sem contagem", async () => {
    responder({ situacao: situacaoOperador });
    render(<VotacaoLogotipo />);
    await screen.findByText("Você ainda não votou.", { exact: false });
    for (const o of OPCOES_LOGOTIPO) {
      expect(screen.getByText(o.titulo)).toBeTruthy();
    }
    expect(screen.getAllByAltText(/ReATIVA \| Recuperação de Crédito/).length).toBe(OPCOES_LOGOTIPO.length);
    expect(screen.queryByText(/voto(s)? registrado/)).toBeNull();
    expect(screen.queryByText("Acompanhamento (gestão)")).toBeNull();
    expect(rpcMock).not.toHaveBeenCalledWith("portal_logotipo_apuracao");
  });

  it("vota depois de confirmar e bloqueia as demais opções", async () => {
    responder({ situacao: situacaoOperador });
    render(<VotacaoLogotipo />);
    fireEvent.click(await screen.findByRole("button", { name: "Votar na Proposta 2" }));
    await waitFor(() =>
      expect(rpcMock).toHaveBeenCalledWith("portal_logotipo_votar", { p_opcao: 2 })
    );
    expect(await screen.findByText("Voto registrado. Obrigado por participar!")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Voto registrado" }).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Votar na Proposta 1" }).disabled).toBe(true);
  });

  it("não envia o voto se a pessoa cancelar a confirmação", async () => {
    window.confirm.mockReturnValue(false);
    responder({ situacao: situacaoOperador });
    render(<VotacaoLogotipo />);
    fireEvent.click(await screen.findByRole("button", { name: "Votar na Proposta 1" }));
    expect(rpcMock).not.toHaveBeenCalledWith("portal_logotipo_votar", expect.anything());
  });

  it("quem já votou vê o próprio voto e nenhum botão ativo", async () => {
    responder({ situacao: { ...situacaoOperador, minha_opcao: 4 } });
    render(<VotacaoLogotipo />);
    expect(await screen.findByText("Seu voto: Proposta 4.", { exact: false })).toBeTruthy();
    expect(screen.getByText("✓ Seu voto")).toBeTruthy();
    const votos = screen.getAllByRole("button").filter((b) => /^Voto registrado$|^Votar na /.test(b.textContent));
    expect(votos).toHaveLength(OPCOES_LOGOTIPO.length);
    expect(votos.every((b) => b.disabled)).toBe(true);
  });

  it("mostra a mensagem do banco quando o voto é recusado", async () => {
    responder({
      situacao: situacaoOperador,
      votar: { data: null, error: { message: "ja_votou" } },
    });
    render(<VotacaoLogotipo />);
    fireEvent.click(await screen.findByRole("button", { name: "Votar na Proposta 3" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Você já registrou seu voto");
  });
});

describe("cartões com as artes enviadas", () => {
  it("mostra as quatro imagens, cada uma com seu arquivo original", async () => {
    responder({ situacao: { existe: true, status: "aberta", minha_opcao: null, gestao: false } });
    render(<VotacaoLogotipo />);
    await screen.findByText("Proposta 4");
    const imgs = screen.getAllByRole("img");
    expect(imgs.map((i) => i.getAttribute("src"))).toEqual(
      OPCOES_LOGOTIPO.map((o) => o.imagem)
    );
    expect(OPCOES_LOGOTIPO.map((o) => o.imagem.split("/").pop())).toEqual([
      "ReATIVA_opcao_1.png", "ReATIVA_opcao_2.png", "ReATIVA_opcao_3.png", "ReATIVA_opcao_4.png",
    ]);
  });

  it("amplia a imagem ao clicar e fecha com o botão e com Esc", async () => {
    responder({ situacao: { existe: true, status: "aberta", minha_opcao: null, gestao: false } });
    render(<VotacaoLogotipo />);
    fireEvent.click(await screen.findByRole("button", { name: "Ampliar Proposta 3" }));
    expect(await screen.findByRole("dialog", { name: "Proposta 3 ampliada" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Fechar ✕" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Ampliar Proposta 3" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("gestão", () => {
  const situacaoGestao = { existe: true, status: "aberta", minha_opcao: null, gestao: true };
  const apuracao = {
    status: "aberta",
    total: 4,
    opcoes: [
      { opcao: 1, votos: 2 },
      { opcao: 2, votos: 0 },
      { opcao: 3, votos: 1 },
      { opcao: 4, votos: 1 },
    ],
  };

  it("acompanha a contagem com a votação aberta e pode encerrar", async () => {
    responder({ situacao: situacaoGestao, apuracao });
    render(<VotacaoLogotipo />);
    expect(await screen.findByText("Acompanhamento (gestão)")).toBeTruthy();
    expect(screen.getByText("4 votos registrados")).toBeTruthy();
    expect(screen.getByText("2 (50%)")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Encerrar votação" }).disabled).toBe(false);
  });

  it("encerra a votação depois de confirmar e recarrega a tela", async () => {
    responder({
      situacao: situacaoGestao,
      apuracao,
      encerrar: { data: { ok: true, status: "encerrada" }, error: null },
    });
    render(<VotacaoLogotipo />);
    fireEvent.click(await screen.findByRole("button", { name: "Encerrar votação" }));
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith("portal_logotipo_encerrar"));
    expect(await screen.findByText("Votação encerrada.")).toBeTruthy();
  });
});

describe("depois do encerramento", () => {
  it("operador vê o resultado final", async () => {
    responder({
      situacao: { existe: true, status: "encerrada", minha_opcao: 1, gestao: false },
      apuracao: { status: "encerrada", total: 2, opcoes: OPCOES_ZERADAS.map((o) => ({ ...o, votos: o.opcao === 1 ? 2 : 0 })) },
    });
    render(<VotacaoLogotipo />);
    expect(await screen.findByText("Resultado final")).toBeTruthy();
    expect(screen.getByText("2 (100%)")).toBeTruthy();
    expect(screen.queryByText("Acompanhamento (gestão)")).toBeNull();
  });
});

describe("funções puras", () => {
  it("traduz códigos do banco e esconde o detalhe técnico", () => {
    expect(mensagemErroVotacao({ message: "votacao_encerrada" })).toMatch(/encerrada/);
    expect(mensagemErroVotacao({ message: "permission denied for table x" })).toMatch(/Tente novamente/);
  });

  it("calcula percentuais sem dividir por zero", () => {
    expect(percentuais([{ opcao: 1, votos: 0 }], 0)).toEqual([{ opcao: 1, votos: 0, percentual: 0 }]);
    expect(percentuais([{ opcao: 1, votos: 1 }, { opcao: 2, votos: 2 }], 3).map((p) => p.percentual)).toEqual([33, 67]);
  });
});
