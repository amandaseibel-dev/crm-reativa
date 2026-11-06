// @vitest-environment jsdom
//
// A TELA MOSTRA OS DOIS INDICADORES SEM MISTURAR -- prova na renderizacao.
//
// O teste de guarda irmao (CentralFinanceiraIndicadores.test.js) le o codigo;
// este monta o componente de verdade, com o supabase dublado, e confere o que
// a gestao vai ver: os dois painels separados, o contador por classe, o filtro,
// e -- o ponto da frente -- `BAIXADO` e "sem baixa oficial" na MESMA linha, sem
// um anular o outro.
//
// Nenhuma rede real: o duble devolve linhas fixas.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

const INDICADORES = [
  { pagamento_id: "p1", valor_pago: 1000, crm_status_conciliacao: "BAIXADO", baixa_oficial_existe: false, baixa_devolvida_qtd: 0 },
  { pagamento_id: "p2", valor_pago: 250, crm_status_conciliacao: "PARCELA_JA_PAGA", baixa_oficial_existe: true, baixa_devolvida_qtd: 0 },
  { pagamento_id: "p3", valor_pago: 70, crm_status_conciliacao: null, baixa_oficial_existe: false, baixa_devolvida_qtd: 1 },
];

const EXCECOES = [
  {
    pagamento_id: "p1", classe: "BAIXADO_SEM_BAIXA_OFICIAL", risco: 1, risco_rotulo: "CRITICO",
    classe_rotulo: "Conciliado BAIXADO no CRM e sem baixa oficial viva",
    classe_motivo: "Parcela esta PAGO por GATILHO_IMPORTACAO, sem linha em baixas_pagamento: falta a trilha de quem assinou",
    aluno_nome: "Maria Teste", cpf: "00011122233", data_pagamento: "2026-10-01", valor_pago: 1000,
    titulo_numero: "500001", numero_parcela_completo: "500001/1",
    crm_status_conciliacao: "BAIXADO", crm_conciliacao_motivo: "boleto exato", crm_conciliacao_em: "2026-10-01T12:00:00Z",
    crm_dias_parado: 19, crm_origem_vinculo: "BOLETO_EXATO",
    baixa_oficial_existe: false, baixa_oficial_status_baixa: null, baixa_oficial_em: null,
    baixa_oficial_por_email: null, baixa_oficial_valor_pago: null,
    baixa_devolvida_qtd: 0, baixa_devolvida_ultima_em: null, baixa_devolvida_motivo: null,
    baixa_candidata_fraca_qtd: 0,
    parcela_status: "PAGO", parcela_origem_baixa: "GATILHO_IMPORTACAO",
    vinculo_parcela_confianca: "ALTA_REF_E_BOLETO",
  },
  {
    pagamento_id: "p2", classe: "PARCELA_JA_PAGA", risco: 3, risco_rotulo: "ALTO",
    classe_rotulo: "Conciliacao recusou: parcela ja estava paga",
    classe_motivo: "parcela ja constava paga",
    aluno_nome: "Joao Teste", cpf: "00044455566", data_pagamento: "2026-10-02", valor_pago: 250,
    titulo_numero: "500002", numero_parcela_completo: "500002/3",
    crm_status_conciliacao: "PARCELA_JA_PAGA", crm_conciliacao_motivo: "ja paga", crm_conciliacao_em: "2026-10-02T12:00:00Z",
    crm_dias_parado: 18, crm_origem_vinculo: "BOLETO_EXATO",
    baixa_oficial_existe: true, baixa_oficial_status_baixa: "REALIZADA", baixa_oficial_em: "2026-10-03T14:30:00Z",
    baixa_oficial_por_email: "amanda.seibel@aelbra.com.br", baixa_oficial_valor_pago: 250,
    baixa_devolvida_qtd: 0, baixa_devolvida_ultima_em: null, baixa_devolvida_motivo: null,
    baixa_candidata_fraca_qtd: 0,
    parcela_status: "PAGO", parcela_origem_baixa: null,
    vinculo_parcela_confianca: "ALTA_BOLETO_EXATO",
  },
];

// Duble do cliente: a cadeia .from().select().gte().lte().order().range() tem
// de ser encadeavel e, no fim, aguardavel.
const estado = { email: "amanda.seibel@aelbra.com.br" };

vi.mock("../services/supabase", () => {
  const consulta = (linhas) => {
    const alvo = {
      select: () => alvo, gte: () => alvo, lte: () => alvo, order: () => alvo,
      range: () => alvo,
      then: (ok) => Promise.resolve({ data: linhas, error: null }).then(ok),
    };
    return alvo;
  };
  return {
    supabase: {
      auth: { getUser: () => Promise.resolve({ data: { user: { email: estado.email } } }) },
      from: (nome) => consulta(nome.includes("excecoes") ? EXCECOES : INDICADORES),
    },
  };
});

const { default: CentralFinanceiraIndicadores } = await import("./CentralFinanceiraIndicadores");

const ABRIR = /Conferência: conciliação no CRM × baixa oficial/;

