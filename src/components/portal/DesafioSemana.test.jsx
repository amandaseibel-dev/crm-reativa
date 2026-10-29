// @vitest-environment jsdom
// C1 -- desafio da semana. A autorização de verdade e o cálculo do progresso são
// do banco (supabase/tests/portal_desafio_semana.test.js); aqui se verifica a tela.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent, cleanup } from "@testing-library/react";

const rpcMock = vi.fn();
const fromMock = vi.fn();
vi.mock("../../services/supabase", () => ({
  supabase: { rpc: (...a) => rpcMock(...a), from: (...a) => fromMock(...a) },
}));

import DesafioSemana, { SEM_DESAFIO } from "./DesafioSemana";
import {
  ehMensuravel, temProgresso, percentual, cumprido, periodoLegivel, validarDesafio, INDICADORES,
} from "./desafio";

afterEach(cleanup);

const S = {};
const Card = ({ children }) => <div>{children}</div>;
const CabecalhoCard = ({ titulo, acao }) => <div><strong>{titulo}</strong>{acao}</div>;

const desafio = (extra = {}) => ({
  id: "d1", titulo: "20 elogios até sexta", descricao: "Vamos reconhecer mais.",
  objetivo: "Registrar elogios de atendimento", indicador: "ELOGIOS_PUBLICADOS",
  meta: 20, progresso: 14, inicio_em: "2026-09-28", fim_em: "2026-10-02", ...extra,
});

const desenhar = (podeGerir = false) =>
  act(async () => {
    render(<DesafioSemana usuario={{ email: "a@b.c" }} podeGerir={podeGerir}
      Card={Card} CabecalhoCard={CabecalhoCard} S={S} />);
  });

describe("regras puras do desafio", () => {
  it("a lista de indicadores não tem nada financeiro nem individual", () => {
    const valores = INDICADORES.map((i) => i.valor).join(" ");
    for (const proibido of ["META", "FINANCEIR", "HONORARIO", "ACORDO", "PAGAMENTO", "COBRANCA", "OPERADOR", "RANKING"]) {
      expect(valores).not.toContain(proibido);
    }
    expect(INDICADORES.filter((i) => i.mensuravel).length).toBe(5);
    expect(ehMensuravel("INFORMATIVO")).toBe(false);
  });

  it("temProgresso exige meta E progresso apurados -- nulo não vira zero", () => {
    expect(temProgresso(desafio())).toBe(true);
    expect(temProgresso(desafio({ progresso: null }))).toBe(false);
    expect(temProgresso(desafio({ meta: null }))).toBe(false);
    expect(temProgresso(desafio({ indicador: "INFORMATIVO", meta: null, progresso: null }))).toBe(false);
    expect(temProgresso(null)).toBe(false);
    // progresso 0 é medição legítima, não ausência de medição.
    expect(temProgresso(desafio({ progresso: 0 }))).toBe(true);
  });

  it("percentual e cumprido", () => {
    expect(percentual(desafio())).toBe(70);
    expect(percentual(desafio({ progresso: 0 }))).toBe(0);
    expect(percentual(desafio({ progresso: 30 }))).toBe(100); // nunca passa de 100
    expect(percentual(desafio({ indicador: "INFORMATIVO", meta: null, progresso: null }))).toBeNull();
    expect(cumprido(desafio())).toBe(false);
    expect(cumprido(desafio({ progresso: 20 }))).toBe(true);
  });

  it("periodoLegivel encurta e colapsa dia único", () => {
    expect(periodoLegivel("2026-09-28", "2026-10-02")).toBe("28/09 a 02/10");
    expect(periodoLegivel("2026-09-28", "2026-09-28")).toBe("28/09");
    expect(periodoLegivel(null, null)).toBe("");
  });

  it("validarDesafio cobre título, período e o par indicador/meta", () => {
    const ok = { titulo: "Desafio", indicador: "IDEIAS_ENVIADAS", meta: 5, inicio_em: "2026-09-28", fim_em: "2026-10-04" };
    expect(validarDesafio(ok)).toBeNull();
    expect(validarDesafio({ ...ok, titulo: "ab" })).toContain("título");
    expect(validarDesafio({ ...ok, fim_em: "" })).toContain("período");
    expect(validarDesafio({ ...ok, fim_em: "2026-09-01" })).toContain("fim do período");
    expect(validarDesafio({ ...ok, meta: 0 })).toContain("meta maior que zero");
    expect(validarDesafio({ ...ok, indicador: "INFORMATIVO", meta: 5 })).toContain("informativo não tem meta");
    expect(validarDesafio({ ...ok, indicador: "INFORMATIVO", meta: "" })).toBeNull();
  });
});

