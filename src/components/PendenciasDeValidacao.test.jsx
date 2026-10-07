// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const rpcMock = vi.fn();
vi.mock("../services/supabase", () => ({ supabase: { rpc: (...a) => rpcMock(...a) } }));

const navegarMock = vi.fn();
vi.mock("react-router-dom", async (original) => ({
  ...(await original()),
  useNavigate: () => navegarMock,
}));

import PendenciasDeValidacao from "./PendenciasDeValidacao";

// O que se prova aqui: "Pendente de classificação" deixou de ser caixa-preta.
// O total é aberto pelos submotivos REAIS, cada um com alunos, títulos, valor e
// participação — e cada um leva ao registro individual na Fila Única.
//
// Os rótulos e a ação vêm da RPC (que lê o catálogo em SQL), nunca de um
// catálogo escrito no front: dois catálogos divergiriam na primeira correção.
// Por isso o dublê devolve rótulo e ação, e o teste confere que a tela usa o
// que veio.
const P_2026_1 = {
  recorte: "2026/1",
  gerado_em: "2026-10-07T19:30:00Z",
  fonte: "carteira_2026_1_classificar() ao vivo",
  contagens_somaveis: false,
  total: { alunos: 1159, titulos: 2414, valor: 1793976.23 },
  motivos: [
    { chave: "convertido_origem_comprovada",
      rotulo: "Conversão com origem comprovada, sem natureza definida",
      acao: "SEM_ACAO_AUTOMATICA_SEGURA", alunos: 601, titulos: 1300, valor: 946711.07 },
    { chave: "em_validacao", rotulo: "Em validação",
      acao: "SEM_ACAO_AUTOMATICA_SEGURA", alunos: 500, titulos: 1000, valor: 807802.95 },
    { chave: "ajuste_academico", rotulo: "Ajuste acadêmico",
      acao: "SEM_ACAO_AUTOMATICA_SEGURA", alunos: 58, titulos: 114, valor: 39462.21 },
  ],
  conferencia: { total_valor: 1793976.23, soma_das_linhas: 1793976.23, diferenca: 0, fecha: true },
};

const P_2024 = {
  recorte: "2024",
  gerado_em: "2026-10-07T19:30:00Z",
  fonte: "acordos_titulos + serie da Prime, ao vivo",
  contagens_somaveis: true,
  total: { alunos: 19, titulos: 52, valor: 39686.19 },
  motivos: [
    { chave: "pago_sem_lastro", rotulo: "Pago sem lastro",
      acao: "SEM_ACAO_AUTOMATICA_SEGURA", alunos: 12, titulos: 41, valor: 25285.00 },
    { chave: "em_confirmacao", rotulo: "Em confirmação de pagamento",
      acao: "CONFERENCIA_PRIME", alunos: 7, titulos: 11, valor: 14401.19 },
  ],
  conferencia: { total_valor: 39686.19, soma_das_linhas: 39686.19, diferenca: 0, fecha: true },
};

const txt = (el) => el.textContent.replace(/\u00a0/g, " ");
const responder = (payload, error = null) =>
  rpcMock.mockImplementation(() => Promise.resolve({ data: payload, error }));

const montar = (props = { ano: "2024", semestre: null }) =>
  act(async () => {
    render(<MemoryRouter><PendenciasDeValidacao {...props} /></MemoryRouter>);
  });

beforeEach(() => { rpcMock.mockReset(); navegarMock.mockReset(); responder(P_2024); });
afterEach(() => cleanup());

describe("Pendências de validação", () => {
  it("pede a RPC de motivos com o recorte", async () => {
    await montar({ ano: "2026", semestre: "1" });
    expect(rpcMock).toHaveBeenCalledWith("carteira_pendencias_por_motivo",
      { p_ano: "2026", p_semestre: "1" });
  });

  it("abre o total por motivo real, com alunos, títulos, valor e percentual", async () => {
    await montar();
    const linha = screen.getByText("Pago sem lastro").closest("tr");
    expect(txt(linha)).toContain("12");
    expect(txt(linha)).toContain("41");
    expect(txt(linha)).toContain("R$ 25.285,00");
    expect(txt(linha)).toContain("63,71%");
  });

  it("usa o rótulo que veio da RPC, sem catálogo próprio no front", async () => {
    responder(P_2026_1);
    await montar({ ano: "2026", semestre: "1" });
    expect(screen.getByText("Conversão com origem comprovada, sem natureza definida")).toBeTruthy();
    expect(screen.getByText("Ajuste acadêmico")).toBeTruthy();
  });

  it("os motivos somam o total pendente, e a tela mostra o fechamento", async () => {
    await montar();
    const rodape = screen.getByText("Total pendente").closest("tr");
    expect(txt(rodape)).toContain("R$ 39.686,19");
    expect(txt(rodape)).toContain("100,00%");
  });

  it("quando a soma NÃO fecha, avisa e não ajusta nada", async () => {
    responder({ ...P_2024, conferencia: { ...P_2024.conferencia, diferenca: 3.5, fecha: false } });
    await montar();
    expect(screen.getByText(/difere do total pendente em R\$ 3,50/)).toBeTruthy();
  });

  it("marca o motivo sem regra de resolução, e não lhe dá ação de resolver", async () => {
    await montar();
    const linha = screen.getByText("Pago sem lastro").closest("tr");
    expect(txt(linha)).toContain("sem ação automática segura");
    expect(txt(linha)).toContain("Ver na Fila Única");
    const comAcao = screen.getByText("Em confirmação de pagamento").closest("tr");
    expect(txt(comAcao)).toContain("Tratar na Fila Única");
    expect(txt(comAcao)).not.toContain("sem ação automática segura");
  });

  it("cada motivo leva à Fila Única já filtrada por motivo e safra", async () => {
    await montar();
    await act(async () => {
      fireEvent.click(screen.getByText("Em confirmação de pagamento").closest("tr")
        .querySelector("button"));
    });
    expect(navegarMock).toHaveBeenCalledWith(
      "/fila-unica-confirmacao?motivo=em_confirmacao&ano=2024");
  });

  it("em 2026/1 não promete soma de contagens entre motivos", async () => {
    responder(P_2026_1);
    await montar({ ano: "2026", semestre: "1" });
    const rodape = screen.getByText("Total pendente").closest("tr");
    // valor soma; aluno e título, não — e o total deles aparece como travessão
    expect(txt(rodape)).toContain("R$ 1.793.976,23");
    expect(txt(rodape)).toContain("—");
    expect(screen.getByText(/não devem ser somadas entre motivos/)).toBeTruthy();
  });

  it("em 2024 as contagens somam, e o total delas aparece", async () => {
    await montar();
    const rodape = screen.getByText("Total pendente").closest("tr");
    expect(txt(rodape)).toContain("19");
    expect(txt(rodape)).toContain("52");
    expect(screen.getByText(/cada título cai em um motivo só/)).toBeTruthy();
  });

  it("diz que esta tela é análise, não tratamento", async () => {
    await montar();
    expect(screen.getByText(/análise, não tratamento/)).toBeTruthy();
  });

  it("erro da RPC aparece e diz que o resto segue válido", async () => {
    responder(null, { message: "Acesso negado." });
    await montar();
    expect(screen.getByText(/Não foi possível abrir as pendências por motivo: Acesso negado/)).toBeTruthy();
  });
});
