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

  it("exibe os valores de 2026/1 vindos da RPC", async () => {
    rpcMock.mockResolvedValue({ data: { ...RESP_2026_2, carteira_original: 21710447.29, saldo_em_aberto: 9055032.58, caixa_confirmado: 535206.14, percentual_recuperado_caixa: 2.5, saldo_2026_2: null }, error: null });
    render(<IndicadoresCarteiraSemestre fonte={{ semestre: "2026/1" }} />);
    expect(await screen.findByText("2,5%")).toBeTruthy();
    expect(screen.getByText("R$ 535.206,14")).toBeTruthy();
  });

  it("falha de rede vira aviso neutro, não 'sem dados'", async () => {
    rpcMock.mockRejectedValue(new Error("network down"));
    render(<IndicadoresCarteiraSemestre fonte={{ semestre: "2026/2" }} />);
    expect(await screen.findByText(/indisponíveis para o seu acesso ou no momento/)).toBeTruthy();
    expect(screen.queryByText(/Sem dados de carteira/)).toBeNull();
  });

  it("erro de acesso vira aviso neutro, sem vazar a mensagem bruta como permanente", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "sem permissão para o resumo de caixa" } });
    render(<IndicadoresCarteiraSemestre fonte={{ semestre: "2026/2" }} />);
    expect(await screen.findByText(/indisponíveis para o seu acesso ou no momento/)).toBeTruthy();
    expect(screen.queryByText(/sem permissão/)).toBeNull();
  });

  it("dado ausente aparece como travessão, não como zero", async () => {
    rpcMock.mockResolvedValue({ data: { ...RESP_2026_2, saldo_em_aberto: null, saldo_2026_2: null }, error: null });
    render(<IndicadoresCarteiraSemestre fonte={{ semestre: "2026/2" }} />);
    await screen.findByText("Saldo em aberto");
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("mostra aviso de defasagem quando a fotografia está pendente", async () => {
    rpcMock.mockResolvedValue({ data: { ...RESP_2026_2, fotografia_atualizacao_pendente: true, fotografia_gerada_em: "2026-10-29T13:10:00Z", base_carteira: "fotografia seis_linhas, entrou" }, error: null });
    render(<IndicadoresCarteiraSemestre fonte={{ semestre: "2026/1" }} />);
    expect(await screen.findByText(/atualização pendente/)).toBeTruthy();
    expect(screen.getByText(/Base da carteira original: fotografia seis_linhas, entrou/)).toBeTruthy();
  });
});
