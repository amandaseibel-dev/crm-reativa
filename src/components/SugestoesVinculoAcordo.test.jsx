// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";

const rpcMock = vi.fn();
vi.mock("../services/supabase", () => ({ supabase: { rpc: (...a) => rpcMock(...a) } }));
import SugestoesVinculoAcordo from "./SugestoesVinculoAcordo";
import { cpfMascarado, dataBR } from "../utils/sugestoesVinculo";

const T = (o) => ({ titulo_id: "t1", documento: "4206257", vencimento: "2026-02-05", valor: 1503.26, situacao: "ABERTO", status: "em_aberto", liquidacao_195: "2026-07-31", ...o });
const L = (o) => ({ acordo_id: "a1", aluno_id: "al1", nome: "Aluna Teste", cpf: "12345678901", responsavel_email: "cobranca06@aelbra.com.br", numero_acordo: "2922", status: "ATIVO",
  criado_em: "2026-08-03T12:00:00Z", valor_total: 3776.66, saldo: 3776.66, nivel: "FORTE", motivo: "UNICO_GRUPO_195_COMPATIVEL", liquidacao_195: "2026-07-31", composicao_hash: "h1",
  titulos: [T(), T({ titulo_id: "t2", documento: "4206258" })], concorrentes: null, qtd_grupos_janela: 1, rejeitada: false, ...o });
let dados;
beforeEach(() => { rpcMock.mockReset(); dados = [L(), L({ acordo_id: "a2", nome: "Aluno Revisao", nivel: "REVISAO", motivo: "ACORDO_CONCORRENTE", composicao_hash: "h2" }),
  L({ acordo_id: "a3", nome: "Aluno Sem", nivel: "SEM_EVIDENCIA", motivo: "SEM_GRUPO_195", composicao_hash: null, titulos: [], liquidacao_195: null }),
  L({ acordo_id: "a4", nome: "Aluno Rejeitado", rejeitada: true, rejeitado_por: "amanda.seibel@aelbra.com.br", rejeitado_em: "2026-09-21T10:00:00Z", motivo_rejeicao: "nao e desse acordo", composicao_hash: "h4" })];
  rpcMock.mockImplementation(async (nome) => (nome === "acordos_vinculo_sugestoes" ? { data: dados, error: null } : { data: { ok: true, titulo_ids: ["t1", "t2"] }, error: null })); });
afterEach(cleanup);