describe("exibição", () => {
  beforeEach(() => { rpcMock.mockReset(); fromMock.mockReset(); });

  it("mostra título, descrição, objetivo, progresso e período", async () => {
    rpcMock.mockResolvedValue({ data: [desafio()], error: null });
    await desenhar();

    expect(rpcMock).toHaveBeenCalledWith("portal_desafio_vigente");
    expect(screen.getByText("20 elogios até sexta")).toBeTruthy();
    expect(screen.getByText("Vamos reconhecer mais.")).toBeTruthy();
    expect(screen.getByText(/Registrar elogios de atendimento/)).toBeTruthy();
    expect(screen.getByText("14 / 20")).toBeTruthy();
    expect(screen.getByText("Elogios publicados no período")).toBeTruthy();
    expect(screen.getByText(/28\/09 a 02\/10/)).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("70");
  });

  it("meta alcançada aparece", async () => {
    rpcMock.mockResolvedValue({ data: [desafio({ progresso: 22 })], error: null });
    await desenhar();
    expect(screen.getByText("Meta alcançada 🎉")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("100");
  });

  it("informativo não mostra barra nem número inventado", async () => {
    rpcMock.mockResolvedValue({
      data: [desafio({ titulo: "Semana da escuta", indicador: "INFORMATIVO", meta: null, progresso: null })],
      error: null,
    });
    await desenhar();
    expect(screen.getByText("Semana da escuta")).toBeTruthy();
    expect(screen.getByText("Desafio informativo, sem medição automática.")).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByText(/\/ 0/)).toBeNull();
  });

  it("progresso zero mostra barra em 0 -- medição real, não ausência", async () => {
    rpcMock.mockResolvedValue({ data: [desafio({ progresso: 0 })], error: null });
    await desenhar();
    expect(screen.getByText("0 / 20")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("0");
  });

  it("sem desafio ativo, mostra o estado vazio", async () => {
    rpcMock.mockResolvedValue({ data: [], error: null });
    await desenhar();
    expect(screen.getByText(SEM_DESAFIO)).toBeTruthy();
  });

  it("some da Home quando a migration ainda não foi aplicada", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: "PGRST202" } });
    const { container } = render(<DesafioSemana usuario={{ email: "a@b.c" }} podeGerir
      Card={Card} CabecalhoCard={CabecalhoCard} S={S} />);
    await act(async () => {});
    expect(container.textContent).toBe("");
  });
});

describe("cadastro pela gestão", () => {
  beforeEach(() => { rpcMock.mockReset(); fromMock.mockReset(); });

  it("operador comum não vê o botão de cadastrar", async () => {
    rpcMock.mockResolvedValue({ data: [desafio()], error: null });
    await desenhar(false);
    expect(screen.queryByRole("button", { name: "+ Desafio" })).toBeNull();
  });

  it("gestão cadastra com indicador mensurável e meta", async () => {
    rpcMock.mockResolvedValue({ data: [], error: null });
    const insert = vi.fn(() => Promise.resolve({ error: null }));
    fromMock.mockImplementation(() => ({ insert }));
    await desenhar(true);

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "+ Desafio" })); });
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText("Título do desafio"), { target: { value: "  20 elogios  " } });
      fireEvent.change(screen.getByLabelText("Indicador"), { target: { value: "ELOGIOS_PUBLICADOS" } });
    });
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText("Meta (ex.: 20)"), { target: { value: "20" } });
      fireEvent.change(screen.getByLabelText("Início"), { target: { value: "2026-09-28" } });
      fireEvent.change(screen.getByLabelText("Fim"), { target: { value: "2026-10-04" } });
    });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Salvar desafio" })); });

    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      titulo: "20 elogios", indicador: "ELOGIOS_PUBLICADOS", meta: 20,
      inicio_em: "2026-09-28", fim_em: "2026-10-04",
    }));
  });

  it("informativo envia meta nula, e o campo de meta nem aparece", async () => {
    rpcMock.mockResolvedValue({ data: [], error: null });
    const insert = vi.fn(() => Promise.resolve({ error: null }));
    fromMock.mockImplementation(() => ({ insert }));
    await desenhar(true);

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "+ Desafio" })); });
    expect(screen.queryByPlaceholderText("Meta (ex.: 20)")).toBeNull(); // INFORMATIVO é o padrão

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText("Título do desafio"), { target: { value: "Semana da escuta" } });
      fireEvent.change(screen.getByLabelText("Início"), { target: { value: "2026-09-28" } });
      fireEvent.change(screen.getByLabelText("Fim"), { target: { value: "2026-10-04" } });
    });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Salvar desafio" })); });

    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ indicador: "INFORMATIVO", meta: null }));
  });

  it("recusa do banco por não ser gestão vira mensagem clara, sem SQL cru", async () => {
    const alerta = vi.spyOn(window, "alert").mockImplementation(() => {});
    const erro = vi.spyOn(console, "error").mockImplementation(() => {});
    rpcMock.mockResolvedValue({ data: [], error: null });
    fromMock.mockImplementation(() => ({ insert: () => Promise.resolve({ error: { code: "42501" } }) }));
    await desenhar(true);

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "+ Desafio" })); });
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText("Título do desafio"), { target: { value: "Tentativa" } });
      fireEvent.change(screen.getByLabelText("Início"), { target: { value: "2026-09-28" } });
      fireEvent.change(screen.getByLabelText("Fim"), { target: { value: "2026-10-04" } });
    });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Salvar desafio" })); });

    expect(alerta).toHaveBeenCalledWith("Somente a gestão pode cadastrar desafio.");
    alerta.mockRestore(); erro.mockRestore();
  });

  it("validação da tela barra antes de chamar o banco", async () => {
    const alerta = vi.spyOn(window, "alert").mockImplementation(() => {});
    rpcMock.mockResolvedValue({ data: [], error: null });
    const insert = vi.fn();
    fromMock.mockImplementation(() => ({ insert }));
    await desenhar(true);

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "+ Desafio" })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Salvar desafio" })); });

    expect(insert).not.toHaveBeenCalled();
    expect(alerta).toHaveBeenCalled();
    alerta.mockRestore();
  });
});
