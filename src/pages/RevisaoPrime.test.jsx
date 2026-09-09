// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import RevisaoPrime from "./RevisaoPrime";

// Dublê do construtor de consulta do supabase: guarda o que foi pedido, para o
// teste poder afirmar QUAL coluna a aba consultou.
const q = vi.hoisted(() => ({ pedidos: [], resposta: { data: [], error: null } }));

vi.mock("../services/supabase", () => {
  const construtor = (registro) => ({
    select() { return construtor(registro); },
    gt(coluna, valor) { registro.coluna = coluna; registro.valor = valor; return construtor(registro); },
    order(coluna) { registro.ordem = coluna; return construtor(registro); },
    limit(n) { registro.limite = n; return construtor(registro); },
    then(resolve) { return Promise.resolve(q.resposta).then(resolve); },
  });
  return {
    supabase: {
      from(tabela) {
        const registro = { tabela };
        q.pedidos.push(registro);
        return construtor(registro);
      },
    },
  };
});

const LINHA = {
  aluno_id: "a1", nome: "Fulano de Tal", cpf_mascarado: "***.456.789-**",
  operador: "cobranca03@aelbra.com.br", caso_codigo: 8495, unidade: "EAD",
  situacao_crm: "Em cobrança", saldo_crm: 2500,
  crm_abertos_liquidados_no_prime_n: 3, crm_abertos_liquidados_no_prime_valor: 1500.5,
  p195_abertos_fora_do_crm_n: 0, p195_abertos_fora_do_crm_valor: 0,
  p195_ultima_liquidacao: "2026-08-20",
  calculado_em: "2026-09-06T23:50:00Z", extrato_coletado_em: "2026-09-05",
};

beforeEach(() => { q.pedidos = []; q.resposta = { data: [], error: null }; });
afterEach(() => cleanup());

describe("Revisão Prime x CRM", () => {
  it("le a tabela certa e ja abre na visao de cobranca indevida", async () => {
    q.resposta = { data: [LINHA], error: null };
    render(<RevisaoPrime />);
    await screen.findByText("Fulano de Tal");

    expect(q.pedidos[0].tabela).toBe("revisao_prime_aluno");
    // A aba inicial tem que ser a que mostra o que estamos cobrando de quem pagou.
    expect(q.pedidos[0].coluna).toBe("crm_abertos_liquidados_no_prime_n");
    // So traz quem tem divergencia, nunca a base inteira.
    expect(q.pedidos[0].valor).toBe(0);
  });

  it("soma os totais do que veio, nao um numero solto", async () => {
    q.resposta = {
      data: [LINHA, { ...LINHA, aluno_id: "a2", nome: "Beltrana",
                      crm_abertos_liquidados_no_prime_n: 2,
                      crm_abertos_liquidados_no_prime_valor: 499.5 }],
      error: null,
    };
    render(<RevisaoPrime />);
    await screen.findByText("Beltrana");

    // "Titulos" e "Valor" existem no card E no cabecalho da tabela -- o
    // `selector: "div"` fica so com o card, que e onde mora o total.
    const valorDo = (rotulo) =>
      screen.getByText(rotulo, { selector: "div" }).parentElement.textContent;
    expect(valorDo("Alunos")).toContain("2");
    expect(valorDo("Títulos")).toContain("5");          // 3 + 2
    expect(valorDo("Valor")).toContain("2.000,00");     // 1500,50 + 499,50
  });

  it("trocar de aba consulta a OUTRA coluna", async () => {
    q.resposta = { data: [LINHA], error: null };
    render(<RevisaoPrime />);
    await screen.findByText("Fulano de Tal");

    fireEvent.click(screen.getByText("O Prime tem, o CRM não"));

    await waitFor(() => expect(q.pedidos.length).toBe(2));
    expect(q.pedidos[1].coluna).toBe("p195_abertos_fora_do_crm_n");
  });

  it("mostra a data do calculo e a do extrato, para ninguem ler numero velho como novo", async () => {
    q.resposta = { data: [LINHA], error: null };
    render(<RevisaoPrime />);
    await screen.findByText("Fulano de Tal");
    expect(screen.getByText(/Cálculo de 06\/09\/2026/)).toBeDefined();
    expect(screen.getByText(/Extrato do Prime de 05\/09\/2026/)).toBeDefined();
  });

  it("operador vazio aparece como 'sem operador', nao como branco", async () => {
    q.resposta = { data: [{ ...LINHA, operador: null }], error: null };
    render(<RevisaoPrime />);
    expect(await screen.findByText("sem operador")).toBeDefined();
  });

  it("erro do banco aparece na tela em vez de tabela vazia silenciosa", async () => {
    q.resposta = { data: null, error: { message: "permission denied" } };
    render(<RevisaoPrime />);
    expect(await screen.findByText(/permission denied/)).toBeDefined();
  });

  it("avisa que nao da baixa -- a regra que proibe baixar pelo Prime", async () => {
    q.resposta = { data: [LINHA], error: null };
    render(<RevisaoPrime />);
    await screen.findByText("Fulano de Tal");
    expect(screen.getByText(/Esta tela não dá baixa/)).toBeDefined();
  });
});