describe("SugestoesVinculoAcordo", () => {
  it("mascara o CPF (3 primeiros e 2 ultimos) e formata datas", () => {
    expect(cpfMascarado("123.456.789-01")).toBe("123.***.***-01"); expect(cpfMascarado(null)).toBe("sem CPF"); expect(dataBR("2026-08-03T12:00:00Z")).toBe("03/08/2026");
  });
  it("abre em 'Sugestao forte' (FORTE no topo), com contagens por filtro e cartao completo", async () => {
    render(<SugestoesVinculoAcordo />);
    await waitFor(() => expect(screen.getAllByTestId("sugestao-card")).toHaveLength(1));
    expect(screen.getByText("Sugestão forte (1)")).toBeTruthy(); expect(screen.getByText("Revisão (1)")).toBeTruthy(); expect(screen.getByText("Sem evidência (1)")).toBeTruthy(); expect(screen.getByText("Rejeitadas (1)")).toBeTruthy();
    const c = screen.getByTestId("sugestao-card").textContent;
    expect(c).toMatch(/Aluna Teste/); expect(c).toMatch(/123\.\*\*\*\.\*\*\*-01/); expect(c).not.toMatch(/12345678901/); expect(c).toMatch(/2922/); expect(c).toMatch(/ATIVO/);
    expect(c).toMatch(/03\/08\/2026/); expect(c).toMatch(/3\.776,66/); expect(c).toMatch(/cobranca06@aelbra.com.br/); expect(c).toMatch(/31\/07\/2026/); expect(c).toMatch(/Único grupo Prime 195/);
  });
  it("expande o cartao e mostra documento, vencimento, valor e liquidacao 195 das mensalidades sugeridas", async () => {
    render(<SugestoesVinculoAcordo />); await waitFor(() => screen.getByTestId("sugestao-card"));
    fireEvent.click(screen.getByText(/Ver 2 mensalidade/));
    const t = screen.getByTestId("titulos-sugeridos").textContent;
    expect(t).toMatch(/4206257/); expect(t).toMatch(/05\/02\/2026/); expect(t).toMatch(/1\.503,26/); expect(t).toMatch(/31\/07\/2026/);
  });
  it("filtros: Revisao e Sem evidencia nao tem 'Confirmar vinculo'; Rejeitadas mostra quem rejeitou e nao oferece botoes", async () => {
    render(<SugestoesVinculoAcordo />); await waitFor(() => screen.getByTestId("sugestao-card"));
    fireEvent.click(screen.getByText("Revisão (1)"));
    expect(screen.getByText("Aluno Revisao")).toBeTruthy(); expect(screen.queryByText("Confirmar vínculo")).toBeNull(); expect(screen.getByText("Rejeitar sugestão")).toBeTruthy();
    fireEvent.click(screen.getByText("Sem evidência (1)"));
    expect(screen.getByText("Aluno Sem")).toBeTruthy(); expect(screen.queryByText("Confirmar vínculo")).toBeNull(); expect(screen.queryByText("Rejeitar sugestão")).toBeNull();
    fireEvent.click(screen.getByText("Rejeitadas (1)"));
    expect(screen.getByText(/Rejeitada por amanda.seibel@aelbra.com.br/)).toBeTruthy(); expect(screen.getByText(/nao e desse acordo/)).toBeTruthy();
    expect(screen.queryByText("Confirmar vínculo")).toBeNull(); expect(screen.queryByText("Rejeitar sugestão")).toBeNull();
  });
  it("Confirmar vinculo: pede confirmacao, chama a RPC de confirmacao (revalida no servidor) com acordo e composicao, e recarrega a fila", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<SugestoesVinculoAcordo />); await waitFor(() => screen.getByTestId("sugestao-card"));
    fireEvent.click(screen.getByText("Confirmar vínculo"));
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith("acordo_vinculo_sugestao_confirmar", { p_acordo_id: "a1", p_composicao_hash: "h1" }));
    await waitFor(() => expect(rpcMock.mock.calls.filter((c) => c[0] === "acordos_vinculo_sugestoes").length).toBeGreaterThanOrEqual(2));
    expect(screen.getByText(/Vínculo confirmado: 2 mensalidade/)).toBeTruthy();
    // a tela NUNCA grava vinculo por conta propria
    expect(rpcMock.mock.calls.map((c) => c[0]).every((n) => ["acordos_vinculo_sugestoes", "acordo_vinculo_sugestao_confirmar"].includes(n))).toBe(true);
  });
  it("cancelar a caixa de confirmacao nao chama nenhuma RPC de escrita", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<SugestoesVinculoAcordo />); await waitFor(() => screen.getByTestId("sugestao-card"));
    fireEvent.click(screen.getByText("Confirmar vínculo"));
    expect(rpcMock.mock.calls.filter((c) => c[0] !== "acordos_vinculo_sugestoes")).toHaveLength(0);
  });
  it("servidor recusa (evidencia mudou): mostra a mensagem, nao diz que vinculou e recarrega", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    rpcMock.mockImplementation(async (nome) => (nome === "acordos_vinculo_sugestoes" ? { data: dados, error: null } : { data: { ok: false, erro: "SUGESTAO_MUDOU" }, error: null }));
    render(<SugestoesVinculoAcordo />); await waitFor(() => screen.getByTestId("sugestao-card"));
    fireEvent.click(screen.getByText("Confirmar vínculo"));
    await waitFor(() => expect(screen.getByText(/A evidência mudou/)).toBeTruthy());
    expect(screen.queryByText(/Vínculo confirmado/)).toBeNull();
  });
  it("Rejeitar sugestao: motivo opcional, chama a RPC de rejeicao com a composicao e recarrega", async () => {
    render(<SugestoesVinculoAcordo />); await waitFor(() => screen.getByTestId("sugestao-card"));
    fireEvent.click(screen.getByText("Rejeitar sugestão"));
    fireEvent.change(screen.getByPlaceholderText("Motivo (opcional)"), { target: { value: "grupo de outro acordo" } });
    fireEvent.click(screen.getByText("Registrar rejeição"));
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith("acordo_vinculo_sugestao_rejeitar", { p_acordo_id: "a1", p_composicao_hash: "h1", p_motivo: "grupo de outro acordo" }));
    await waitFor(() => expect(screen.getByText(/Sugestão rejeitada/)).toBeTruthy());
  });
  it("Abrir ficha delega para a ficha existente", async () => {
    const abrir = vi.fn(); render(<SugestoesVinculoAcordo onAbrirFicha={abrir} />); await waitFor(() => screen.getByTestId("sugestao-card"));
    fireEvent.click(within(screen.getByTestId("sugestao-card")).getByText("Abrir ficha")); expect(abrir).toHaveBeenCalledWith("al1");
  });
});
