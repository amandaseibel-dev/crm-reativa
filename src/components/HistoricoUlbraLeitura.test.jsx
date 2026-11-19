// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import fs from "node:fs";
import HistoricoUlbraLeitura from "./HistoricoUlbraLeitura";

const pagina = { ok: true, pagina: { mensagens: [{ direcao: "ENTRADA", em: "10/11 09:00", texto: "oi", autor: null, anexos: [] }], antes_de: null } };

describe("HistoricoUlbraLeitura (somente leitura)", () => {
  afterEach(() => cleanup());
  it("NAO chama a leitura ao montar", () => {
    const leitor = vi.fn();
    render(<HistoricoUlbraLeitura conversaId="c1" leitor={leitor} />);
    expect(leitor).not.toHaveBeenCalled();
  });

  it("chama exatamente UMA vez por clique e mostra a mensagem", async () => {
    const leitor = vi.fn().mockResolvedValue(pagina);
    render(<HistoricoUlbraLeitura conversaId="c1" leitor={leitor} />);
    fireEvent.click(screen.getByRole("button", { name: /Carregar histórico/ }));
    await waitFor(() => expect(screen.getByText("oi")).toBeTruthy());
    expect(leitor).toHaveBeenCalledTimes(1);
    expect(leitor).toHaveBeenCalledWith("c1", null);
  });

  it("nao chama ao trocar de conversa sem clique", () => {
    const leitor = vi.fn().mockResolvedValue(pagina);
    const { rerender } = render(<HistoricoUlbraLeitura conversaId="c1" leitor={leitor} />);
    rerender(<HistoricoUlbraLeitura conversaId="c2" leitor={leitor} />);
    expect(leitor).not.toHaveBeenCalled();
  });

  it("nao renderiza controles de conexao, envio ou OAuth", () => {
    const leitor = vi.fn();
    const { container } = render(<HistoricoUlbraLeitura conversaId="c1" leitor={leitor} />);
    const texto = container.textContent.toLowerCase();
    for (const termo of ["conectar", "enviar", "confirmar envio", "prévia", "previa", "autorizar"]) {
      expect(texto.includes(termo)).toBe(false);
    }
  });

  it("codigo do painel e do cliente nao referencia conexao, envio nem OAuth", () => {
    for (const f of ["./HistoricoUlbraLeitura.jsx", "../utils/ulbraHistoricoCliente.js"]) {
      const src = fs.readFileSync(new URL(f, import.meta.url), "utf8");
      expect(/conexao_|envio_|oauth|envioConfirmar|envioPrevia|conexaoIniciar/i.test(src)).toBe(false);
    }
  });
});

// Histórico completo: CPF FICTÍCIO com e sem pontuação é mascarado; o resto do texto fica.
describe("HistoricoUlbraLeitura — CPF no texto completo (dados fictícios)", () => {
  afterEach(() => cleanup());
  it("mensagens com CPF (formatado, só dígitos e telefone) são mascaradas sem apagar o resto", async () => {
    const leitor = vi.fn().mockResolvedValue({
      ok: true,
      pagina: {
        mensagens: [
          { direcao: "ENTRADA", em: "10/11 09:00", texto: "meu CPF 529.982.247-25 pode conferir?", autor: null, anexos: [] },
          { direcao: "SAIDA", em: "10/11 09:05", texto: "cpf 52998224725 obrigada", autor: null, anexos: [] },
          { direcao: "ENTRADA", em: "10/11 09:10", texto: "me liga no 11987654321", autor: null, anexos: [] },
        ],
        antes_de: null,
      },
    });
    const { container } = render(<HistoricoUlbraLeitura conversaId="c1" leitor={leitor} />);
    fireEvent.click(screen.getByRole("button", { name: /Carregar histórico/ }));
    await waitFor(() => expect(container.textContent).toContain("pode conferir?"));
    const texto = container.textContent || "";
    expect(texto).toContain("meu CPF ***.***.***-25 pode conferir?");
    expect(texto).toContain("cpf ***.***.***-25 obrigada");
    expect(texto).toContain("me liga no 11987654321");
    expect(texto).not.toContain("529.982.247-25");
    expect(texto).not.toContain("52998224725");
  });
});
