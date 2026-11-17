// @vitest-environment jsdom
// Cadastro de token pessoal: campo protegido, valor apagado em qualquer desfecho,
// nada gravado em storage, recusas com mensagem própria.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import ConexaoTokenPessoal from "./ConexaoTokenPessoal";

const TOKEN = "tok_teste_piloto_0123456789abcdef";

afterEach(() => cleanup());

function preencher(valor) {
  fireEvent.change(screen.getByLabelText(/Token pessoal da Mensageria/i), { target: { value: valor } });
}

describe("ConexaoTokenPessoal", () => {
  it("campo do token é senha, sem autocomplete, e o botão começa desabilitado", () => {
    render(<ConexaoTokenPessoal onCadastrar={vi.fn()} />);
    const campo = screen.getByLabelText(/Token pessoal da Mensageria/i);
    expect(campo.type).toBe("password");
    expect(campo.getAttribute("autocomplete")).toBe("off");
    expect(screen.getByRole("button", { name: /Cadastrar token/i }).disabled).toBe(true);
  });

  it("envia token e validade escolhida, apaga o campo e confirma o cadastro", async () => {
    const onCadastrar = vi.fn().mockResolvedValue({ ok: true, pessoa: "Amanda", estado: "ATIVA", expira_em: "x" });
    render(<ConexaoTokenPessoal onCadastrar={onCadastrar} />);
    preencher(TOKEN);
    fireEvent.change(screen.getByLabelText(/Validade/i), { target: { value: "60" } });
    fireEvent.click(screen.getByRole("button", { name: /Cadastrar token/i }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/Token cadastrado/));
    expect(onCadastrar).toHaveBeenCalledWith(TOKEN, 60);
    expect(screen.getByLabelText(/Token pessoal da Mensageria/i).value).toBe("");
  });

  it("recusa da Mensageria: mensagem própria e campo apagado mesmo assim", async () => {
    const onCadastrar = vi.fn().mockResolvedValue({ ok: false, motivo: "TOKEN_RECUSADO_PELA_MENSAGERIA" });
    render(<ConexaoTokenPessoal onCadastrar={onCadastrar} />);
    preencher(TOKEN);
    fireEvent.click(screen.getByRole("button", { name: /Cadastrar token/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/A Mensageria recusou este token/);
    expect(screen.getByLabelText(/Token pessoal da Mensageria/i).value).toBe("");
  });

  it("identidade divergente: aviso específico, nada confirmado", async () => {
    const onCadastrar = vi.fn().mockResolvedValue({ ok: false, motivo: "IDENTIDADE_DIVERGENTE" });
    render(<ConexaoTokenPessoal onCadastrar={onCadastrar} />);
    preencher(TOKEN);
    fireEvent.click(screen.getByRole("button", { name: /Cadastrar token/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/outra pessoa/);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("falha de rede (exceção): mensagem genérica, campo apagado", async () => {
    const onCadastrar = vi.fn().mockRejectedValue(new Error("rede"));
    render(<ConexaoTokenPessoal onCadastrar={onCadastrar} />);
    preencher(TOKEN);
    fireEvent.click(screen.getByRole("button", { name: /Cadastrar token/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Nada foi guardado/);
    expect(screen.getByLabelText(/Token pessoal da Mensageria/i).value).toBe("");
  });

  it("nunca grava o token em localStorage nem sessionStorage", async () => {
    const setLocal = vi.spyOn(Storage.prototype, "setItem");
    const onCadastrar = vi.fn().mockResolvedValue({ ok: true, pessoa: "A", estado: "ATIVA" });
    render(<ConexaoTokenPessoal onCadastrar={onCadastrar} />);
    preencher(TOKEN);
    fireEvent.click(screen.getByRole("button", { name: /Cadastrar token/i }));
    await screen.findByRole("status");
    expect(setLocal).not.toHaveBeenCalled();
    setLocal.mockRestore();
  });
});
