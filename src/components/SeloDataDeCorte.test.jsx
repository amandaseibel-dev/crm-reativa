// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import SeloDataDeCorte from "./SeloDataDeCorte";

const rpc = vi.hoisted(() => ({ resposta: null }));

vi.mock("../services/supabase", () => ({
  supabase: { rpc: async () => ({ data: rpc.resposta, error: null }) },
}));

beforeEach(() => { rpc.resposta = null; });
afterEach(() => cleanup());

const EM_DIA = {
  cobre_ate: "2026-08-10",
  dias_desde_o_corte: 29,
  ultimo_bordero_em: "2026-09-05",
  ultimo_bordero_ref: "702",
  dias_sem_bordero: 3,
};

const ATRASADO = {
  cobre_ate: "2026-07-10",
  dias_desde_o_corte: 60,
  ultimo_bordero_em: "2026-08-11",
  ultimo_bordero_ref: "701",
  dias_sem_bordero: 28,
};

describe("selo de data de corte", () => {
  it("diz ate quando os numeros valem", async () => {
    rpc.resposta = EM_DIA;
    render(<SeloDataDeCorte />);
    expect(await screen.findByText(/Números até 10\/08\/2026/)).toBeDefined();
  });

  it("com bordero em dia NAO grita: nada de aviso na tela", async () => {
    rpc.resposta = EM_DIA;
    render(<SeloDataDeCorte />);
    await screen.findByText(/Números até/);
    expect(screen.queryByText(/⚠/)).toBeNull();
    expect(screen.queryByText(/sem borderô/)).toBeNull();
  });

  it("passou de 35 dias sem bordero: vira aviso e diz quantos dias", async () => {
    // 28 dias ainda nao e aviso; 40 e.
    rpc.resposta = { ...ATRASADO, dias_sem_bordero: 40 };
    render(<SeloDataDeCorte />);
    expect(await screen.findByText(/40 dias sem borderô/)).toBeDefined();
  });

  it("28 dias ainda esta dentro do ciclo mensal e NAO vira aviso", async () => {
    rpc.resposta = ATRASADO; // 28 dias
    render(<SeloDataDeCorte />);
    await screen.findByText(/Números até/);
    expect(screen.queryByText(/sem borderô/)).toBeNull();
  });

  it("o bloco explica que o total e um piso quando a base esta atrasada", async () => {
    rpc.resposta = { ...ATRASADO, dias_sem_bordero: 40 };
    render(<SeloDataDeCorte variante="bloco" />);
    expect(await screen.findByText(/A base está desatualizada/)).toBeDefined();
    expect(screen.getByText(/piso, não a inadimplência de hoje/)).toBeDefined();
  });

  it("o bloco em dia informa sem alarmar", async () => {
    rpc.resposta = EM_DIA;
    render(<SeloDataDeCorte variante="bloco" />);
    expect(await screen.findByText("Estado da base")).toBeDefined();
    expect(screen.queryByText(/piso, não a inadimplência/)).toBeNull();
  });

  it("sem resposta do banco o selo simplesmente nao aparece", async () => {
    rpc.resposta = null;
    const { container } = render(<SeloDataDeCorte />);
    await waitFor(() => expect(container.textContent).toBe(""));
  });
});