// `toLocaleString("pt-BR", {style:"currency"})` separa "R$" do numero com
// ESPACO NAO SEPARAVEL (U+00A0). Comparar com espaco comum falharia por causa
// disso, e nao por causa do numero.
const texto = (el) => el.textContent.replace(/\u00a0/g, " ");

afterEach(cleanup);
beforeEach(() => { estado.email = "amanda.seibel@aelbra.com.br"; });

// Abre e ESPERA a leitura terminar. O painel adia a consulta em 200 ms de
// proposito (os campos de data disparam a cada tecla), entao esperar so o
// titulo aparecer deixaria o teste olhando a tela ainda vazia.
async function abrir() {
  render(<CentralFinanceiraIndicadores />);
  const botao = await screen.findByRole("button", { name: ABRIR });
  fireEvent.click(botao);
  await waitFor(() => expect(screen.getByText("Conciliação no CRM")).toBeTruthy());
  await waitFor(() => expect(screen.getByRole("button", { name: /Todas · 2/ })).toBeTruthy());
}

describe("o painel dos dois indicadores na tela", () => {
  it("nao aparece para quem nao e da gestao financeira", async () => {
    estado.email = "operador@aelbra.com.br";
    render(<CentralFinanceiraIndicadores />);
    await waitFor(() => expect(screen.queryByRole("button", { name: ABRIR })).toBeNull());
  });

  it("nasce fechado e so le producao quando a gestao abre", async () => {
    render(<CentralFinanceiraIndicadores />);
    const botao = await screen.findByRole("button", { name: ABRIR });
    expect(screen.queryByText("Conciliação no CRM")).toBeNull();
    fireEvent.click(botao);
    await waitFor(() => expect(screen.getByText("Conciliação no CRM")).toBeTruthy());
  });

  it("mostra os DOIS indicadores em paineis separados, cada um contando a SUA fonte", async () => {
    await abrir();
    const painelCrm = screen.getByText("Conciliação no CRM").closest("div").parentElement;
    const painelBaixa = screen.getByText("Baixa oficial no título/parcela").closest("div").parentElement;

    // Indicador 1 conta por status_conciliacao: 1 BAIXADO, 1 PARCELA_JA_PAGA,
    // 1 sem conciliacao nenhuma -- os tres pagamentos do duble.
    expect(texto(painelCrm)).toContain("public.pagamentos");
    expect(texto(painelCrm)).toContain("Indicador 1");
    expect(texto(painelCrm)).toContain("BAIXADO");
    expect(texto(painelCrm)).toContain("PARCELA_JA_PAGA");
    expect(texto(painelCrm)).toContain("(sem conciliacao)");
    expect(texto(painelCrm)).not.toContain("baixa oficial viva");

    // Indicador 2 conta por baixas_pagamento, por conta propria: 1 com baixa
    // viva (R$ 250,00), 2 sem, 1 com devolvida no historico.
    expect(texto(painelBaixa)).toContain("public.baixas_pagamento");
    expect(texto(painelBaixa)).toContain("Indicador 2");
    expect(texto(painelBaixa)).toContain("com baixa oficial viva1R$ 250,00");
    expect(texto(painelBaixa)).toContain("sem baixa oficial2R$ 1.070,00");
    expect(texto(painelBaixa)).toContain("com baixa devolvida no histórico1R$ 70,00");
    expect(texto(painelBaixa)).not.toContain("PARCELA_JA_PAGA");
  });

  it("BAIXADO no CRM e 'sem baixa oficial' aparecem na MESMA linha, sem se anular", async () => {
    await abrir();
    const linha = screen.getByText("Maria Teste").closest("tr");
    expect(texto(linha)).toContain("BAIXADO");
    expect(texto(linha)).toContain("sem baixa oficial");
    // E a parcela entra como contexto, nao como a baixa oficial.
    expect(texto(linha)).toContain("baixada por GATILHO_IMPORTACAO");
  });

  it("conta por classe e filtra ao clicar no contador", async () => {
    await abrir();
    expect(screen.getByRole("button", { name: /Todas · 2/ })).toBeTruthy();
    const critico = screen.getByRole("button", { name: /BAIXADO no CRM, sem baixa oficial/ });
    expect(critico.textContent).toContain("CRITICO");
    expect(screen.getByText("Joao Teste")).toBeTruthy();

    fireEvent.click(critico);
    await waitFor(() => expect(screen.queryByText("Joao Teste")).toBeNull());
    expect(screen.getByText("Maria Teste")).toBeTruthy();
    expect(critico.getAttribute("aria-pressed")).toBe("true");
  });

  it("nao oferece nenhum botao que escreva", async () => {
    await abrir();
    const rotulos = screen.getAllByRole("button").map((b) => b.textContent);
    const proibido = /baixar|baixa manual|confirmar|quitar|aprovar|devolver|salvar|registrar|enviar|excluir/i;
    expect(rotulos.filter((r) => proibido.test(r))).toEqual([]);
    expect(document.querySelector("form")).toBeNull();
  });
});
