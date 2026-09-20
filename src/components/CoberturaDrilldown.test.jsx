// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup, within } from "@testing-library/react";

const rpcMock = vi.fn();
vi.mock("../services/supabase", () => ({ supabase: { rpc: (...a) => rpcMock(...a) } }));

import CoberturaPorAno from "./CoberturaDrilldown";

const FILTROS = { operador: "TODOS", canal: "WHATSAPP", valor_min: 0, valor_max: null, recencia_dias: 10 };
const COBERTURA = {
  mes_referencia: "2026-09",
  linhas: [
    { ano: 2025, base: 100, acionados: 30, sem_acionamento: 70, pct_acionado: 30, disponiveis: 50, disponiveis_total: 60,
      indisponiveis: 20, motivos: { quitado: 15, retorno_futuro: 5 }, reconcilia: true },
    { ano: 2026, base: 40, acionados: 10, sem_acionamento: 30, pct_acionado: 25, disponiveis: 25, disponiveis_total: 28,
      indisponiveis: 5, motivos: { quitado: 5 }, reconcilia: false },
  ],
  total: { ano: null, base: 120, acionados: 35, sem_acionamento: 85, pct_acionado: 29.17, disponiveis: 70, disponiveis_total: 80,
    indisponiveis: 15, motivos: { quitado: 12, retorno_futuro: 3 }, reconcilia: true },
};

beforeEach(() => {
  rpcMock.mockReset();
  rpcMock.mockImplementation(async (nome, args) => {
    if (nome === "acoes_massivas_cobertura_por_ano") return { data: COBERTURA };
    if (nome === "acoes_massivas_drilldown") {
      return { data: { total: 85, itens: [{ aluno_id: "x1", nome: "Ana ***", cpf_final: "1234", anos: [2025], unidade: "CANOAS",
        curso: "EAD", situacao_academica: "Matriculado", responsavel_email: null, valor: 100, ultimo_acionamento: null,
        disponivel: false, motivo: args.p_motivo || "quitado", motivo_texto: "Quitado" }] } };
    }
    return { data: null };
  });
});
afterEach(cleanup);

async function carregar() {
  render(<CoberturaPorAno filtros={FILTROS} />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Carregar cobertura/ })); });
}
const ultimoDrill = () => rpcMock.mock.calls.filter(([n]) => n === "acoes_massivas_drilldown").at(-1)[1];

