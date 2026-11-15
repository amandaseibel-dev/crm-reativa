// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import IndicadoresCarteiraSemestre from "./IndicadoresCarteiraSemestre";

const rpcMock = vi.fn();
vi.mock("../../services/supabase", () => ({
  supabase: { rpc: (...a) => rpcMock(...a) },
}));

afterEach(() => { cleanup(); rpcMock.mockReset(); });

// Dados de stub: só para provar o mapeamento. Não são números de produção.
const RESP_2026_2 = {
  carteira_original: 2100, titulos_carteira: 5, saldo_em_aberto: 950, negociado: 300,
  caixa_confirmado: 100, pagamentos_confirmados: 2, pendente_classificacao: 50,
  pagamentos_pendentes: 1, percentual_recuperado_caixa: 4.8, carteira_fonte: "classificador_2026_2",
  data_referencia: "2026-11-13",
  saldo_2026_2: { saldo_em_conferencia: 100 },
};

describe("IndicadoresCarteiraSemestre (contrato único: RPC efetividade_caixa_resumo_semestre)", () => {
  it("chama a RPC com o semestre da config e exibe os campos prontos", async () => {
    rpcMock.mockResolvedValue({ data: RESP_2026_2, error: null });
    render(<IndicadoresCarteiraSemestre fonte={{ semestre: "2026/2" }} />);
    expect(rpcMock).toHaveBeenCalledWith("efetividade_caixa_resumo_semestre", { p_semestre: "2026/2" });
    expect(await screen.findByText("4,8%")).toBeTruthy();
    expect(screen.getByText("Carteira original")).toBeTruthy();
    expect(screen.getByText(/inclui/)).toBeTruthy();
  });

  it("não chama nenhuma RPC antiga de carteira", async () => {
    rpcMock.mockResolvedValue({ data: RESP_2026_2, error: null });
    render(<IndicadoresCarteiraSemestre fonte={{ semestre: "2026/1" }} />);
    await screen.findByText("Carteira original");
    for (const c of rpcMock.mock.calls) {
      expect(c[0]).toBe("efetividade_caixa_resumo_semestre");
    }
  });

  it("erro de acesso vira aviso neutro, sem vazar a mensagem bruta como permanente", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "sem permissão para o resumo de caixa" } });
    render(<IndicadoresCarteiraSemestre fonte={{ semestre: "2026/2" }} />);
    expect(await screen.findByText(/Indicadores indisponíveis para o seu acesso/)).toBeTruthy();
  });

  it("dado ausente aparece como travessão, não como zero", async () => {
    rpcMock.mockResolvedValue({ data: { ...RESP_2026_2, saldo_em_aberto: null, saldo_2026_2: null }, error: null });
    render(<IndicadoresCarteiraSemestre fonte={{ semestre: "2026/2" }} />);
    await screen.findByText("Saldo em aberto");
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });
});
