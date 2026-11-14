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