describe("Cobertura do mês por ano", () => {
  it("chama a RPC com os filtros e mostra linhas por ano, TOTAL e selos de reconciliação", async () => {
    await carregar();
    expect(rpcMock).toHaveBeenCalledWith("acoes_massivas_cobertura_por_ano", { p_filtros: FILTROS });
    const linhas = screen.getAllByRole("row").map((r) => r.textContent);
    expect(linhas.some((t) => t.startsWith("2025") && t.includes("reconcilia ✓"))).toBe(true);
    expect(linhas.some((t) => t.startsWith("2026") && t.includes("não reconcilia"))).toBe(true);
    expect(linhas.some((t) => t.startsWith("TOTAL") && t.includes("120"))).toBe(true);
  });

  it("clicar na base do TOTAL abre o drill com p_ano null e o total bate com o número clicado", async () => {
    await carregar();
    const total = screen.getAllByRole("row").find((r) => r.textContent.startsWith("TOTAL"));
    await act(async () => { fireEvent.click(within(total).getByRole("button", { name: "120" })); });
    expect(ultimoDrill()).toEqual({ p_filtros: FILTROS, p_ano: null, p_indicador: "base", p_motivo: null, p_limit: 50, p_offset: 0 });
    expect(screen.getByTestId("drill-total").textContent).toContain("85 alunos");
  });

  it("a coluna de disponíveis (sem acionamento) usa disponiveis_sem_acionamento e o total da seleção usa disponiveis", async () => {
    await carregar();
    const l2025 = screen.getAllByRole("row").find((r) => r.textContent.startsWith("2025"));
    await act(async () => { fireEvent.click(within(l2025).getByRole("button", { name: "50" })); });
    expect(ultimoDrill()).toMatchObject({ p_ano: 2025, p_indicador: "disponiveis_sem_acionamento" });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Fechar" })); });
    await act(async () => { fireEvent.click(within(l2025).getByRole("button", { name: "60" })); });
    expect(ultimoDrill()).toMatchObject({ p_ano: 2025, p_indicador: "disponiveis" });
  });

  it("indisponíveis mostram a quebra por motivo e clicar no motivo chama o drill com p_motivo", async () => {
    await carregar();
    const l2025 = screen.getAllByRole("row").find((r) => r.textContent.startsWith("2025"));
    await act(async () => { fireEvent.click(within(l2025).getByRole("button", { name: "20" })); });
    expect(ultimoDrill()).toMatchObject({ p_ano: 2025, p_indicador: "indisponiveis", p_motivo: null });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Quitado: 15/ })); });
    expect(ultimoDrill()).toMatchObject({ p_ano: 2025, p_indicador: "indisponiveis", p_motivo: "quitado" });
    expect(screen.getByRole("button", { name: /Retorno futuro: 5/ })).toBeTruthy();
  });

  it("pagina o drill com offset", async () => {
    await carregar();
    const total = screen.getAllByRole("row").find((r) => r.textContent.startsWith("TOTAL"));
    await act(async () => { fireEvent.click(within(total).getByRole("button", { name: "35" })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Próxima" })); });
    expect(ultimoDrill()).toMatchObject({ p_indicador: "acionados", p_offset: 50 });
  });
});

describe("clareza da disponibilidade: nomes explícitos, canal e legenda", () => {
  const cabecalhos = () => screen.getAllByRole("columnheader").map((h) => h.textContent);

  it("com canal WhatsApp, cada universo tem um nome próprio (nenhum 'Disponíveis' solto)", async () => {
    await carregar();
    const c = cabecalhos().join(" | ");
    expect(c).toContain("Base");
    expect(c).toContain("Sem acionamento no mês");
    expect(c).toContain("Disponíveis para WhatsApp");
    expect(c).toContain("sem acionamento no mês");
    expect(c).toContain("Disponíveis para WhatsApp — total");
    expect(c).toContain("seleção atual, inclui já acionados");
    expect(c).toContain("Indisponíveis para WhatsApp");
    // os dois números de "disponíveis" têm cabeçalhos DIFERENTES
    const disp = cabecalhos().filter((h) => h.startsWith("Disponíveis"));
    expect(disp.length).toBe(2);
    expect(new Set(disp).size).toBe(2);
    expect(cabecalhos().some((h) => h === "Disponíveis agora" || h === "Disponíveis (total)")).toBe(false);
  });

  it("tooltips dizem o universo e que a disponibilidade considera os filtros, inclusive o canal", async () => {
    await carregar();
    const th = screen.getAllByRole("columnheader").find((h) => h.textContent.startsWith("Disponíveis para WhatsApp — total"));
    expect(th.getAttribute("title")).toMatch(/inclui quem já foi acionado no mês/);
    expect(th.getAttribute("title")).toMatch(/inclusive o canal \(WhatsApp\)/);
    const thSem = screen.getAllByRole("columnheader").find((h) => h.textContent.startsWith("Disponíveis para WhatsApp") && !h.textContent.includes("— total"));
    expect(thSem.getAttribute("title")).toMatch(/entre os que estão sem acionamento/);
  });

  it("legenda mostra a conta que fecha e explica o motivo 'sem contato válido' do canal", async () => {
    await carregar();
    const l = screen.getByTestId("legenda-disponibilidade").textContent;
    expect(l).toContain("Disponíveis para WhatsApp + Indisponíveis para WhatsApp = Sem acionamento no mês");
    expect(l).toContain("Sem contato válido para o canal");
  });

  it("sem canal, os nomes falam em 'filtros atuais' (sem inventar canal)", async () => {
    render(<CoberturaPorAno filtros={{ ...FILTROS, canal: null }} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Carregar cobertura/ })); });
    const c = cabecalhos().join(" | ");
    expect(c).toContain("Disponíveis nos filtros atuais");
    expect(c).toContain("Indisponíveis nos filtros atuais");
    expect(c).not.toContain("WhatsApp");
    expect(screen.getByTestId("legenda-disponibilidade").textContent).not.toContain("Sem contato válido");
  });

  it("canal E-mail troca o nome nos cabeçalhos", async () => {
    render(<CoberturaPorAno filtros={{ ...FILTROS, canal: "EMAIL" }} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Carregar cobertura/ })); });
    expect(cabecalhos().join(" | ")).toContain("Disponíveis para E-mail");
    expect(cabecalhos().join(" | ")).not.toContain("WhatsApp");
  });

  it("o drill-down de disponibilidade tem título explícito e o aviso de filtros/canal; o de base não tem aviso", async () => {
    await carregar();
    const l2025 = screen.getAllByRole("row").find((r) => r.textContent.startsWith("2025"));
    await act(async () => { fireEvent.click(within(l2025).getByRole("button", { name: "50" })); });
    const modal = screen.getByRole("dialog");
    expect(modal.textContent).toContain("Disponíveis para WhatsApp — sem acionamento no mês — ano 2025");
    expect(screen.getByTestId("drill-aviso-filtros").textContent).toMatch(/considera os filtros atuais da tela, inclusive o canal \(WhatsApp\)/);
    expect(modal.textContent).toContain("Disponibilidade (WhatsApp)");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Fechar" })); });
    await act(async () => { fireEvent.click(within(l2025).getByRole("button", { name: "60" })); });
    expect(screen.getByRole("dialog").textContent).toContain("Disponíveis para WhatsApp — total da seleção atual (inclui quem já foi acionado no mês)");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Fechar" })); });
    await act(async () => { fireEvent.click(within(l2025).getByRole("button", { name: "100" })); });
    expect(screen.queryByTestId("drill-aviso-filtros")).toBeNull();
    expect(screen.getByRole("dialog").textContent).toContain("Base — ano 2025");
  });

  it("os números NÃO mudam: só os nomes (as RPCs recebem os mesmos parâmetros de antes)", async () => {
    await carregar();
    expect(rpcMock).toHaveBeenCalledWith("acoes_massivas_cobertura_por_ano", { p_filtros: FILTROS });
    const total = screen.getAllByRole("row").find((r) => r.textContent.startsWith("TOTAL"));
    expect(within(total).getByRole("button", { name: "70" })).toBeTruthy();   // disponíveis (sem acionamento)
    expect(within(total).getByRole("button", { name: "80" })).toBeTruthy();   // total da seleção
    expect(within(total).getByRole("button", { name: "15" })).toBeTruthy();   // indisponíveis
  });
});
