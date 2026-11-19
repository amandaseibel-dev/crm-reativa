// @vitest-environment jsdom
// Botão "Histórico" na visão Mensageria: só com a porta ligada, só onde o SERVIDOR
// informa capacidade_historico=true; abrir o painel não chama nada; 1 clique = 1 chamada.
// Sem o campo, a tela fecha (fail-closed): é o estado atual, porque a RPC da lista
// ainda não produz capacidade_historico (ver pacote de implantação).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import MensageriaPeriodo from "./MensageriaPeriodo";

const rpc = vi.fn();
vi.mock("../services/supabase", () => ({ supabase: { rpc: (...a) => rpc(...a) } }));

const PERIODO_BASE = {
  ok: true, eh_gestao: false, operador: "cobranca10@aelbra.com.br", desde: "2026-11-01T03:00:00+00:00",
  limite: 100, pagina: 0, totais: { conversas: 3, aguardando: 0, sem_cpf: null },
  conversas: [
    { conversa_id: "c-minha", aluno_id: "al-1", nome: "Helena Dantas", previa: "ok", mensagem_em: "2026-11-10T13:00:00Z", quem: "operador", direcao: "enviada", aguardando: false, responsabilidade: "CARTEIRA", responsavel_reativa: "cobranca10@aelbra.com.br", minha: true, lida: true },
    { conversa_id: "c-outro", aluno_id: "al-2", nome: "Bruno Leal", previa: "ok", mensagem_em: "2026-11-09T13:00:00Z", quem: "operador", direcao: "enviada", aguardando: false, responsabilidade: "CARTEIRA", responsavel_reativa: null, responsavel_e_outro: true, minha: false, lida: true },
    { conversa_id: "c-sem-cpf", aluno_id: null, nome: "Carla Souza", previa: "ok", mensagem_em: "2026-11-08T13:00:00Z", quem: "operador", direcao: "enviada", aguardando: false, responsabilidade: "SEM_CARTEIRA", responsavel_reativa: null, minha: false, lida: false },
  ],
};
const RESPOSTAS_BASE = [
  { conversa_id: "r-minha", aluno_id: "al-5", nome: "Sofia Prado", previa: "posso pagar?", mensagem_em: "2026-11-10T08:00:00Z", espera_min: 30, responsabilidade: "CARTEIRA", responsavel_reativa: "cobranca10@aelbra.com.br", minha: true },
  { conversa_id: "r-sem-cpf", aluno_id: null, nome: "Marina Ferraz", previa: "oi", mensagem_em: "2026-11-10T09:00:00Z", espera_min: 10, responsabilidade: "SEM_CARTEIRA", minha: false },
];
// Capacidade como o servidor deveria enviar, por linha (true só onde a função aceita).
const CAP_OPERADOR = { "c-minha": true, "r-minha": true };
const CAP_GESTAO = { "c-minha": true, "c-outro": true, "r-minha": true };
const com = (lista, mapa) => lista.map((l) => ({ ...l, capacidade_historico: mapa[l.conversa_id] === true }));
const PERIODO_OPERADOR = { ...PERIODO_BASE, conversas: com(PERIODO_BASE.conversas, CAP_OPERADOR) };
const RESPOSTAS_OPERADOR = com(RESPOSTAS_BASE, CAP_OPERADOR);

const PAGINA = { ok: true, origem: "ulbra", chamadas: 1, pagina: { mensagens: [{ direcao: "ENTRADA", em: "2026-11-10T13:00:00Z", texto: "pode me ligar?", autor: null, anexos: [] }], antes_de: null } };

function montar(props = {}) {
  return render(
    <MemoryRouter>
      <MensageriaPeriodo respostas={RESPOSTAS_OPERADOR} coleta={null} aoAbrirFicha={() => {}} {...props} />
    </MemoryRouter>,
  );
}
const botoes = () => screen.queryAllByRole("button", { name: /^Histórico$/ });
const linha = (id) => document.querySelector(`[data-conversa='${id}']`);

