// @vitest-environment jsdom
// Comportamento do registro do termo físico com o Supabase SIMULADO no front.
// Não prova a autorização real (isso é do banco, testado na #954). Prova que a
// tela reage corretamente a cada resposta: permissão negada, falha técnica,
// sucesso, e falha de gravação.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { createElement } from "react";

const rpc = vi.fn();
vi.mock("../services/supabase", () => ({ supabase: { rpc: (...a) => rpc(...a) } }));

import RegistroTermoFisico from "./RegistroTermoFisico";

const LEITURA_OK = { situacao: "EM_ANDAMENTO", eventos: [] };

beforeEach(() => {
  rpc.mockReset();
  cleanup();
  vi.spyOn(window, "alert").mockImplementation(() => {});
});

function montar(podeVer) {
  return render(createElement(RegistroTermoFisico, { alunoId: "a0000000-0000-0000-0000-000000000042", podeVer }));
}

describe("RegistroTermoFisico — comportamento", () => {
  it("operação (podeVer=false): não chama a RPC e não renderiza nada", async () => {
    const { container } = montar(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(rpc).not.toHaveBeenCalled();
    expect(container.innerHTML).toBe("");
  });

  it("gestão: leitura com sucesso mostra a situação", async () => {
    rpc.mockResolvedValue({ data: LEITURA_OK, error: null });
    montar(true);
    const { container } = montar(true);
    await screen.findByText(/Situação atual/);
    expect(container.textContent).toMatch(/Situação atual: Termo físico assinado, em andamento/);
    expect(rpc).toHaveBeenCalledWith("termo_fisico_ler", { p_aluno_id: "a0000000-0000-0000-0000-000000000042" });
  });

  it("gestão: permissão negada (42501) faz o componente sumir, sem aviso de falha", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "sem permissão" } });
    const { container } = montar(true);
    await waitFor(() => expect(rpc).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML).toBe("");
    expect(screen.queryByText(/indisponível/)).toBeNull();
  });

  it("gestão: falha técnica (função ausente, PGRST202) mostra aviso de indisponível", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "Could not find the function" } });
    montar(true);
    expect(await screen.findByText(/Registro do termo físico indisponível/)).toBeTruthy();
    expect(screen.getByText(/PGRST202/)).toBeTruthy();
  });

  it("gestão: falha de cliente na leitura (exceção) mostra aviso, não some em silêncio", async () => {
    rpc.mockRejectedValue(new Error("Failed to fetch"));
    montar(true);
    expect(await screen.findByText(/Registro do termo físico indisponível/)).toBeTruthy();
  });

  it("gravação negada (42501) faz o componente sumir", async () => {
    rpc
      .mockResolvedValueOnce({ data: LEITURA_OK, error: null })
      .mockResolvedValueOnce({ data: null, error: { code: "42501", message: "sem permissão" } });
    const { container } = montar(true);
    await screen.findByText(/Situação atual/);
    fireEvent.click(screen.getByRole("button", { name: "Registrar" }));
    await waitFor(() => expect(container.innerHTML).toBe(""));
    expect(window.alert).toHaveBeenCalledWith(expect.stringMatching(/não tem permissão/));
  });

  it("gravação com falha técnica NÃO afirma que nada foi gravado", async () => {
    rpc
      .mockResolvedValueOnce({ data: LEITURA_OK, error: null })
      .mockResolvedValueOnce({ data: null, error: { code: "08006", message: "conexão caiu" } });
    montar(true);
    await screen.findByText(/Situação atual/);
    fireEvent.click(screen.getByRole("button", { name: "Registrar" }));
    await waitFor(() => expect(window.alert).toHaveBeenCalled());
    const msg = window.alert.mock.calls[0][0];
    expect(msg).toMatch(/Não foi possível confirmar/);
    expect(msg).toMatch(/Confira o histórico/);
    expect(msg).not.toMatch(/nada foi gravado/i);
  });

  it("gravação com sucesso recarrega a leitura", async () => {
    rpc
      .mockResolvedValueOnce({ data: LEITURA_OK, error: null })
      .mockResolvedValueOnce({ data: { ok: true }, error: null })
      .mockResolvedValueOnce({ data: { situacao: "ARQUIVADO", eventos: [] }, error: null });
    const { container } = montar(true);
    await screen.findByText(/Situação atual/);
    fireEvent.click(screen.getByRole("button", { name: "Registrar" }));
    await waitFor(() => expect(container.textContent).toMatch(/Situação atual: Termo físico arquivado/));
  });
});
