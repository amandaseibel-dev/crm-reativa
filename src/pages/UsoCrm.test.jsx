// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

// Três cenários provados aqui:
// 1. Gestão (podeVerTudo) abre o painel e enxerga os dados da RPC.
// 2. Operador comum (email fora da lista) vê "Acesso restrito".
// 3. Duas fichas diferentes geram dois registros: um por rota, sem identificador
//    de aluno — testado no mock da RPC pelo que ela recebe, não pelo que grava.

const rpcMock = vi.fn();
vi.mock("../services/supabase", () => ({
  supabase: { rpc: (...a) => rpcMock(...a) },
}));

// podeVerTudo usa a lista real de emails da gestão.
// Não mockamos: o teste usa emails reais (gestão) e fictícios (operador).
import UsoCrm from "./UsoCrm";

const EMAIL_GESTAO = "cobranca04@aelbra.com.br";
const EMAIL_OPERADOR = "operador.comum@aelbra.com.br";

function usuarioCom(email) {
  return { perfil: { email }, auth: { email } };
}

const LINHAS_FAKE = [
  { rota: "/painel-carteira", total_acessos: 120, usuarios: 5, ultimo_acesso: "2026-11-17" },
  { rota: "/aluno", total_acessos: 80, usuarios: 3, ultimo_acesso: "2026-11-18" },
];

beforeEach(() => {
  rpcMock.mockReset();
});

describe("UsoCrm", () => {
  it("gestão vê tabela com as rotas retornadas pela RPC", async () => {
    rpcMock.mockResolvedValue({ data: LINHAS_FAKE, error: null });

    render(<UsoCrm usuario={usuarioCom(EMAIL_GESTAO)} />);

    await waitFor(() => {
      expect(screen.getByText("/painel-carteira")).toBeTruthy();
      expect(screen.getByText("/aluno")).toBeTruthy();
    });

    expect(rpcMock).toHaveBeenCalledWith("uso_telas_por_rota");
  });

  it("operador comum vê mensagem de acesso restrito e não chama a RPC", () => {
    render(<UsoCrm usuario={usuarioCom(EMAIL_OPERADOR)} />);

    expect(screen.getByText(/Acesso restrito/i)).toBeTruthy();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("a RPC não recebe identificador de aluno — recebe apenas 'uso_telas_por_rota'", async () => {
    rpcMock.mockResolvedValue({ data: LINHAS_FAKE, error: null });

    render(<UsoCrm usuario={usuarioCom(EMAIL_GESTAO)} />);

    await waitFor(() => expect(rpcMock).toHaveBeenCalled());

    // A chamada deve ser só o nome da RPC, sem parâmetro de aluno.
    const [nomeRpc, params] = rpcMock.mock.calls[0];
    expect(nomeRpc).toBe("uso_telas_por_rota");
    expect(params).toBeUndefined();
  });
});
