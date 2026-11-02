// @vitest-environment jsdom
// Cenários cobertos (espelham os 5 cenários do §11):
//   1. Operador registra o próprio atendimento → RPC chamada com e-mail próprio
//   2. Operador tenta registrar por terceiro → RPC NÃO chamada (bloqueio de UI)
//   3. Gestão/supervisão registra por outro → botão visível e RPC chamada
//   4. (idempotência WhatsApp) → coberta em fila_receptivo_idempotencia.test.sql
//   5. Operador vê apenas seu próprio botão "Marcar" na lista

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import FilaReceptivo from "./FilaReceptivo";

afterEach(cleanup);

// ──────────────────────────────────────────────────────────────
// Mock do supabase: controla quais operadores estão na fila e
// captura as chamadas à RPC.
// ──────────────────────────────────────────────────────────────
const { rpcMock } = vi.hoisted(() => ({
  rpcMock: vi.fn().mockResolvedValue({ error: null }),
}));

vi.mock("../services/supabase", () => ({
  supabase: {
    from: (tabela) => ({
      select: () => ({
        eq: () => ({
          data: tabela === "usuarios"
            ? [
                { id: "u1", email: "op1@aelbra.com.br", apelido: "Op Um", receptivo: true },
                { id: "u2", email: "op2@aelbra.com.br", apelido: "Op Dois", receptivo: true },
              ]
            : null,
          error: null,
        }),
        in: () => ({
          data: [
            {
              email: "op1@aelbra.com.br", nome: "Op Um",
              atendimentos_hoje: 2, ultimo_atendimento: new Date(Date.now() - 60000).toISOString(),
              online_em: new Date().toISOString(), em_pausa: false,
            },
            {
              email: "op2@aelbra.com.br", nome: "Op Dois",
              atendimentos_hoje: 3, ultimo_atendimento: new Date(Date.now() - 120000).toISOString(),
              online_em: new Date().toISOString(), em_pausa: false,
            },
          ],
          error: null,
        }),
      }),
    }),
    rpc: rpcMock,
  },
}));

vi.mock("../utils/polling", () => ({
  default: (fn) => {
    // Chama uma vez de forma assíncrona após o mount para popular o estado.
    setTimeout(fn, 0);
  },
}));

vi.mock("../components/AvatarFoto", () => ({
  AvatarFoto: ({ nome }) => <span data-testid="avatar">{nome?.[0] ?? "?"}</span>,
}));

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────
const operadorComum = { email: "op1@aelbra.com.br", perfil: "cobranca" };
const gestaoUser   = { email: "gestao@aelbra.com.br", perfil: "gerencia" };
const supervisao   = { email: "sup@aelbra.com.br", perfil: "supervisor" };
const admin        = { email: "adm@aelbra.com.br", perfil: "administrativo" };

function montar(usuario) {
  return render(<FilaReceptivo usuarioLogado={usuario} />);
}

// ──────────────────────────────────────────────────────────────
// Cenário 1: operador registra o próprio atendimento
// ──────────────────────────────────────────────────────────────
describe("Cenário 1 — operador registra o próprio atendimento", () => {
  beforeEach(() => rpcMock.mockClear());

  it("botão 'Marcar' na sua própria linha chama a RPC com seu e-mail", async () => {
    montar(operadorComum);
    await waitFor(() => screen.getByText("Op Um"));

    const botoesMarcar = screen.getAllByTitle(/Marcar um atendimento para Op Um/);
    expect(botoesMarcar.length).toBeGreaterThan(0);
    fireEvent.click(botoesMarcar[0]);

    await waitFor(() =>
      expect(rpcMock).toHaveBeenCalledWith(
        "fila_receptivo_marcar_atendido",
        expect.objectContaining({ p_email: "op1@aelbra.com.br" })
      )
    );
  });
});

// ──────────────────────────────────────────────────────────────
// Cenário 2: operador comum NÃO vê botão "Marcar" na linha alheia
// ──────────────────────────────────────────────────────────────
describe("Cenário 2 — operador comum não pode registrar por terceiro", () => {
  it("botão 'Marcar' não aparece na linha do outro operador", async () => {
    montar(operadorComum);
    await waitFor(() => screen.getByText("Op Dois"));

    // Nenhum botão com título referente a Op Dois deve existir
    const botoesAlheios = screen.queryAllByTitle(/Marcar um atendimento para Op Dois/);
    expect(botoesAlheios).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────
// Cenário 3a: gestão (perfil gerencia) vê e usa botão na linha alheia
// ──────────────────────────────────────────────────────────────
describe("Cenário 3a — gestão (gerencia) registra por outro operador", () => {
  beforeEach(() => rpcMock.mockClear());

  it("gestão vê o botão 'Marcar' na linha alheia e a RPC é chamada", async () => {
    montar(gestaoUser);
    await waitFor(() => screen.getByText("Op Um"));

    const botao = screen.getByTitle(/Marcar um atendimento para Op Um/);
    expect(botao).toBeTruthy();
    fireEvent.click(botao);

    await waitFor(() =>
      expect(rpcMock).toHaveBeenCalledWith(
        "fila_receptivo_marcar_atendido",
        expect.objectContaining({ p_email: "op1@aelbra.com.br" })
      )
    );
  });
});

// ──────────────────────────────────────────────────────────────
// Cenário 3b: supervisão (perfil supervisor) — mesmo comportamento
// ──────────────────────────────────────────────────────────────
describe("Cenário 3b — supervisão registra por outro operador", () => {
  beforeEach(() => rpcMock.mockClear());

  it("supervisão vê o botão 'Marcar' na linha alheia", async () => {
    montar(supervisao);
    await waitFor(() => screen.getByText("Op Dois"));
    expect(screen.queryAllByTitle(/Marcar um atendimento para Op Dois/).length).toBeGreaterThan(0);
  });
});

// ──────────────────────────────────────────────────────────────
// Cenário 3c: administrativo — também autorizado
// ──────────────────────────────────────────────────────────────
describe("Cenário 3c — administrativo registra por outro operador", () => {
  it("administrativo vê o botão 'Marcar' na linha alheia", async () => {
    montar(admin);
    await waitFor(() => screen.getByText("Op Um"));
    expect(screen.queryAllByTitle(/Marcar um atendimento para Op Um/).length).toBeGreaterThan(0);
  });
});

// ──────────────────────────────────────────────────────────────
// Cenário 5: operador comum só vê botão na sua própria linha
// ──────────────────────────────────────────────────────────────
describe("Cenário 5 — operador só vê 'Marcar' na própria linha", () => {
  it("botão aparece para Op Um mas não para Op Dois", async () => {
    montar(operadorComum);
    await waitFor(() => screen.getByText("Op Dois"));

    expect(screen.queryAllByTitle(/Marcar um atendimento para Op Um/).length).toBeGreaterThan(0);
    expect(screen.queryAllByTitle(/Marcar um atendimento para Op Dois/)).toHaveLength(0);
  });
});
