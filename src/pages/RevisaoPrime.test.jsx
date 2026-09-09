// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import RevisaoPrime from "./RevisaoPrime";

// A tela abre a ficha do aluno navegando; sem Router o useNavigate quebra.
// O destino em si e testado no caso "abre a ficha pelo aluno_id".
const navegou = vi.hoisted(() => ({ para: null }));
vi.mock("react-router-dom", async (original) => ({
  ...(await original()),
  useNavigate: () => (destino) => { navegou.para = destino; },
}));

const abrir = (props = {}) =>
  render(<MemoryRouter><RevisaoPrime {...props} /></MemoryRouter>);

// Dublê do construtor de consulta do supabase: guarda o que foi pedido, para o
// teste poder afirmar QUAL coluna a aba consultou.
const q = vi.hoisted(() => ({ pedidos: [], rpcs: [], tratativas: [], resposta: { data: [], error: null } }));

vi.mock("../services/supabase", () => {
  const construtor = (registro) => ({
    select() { return construtor(registro); },
    eq(coluna, valor) { registro.eq = [coluna, valor]; return construtor(registro); },
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
        // A tabela de tratativas responde vazia por padrao: o teste que
        // precisar de tratativa injeta em q.tratativas.
        if (tabela === "revisao_prime_tratativa") {
          return { select: () => ({ eq: () => Promise.resolve({ data: q.tratativas || [], error: null }) }) };
        }
        return construtor(registro);
      },
      rpc(nome, args) { q.rpcs.push({ nome, args }); return Promise.resolve({ data: null, error: null }); },
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

beforeEach(() => { q.pedidos = []; q.rpcs = []; q.tratativas = []; navegou.para = null;
                   q.resposta = { data: [], error: null }; });
afterEach(() => cleanup());

describe("Revisão Prime x CRM", () => {
  it("le a tabela certa e ja abre na visao de cobranca indevida", async () => {
    q.resposta = { data: [LINHA], error: null };
    abrir();
    await screen.findByRole("button", { name: "Fulano de Tal" });

    const pedido = q.pedidos.find((p) => p.tabela === "revisao_prime_aluno");
    expect(pedido).toBeDefined();
    // A aba inicial tem que ser a que mostra o que estamos cobrando de quem pagou.
    expect(pedido.coluna).toBe("crm_abertos_liquidados_no_prime_n");
    // So traz quem tem divergencia, nunca a base inteira.
    expect(pedido.valor).toBe(0);
  });

  it("soma os totais do que veio, nao um numero solto", async () => {
    q.resposta = {
      data: [LINHA, { ...LINHA, aluno_id: "a2", nome: "Beltrana",
                      crm_abertos_liquidados_no_prime_n: 2,
                      crm_abertos_liquidados_no_prime_valor: 499.5 }],
      error: null,
    };
    abrir();
    await screen.findByRole("button", { name: "Beltrana" });

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
    abrir();
    await screen.findByRole("button", { name: "Fulano de Tal" });

    fireEvent.click(screen.getByText("O Prime tem, o CRM não"));

    await waitFor(() => {
      const revisoes = q.pedidos.filter((p) => p.tabela === "revisao_prime_aluno");
      expect(revisoes.length).toBe(2);
      expect(revisoes[1].coluna).toBe("p195_abertos_fora_do_crm_n");
    });
  });

  it("mostra a data do calculo e a do extrato, para ninguem ler numero velho como novo", async () => {
    q.resposta = { data: [LINHA], error: null };
    abrir();
    await screen.findByRole("button", { name: "Fulano de Tal" });
    expect(screen.getByText(/Cálculo de 06\/09\/2026/)).toBeDefined();
    expect(screen.getByText(/Extrato do Prime de 05\/09\/2026/)).toBeDefined();
  });

  it("operador vazio aparece como 'sem operador', nao como branco", async () => {
    q.resposta = { data: [{ ...LINHA, operador: null }], error: null };
    abrir();
    expect(await screen.findByText("sem operador")).toBeDefined();
  });

  it("erro do banco aparece na tela em vez de tabela vazia silenciosa", async () => {
    q.resposta = { data: null, error: { message: "permission denied" } };
    abrir();
    expect(await screen.findByText(/permission denied/)).toBeDefined();
  });

  it("avisa que nao da baixa -- a regra que proibe baixar pelo Prime", async () => {
    q.resposta = { data: [LINHA], error: null };
    abrir();
    await screen.findByRole("button", { name: "Fulano de Tal" });
    expect(screen.getByText(/Esta tela não dá baixa/)).toBeDefined();
  });

  describe("tratativa — Feito e Rejeitar", () => {
    it("abre a ficha do aluno pelo aluno_id, nao por busca de nome", async () => {
      q.resposta = { data: [LINHA], error: null };
      abrir();
      fireEvent.click(await screen.findByRole("button", { name: "Fulano de Tal" }));
      expect(localStorage.getItem("reativa_aluno_abrir_id")).toBe("a1");
      expect(navegou.para).toContain("/aluno");
    });

    it("Feito grava FEITO para a visao aberta", async () => {
      q.resposta = { data: [LINHA], error: null };
      abrir();
      fireEvent.click(await screen.findByRole("button", { name: "Feito" }));
      await waitFor(() => expect(q.rpcs.length).toBe(1));
      expect(q.rpcs[0].nome).toBe("revisao_prime_tratar");
      expect(q.rpcs[0].args.p_status).toBe("FEITO");
      expect(q.rpcs[0].args.p_visao).toBe("cobrando_pago");
      expect(q.rpcs[0].args.p_aluno_id).toBe("a1");
    });

    it("Rejeitar grava REJEITADO -- o caso esta certo no Prime", async () => {
      q.resposta = { data: [LINHA], error: null };
      vi.spyOn(window, "prompt").mockReturnValue("conferido, esta certo");
      abrir();
      fireEvent.click(await screen.findByRole("button", { name: "Rejeitar" }));
      await waitFor(() => expect(q.rpcs.length).toBe(1));
      expect(q.rpcs[0].args.p_status).toBe("REJEITADO");
      expect(q.rpcs[0].args.p_motivo).toBe("conferido, esta certo");
      window.prompt.mockRestore();
    });

    it("o que ja foi tratado sai da lista, e volta com o filtro", async () => {
      q.resposta = { data: [LINHA], error: null };
      q.tratativas = [{ aluno_id: "a1", status: "FEITO" }];
      abrir();
      // Some da fila...
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: "Fulano de Tal" })).toBeNull());
      // ...e reaparece marcado quando pedimos para ver.
      fireEvent.click(screen.getByRole("checkbox"));
      expect(await screen.findByRole("button", { name: "Fulano de Tal" })).toBeDefined();
      expect(screen.getByText("Feito")).toBeDefined();
    });
  });
});
