// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import NotificacoesUlbra from "./NotificacoesUlbra";

vi.mock("../services/supabase", () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { access_token: "tok123" } },
      }),
    },
  },
}));

vi.stubEnv("VITE_SUPABASE_URL", "http://localhost:54321");

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterEach(cleanup);

const LEADS = [
  { id: "lead-1", nome: "Ângela Gabryela", criado_em: "2026-11-01T10:00:00Z" },
  { id: "lead-2", nome: "Evelen Arrieche", criado_em: "2026-11-01T11:00:00Z" },
];

describe("NotificacoesUlbra", () => {
  it("não renderiza nada quando lista está vazia", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ leads: [] }),
    });

    const { container } = render(<NotificacoesUlbra />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(container.firstChild).toBeNull();
  });

  it("exibe badge com contagem de leads", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ leads: LEADS }),
    });

    render(<NotificacoesUlbra />);
    await waitFor(() => expect(screen.getByText("2")).toBeTruthy());
  });

  it("exibe nomes dos leads ao abrir painel", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ leads: LEADS }),
    });

    render(<NotificacoesUlbra />);
    await waitFor(() => expect(screen.getByText("2")).toBeTruthy());

    fireEvent.click(screen.getByRole("button"));

    expect(screen.getByText("Ângela Gabryela")).toBeTruthy();
    expect(screen.getByText("Evelen Arrieche")).toBeTruthy();
  });

  it("chama onAssumirLead com o lead correto", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ leads: [LEADS[0]] }),
    });

    const onAssumir = vi.fn();
    render(<NotificacoesUlbra onAssumirLead={onAssumir} />);
    await waitFor(() => expect(screen.getByText("1")).toBeTruthy());

    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(screen.getByRole("button", { name: /assumir/i }));

    expect(onAssumir).toHaveBeenCalledWith(LEADS[0]);
  });

  it("não renderiza nada quando resposta é NAO_RECEPTIVO", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ leads: [], motivo: "NAO_RECEPTIVO" }),
    });

    const { container } = render(<NotificacoesUlbra />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(container.firstChild).toBeNull();
  });

  it("idempotência: mesmo lead não duplica no estado após segunda chamada", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ leads: [LEADS[0]] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ leads: [LEADS[0]] }) });

    render(<NotificacoesUlbra />);
    await waitFor(() => expect(screen.getByText("1")).toBeTruthy());
    expect(screen.queryByText("2")).toBeNull();
  });

  it("persiste IDs vistos em sessionStorage após primeira notificação", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ leads: [LEADS[0]] }),
    });

    render(<NotificacoesUlbra />);
    await waitFor(() => expect(screen.getByText("1")).toBeTruthy());

    const raw = sessionStorage.getItem("ulbra_leads_vistos");
    expect(raw).toBeTruthy();
    const vistos = JSON.parse(raw);
    expect(vistos).toContain("lead-1");
  });

  it("lead em sessionStorage ainda aparece na lista operacional após reload", async () => {
    // Simular reload: lead-1 já foi notificado (presente no sessionStorage)
    // Mas ainda está em waiting no sistema — deve continuar visível para operação
    sessionStorage.setItem("ulbra_leads_vistos", JSON.stringify(["lead-1"]));

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ leads: [LEADS[0]] }),
    });

    render(<NotificacoesUlbra />);

    // Lead ainda está em waiting: deve aparecer no badge mesmo após reload
    await waitFor(() => expect(screen.getByText("1")).toBeTruthy());
  });

  it("lead em sessionStorage não é salvo novamente (sem re-notificação)", async () => {
    // vistos antes do mount
    sessionStorage.setItem("ulbra_leads_vistos", JSON.stringify(["lead-1"]));

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ leads: [LEADS[0]] }),
    });

    render(<NotificacoesUlbra />);
    await waitFor(() => expect(screen.getByText("1")).toBeTruthy());

    // salvarVistos não é chamado para leads que já estavam no vistoRef
    const vistos = JSON.parse(sessionStorage.getItem("ulbra_leads_vistos") ?? "[]");
    expect(vistos).toEqual(["lead-1"]); // inalterado — não sobrescrito
  });
});