describe("visão Mensageria — botão Histórico", () => {
  beforeEach(() => { rpc.mockReset(); rpc.mockResolvedValue({ data: PERIODO_OPERADOR, error: null }); });
  afterEach(() => cleanup());

  it("porta desligada na tela: nenhum botão, nenhuma chamada, e o aviso diz que o histórico não está disponível", async () => {
    const leitor = vi.fn();
    montar({ leitorHistorico: leitor, historicoDisponivel: false });
    await waitFor(() => expect(screen.getByTestId("mensageria-conversas").querySelectorAll("li").length).toBe(3));
    expect(botoes()).toHaveLength(0);
    expect(screen.getByTestId("mensageria-limites").textContent).toMatch(/Histórico completo e resposta pelo CRM ainda não estão disponíveis/);
    expect(leitor).not.toHaveBeenCalled();
  });

  it("porta ligada, sem capacidade informada pelo servidor: nenhum botão (fechado por padrão)", async () => {
    const leitor = vi.fn();
    rpc.mockResolvedValue({ data: PERIODO_BASE, error: null });
    montar({ historicoDisponivel: true, leitorHistorico: leitor, respostas: RESPOSTAS_BASE });
    await waitFor(() => expect(screen.getByTestId("mensageria-conversas").querySelectorAll("li").length).toBe(3));
    expect(botoes()).toHaveLength(0);
    // Trava de janela: sem capacidade do servidor, a copy NÃO promete histórico clicável.
    expect(screen.getByTestId("mensageria-limites").textContent).not.toMatch(/Histórico só por clique/);
    expect(screen.getByTestId("mensageria-limites").textContent).toMatch(/Histórico completo e resposta pelo CRM ainda não estão disponíveis/);
    expect(leitor).not.toHaveBeenCalled();
  });

  it("porta ligada, operador: botão só onde o servidor informa capacidade; abrir o painel NÃO chama a Mensageria", async () => {
    const leitor = vi.fn().mockResolvedValue(PAGINA);
    montar({ historicoDisponivel: true, leitorHistorico: leitor });
    await waitFor(() => expect(screen.getByTestId("mensageria-conversas").querySelectorAll("li").length).toBe(3));
    expect(linha("c-minha").querySelector("[data-campo='historico']")).toBeTruthy();
    expect(linha("r-minha").querySelector("[data-campo='historico']")).toBeTruthy();
    expect(linha("c-outro").querySelector("[data-campo='historico']")).toBeNull();
    expect(linha("c-sem-cpf").querySelector("[data-campo='historico']")).toBeNull();
    expect(linha("r-sem-cpf").querySelector("[data-campo='historico']")).toBeNull();
    expect(screen.getByTestId("mensageria-limites").textContent).toMatch(/Histórico só por clique/);
    expect(screen.getByTestId("mensageria-limites").textContent).toMatch(/Resposta pelo CRM ainda não está disponível/);

    fireEvent.click(linha("c-minha").querySelector("[data-campo='historico']"));
    expect(linha("c-minha").querySelector("[data-campo='historico-painel']")).toBeTruthy();
    expect(leitor).not.toHaveBeenCalled();

    // só o clique dentro do painel lê: exatamente 1 chamada, com a conversa certa
    fireEvent.click(linha("c-minha").querySelector("[data-campo='historico-painel'] button"));
    await waitFor(() => expect(screen.getByText("pode me ligar?")).toBeTruthy());
    expect(leitor).toHaveBeenCalledTimes(1);
    expect(leitor).toHaveBeenCalledWith("c-minha", null);

    // fechar não chama nada
    fireEvent.click(linha("c-minha").querySelector("[data-campo='historico']"));
    expect(linha("c-minha").querySelector("[data-campo='historico-painel']")).toBeNull();
    expect(leitor).toHaveBeenCalledTimes(1);
  });

  it("porta ligada, gestão: botão nas linhas que o servidor marca, nunca na linha sem CPF", async () => {
    const leitor = vi.fn();
    rpc.mockResolvedValue({ data: { ...PERIODO_BASE, eh_gestao: true, operador: null, conversas: com(PERIODO_BASE.conversas, CAP_GESTAO), totais: { conversas: 3, aguardando: 0, sem_cpf: 7 } }, error: null });
    montar({ ehGestao: true, historicoDisponivel: true, leitorHistorico: leitor, respostas: com(RESPOSTAS_BASE, CAP_GESTAO) });
    await waitFor(() => expect(screen.getByTestId("mensageria-conversas").querySelectorAll("li").length).toBe(3));
    expect(linha("c-minha").querySelector("[data-campo='historico']")).toBeTruthy();
    expect(linha("c-outro").querySelector("[data-campo='historico']")).toBeTruthy();
    expect(linha("c-sem-cpf").querySelector("[data-campo='historico']")).toBeNull();
    expect(linha("r-sem-cpf").querySelector("[data-campo='historico']")).toBeNull();
    expect(leitor).not.toHaveBeenCalled();
  });

  it("recusa da função chega como texto, sem repetir a chamada", async () => {
    const leitor = vi.fn().mockResolvedValue({ ok: false, motivo: "SALDO_DESATUALIZADO", http: 409 });
    montar({ historicoDisponivel: true, leitorHistorico: leitor });
    await waitFor(() => expect(linha("c-minha")).toBeTruthy());
    fireEvent.click(linha("c-minha").querySelector("[data-campo='historico']"));
    fireEvent.click(linha("c-minha").querySelector("[data-campo='historico-painel'] button"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/A medida da cota venceu/);
    expect(leitor).toHaveBeenCalledTimes(1);
  });
});
