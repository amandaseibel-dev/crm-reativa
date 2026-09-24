// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent, within } from "@testing-library/react";
import CarteiraGeral from "./CarteiraGeral";

// Números reais de produção em 24/09/2026 (leitura da carteira da Olga), para
// o teste falhar se a tela voltar a somar por ano ou a inventar carteira.
const PAINEL = {
  total_alunos: 545,
  total_valor: 2546943.15,
  total_mensalidade: 819405.33,
  total_acordo: 1727537.82,
  sem_operador: { alunos: 0, valor: 0 },
  na_carteira_geral: { alunos: 0, valor: 0 },
  responsavel_inativo: { alunos: 0, valor: 0 },
  por_responsavel: [
    { email: "cobranca03@aelbra.com.br", nome: "Olga", classe: "OPERADOR", alunos: 545, valor: 2546943.15, mensalidade: 819405.33, acordo: 1727537.82 },
    { email: "juridico@aelbra.com.br", nome: "Jurídico", classe: "NAO_OPERADOR", alunos: 58, valor: 0, mensalidade: 0, acordo: 0 },
  ],
  por_ano: [
    { ano: 2026, tipo: "ACORDO", alunos: 282, itens: 1051, valor: 1678901.67 },
    { ano: 2026, tipo: "MENSALIDADE", alunos: 254, itens: 699, valor: 681546.83 },
    { ano: 2025, tipo: "MENSALIDADE", alunos: 105, itens: 454, valor: 199401.35 },
  ],
};

const LISTA = [
  {
    aluno_id: "11111111-1111-1111-1111-111111111111",
    caso_id: "aaaaaaaa-1111-1111-1111-111111111111",
    nome: "MARIA DE TESTE",
    dono_email: "cobranca03@aelbra.com.br",
    dono_nome: "Olga",
    dono_classe: "OPERADOR",
    saldo_mensalidade: 1000,
    saldo_acordo: 2000,
    saldo_total: 3000,
    acordos_vivos: 2,
    acordos_de_outro_dono: 1,
  },
  {
    aluno_id: "22222222-2222-2222-2222-222222222222",
    caso_id: "bbbbbbbb-2222-2222-2222-222222222222",
    nome: "JOAO SEM DONO",
    dono_email: null,
    dono_nome: null,
    dono_classe: "SEM_OPERADOR",
    saldo_mensalidade: 500,
    saldo_acordo: 0,
    saldo_total: 500,
    acordos_vivos: 0,
    acordos_de_outro_dono: 0,
  },
];

const PREVIA = {
  previa_id: "99999999-9999-9999-9999-999999999999",
  destino_tipo: "CARTEIRA_GERAL",
  destino_nome: "CARTEIRA GERAL",
  mover_acordos: true,
  total_alunos: 1,
  total_acordos: 2,
  total_valor: 3000,
  itens: [],
  conflitos: [
    { tipo: "RETORNO_AGENDADO_SERA_LIMPO", nome: "MARIA DE TESTE", detalhe: "retorno em 2026-10-01" },
    { tipo: "ACORDO_DE_OUTRO_DONO", nome: "MARIA DE TESTE", detalhe: "Acordo 123 está com cobranca05@aelbra.com.br e vai junto." },
  ],
};

const chamadas = vi.hoisted(() => ({ rpc: [] }));

vi.mock("../services/supabase", () => ({
  supabase: {
    rpc: (fn, args) => {
      chamadas.rpc.push({ fn, args });
      if (fn === "carteira_geral_painel") return Promise.resolve({ data: PAINEL, error: null });
      if (fn === "carteira_geral_listar") return Promise.resolve({ data: LISTA, error: null });
      if (fn === "carteira_geral_previa") return Promise.resolve({ data: PREVIA, error: null });
      if (fn === "carteira_geral_mover")
        return Promise.resolve({
          data: { alunos_movidos: 1, acordos_movidos: 2, destino_nome: "CARTEIRA GERAL", lote_id: "lote-1", total_recusados: 0 },
          error: null,
        });
      return Promise.resolve({ data: null, error: null });
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            order: () => Promise.resolve({ data: [{ email: "cobranca05@aelbra.com.br", nome: "Luana", perfil: "operador", ativo: true, recebe_distribuicao_automatica: true }], error: null }),
          }),
        }),
      }),
    }),
  },
}));

async function montar() {
  render(<CarteiraGeral />);
  await waitFor(() => expect(screen.getByText("MARIA DE TESTE")).toBeTruthy());
}

describe("Carteira Geral — painel", () => {
  beforeEach(() => {
    chamadas.rpc = [];
  });
  afterEach(cleanup);

  it("mostra por ano somando o valor e sem somar alunos", async () => {
    await montar();
    // 681.546,83 + 1.678.901,67 = 2.360.448,50 no ano de 2026
    expect(screen.getByText("R$ 2.360.448,50")).toBeTruthy();
    // e diz por que a contagem de alunos não fecha com o total
    expect(screen.getByText(/aparece nos dois anos/)).toBeTruthy();
  });

  it("destaca responsável que não é operador ativo", async () => {
    await montar();
    // juridico@ segura 58 casos e não é da fila: a tela nomeia isso em vez de
    // mostrar como se fosse um operador qualquer.
    expect(screen.getByText("Responsável não é da fila")).toBeTruthy();

    // A linha do aluno órfão diz "Sem operador" e vem em cor de alerta.
    const linha = screen.getByText("JOAO SEM DONO").closest("tr");
    const celulaDono = within(linha).getByText("Sem operador");
    expect(celulaDono.style.color).toBe("var(--rv-ambar-texto)");
  });
});

describe("Carteira Geral — remanejamento", () => {
  beforeEach(() => {
    chamadas.rpc = [];
  });
  afterEach(cleanup);

  it("não deixa confirmar antes da prévia", async () => {
    await montar();
    const confirmar = screen.getByRole("button", { name: /Confirmar remanejamento/ });
    expect(confirmar.disabled).toBe(true);
  });

  it("exige motivo antes de gerar a prévia", async () => {
    await montar();
    fireEvent.click(screen.getByLabelText("Selecionar MARIA DE TESTE"));
    fireEvent.click(screen.getByRole("button", { name: /Ver prévia/ }));

    // A prévia usa "conferência" como motivo padrão; quem exige motivo escrito
    // é a confirmação, que é o que vai para a auditoria.
    await waitFor(() => expect(screen.getByText(/Prévia — nada foi movido ainda/)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Confirmar remanejamento/ }));
    await waitFor(() =>
      expect(screen.getByText("Informe o motivo — ele fica na auditoria.")).toBeTruthy()
    );
  });

  it("mostra os conflitos agrupados e o que não muda", async () => {
    await montar();
    fireEvent.click(screen.getByLabelText("Selecionar MARIA DE TESTE"));
    fireEvent.click(screen.getByRole("button", { name: /Ver prévia/ }));

    await waitFor(() => expect(screen.getByText("Retorno agendado que será limpo")).toBeTruthy());
    expect(screen.getByText("Acordo de outro responsável indo junto")).toBeTruthy();
    // a promessa que a gestão precisa ler antes de clicar
    expect(
      screen.getByText("O operador de cada pagamento — é ele que define honorário e comissão")
    ).toBeTruthy();
  });

  it("manda para a prévia exatamente os alunos marcados e o destino escolhido", async () => {
    await montar();
    fireEvent.click(screen.getByLabelText("Selecionar JOAO SEM DONO"));
    fireEvent.click(screen.getByRole("button", { name: /Ver prévia/ }));

    await waitFor(() => expect(chamadas.rpc.some((c) => c.fn === "carteira_geral_previa")).toBe(true));
    const args = chamadas.rpc.find((c) => c.fn === "carteira_geral_previa").args;
    expect(args.p_aluno_ids).toEqual(["22222222-2222-2222-2222-222222222222"]);
    expect(args.p_destino_tipo).toBe("CARTEIRA_GERAL");
    expect(args.p_mover_acordos).toBe(true);
  });

  it("confirma pelo id da prévia, e não refazendo a seleção", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await montar();

    fireEvent.click(screen.getByLabelText("Selecionar MARIA DE TESTE"));
    fireEvent.change(screen.getByPlaceholderText(/saída da Olga/), {
      target: { value: "saída da Olga" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Ver prévia/ }));
    await waitFor(() => expect(screen.getByText(/Prévia — nada foi movido ainda/)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /Confirmar remanejamento/ }));
    await waitFor(() => expect(chamadas.rpc.some((c) => c.fn === "carteira_geral_mover")).toBe(true));

    const args = chamadas.rpc.find((c) => c.fn === "carteira_geral_mover").args;
    expect(args.p_previa_id).toBe("99999999-9999-9999-9999-999999999999");
    expect(args.p_motivo).toBe("saída da Olga");
    expect(args).not.toHaveProperty("p_aluno_ids");
  });

  it("trocar o destino invalida a prévia já gerada", async () => {
    await montar();
    fireEvent.click(screen.getByLabelText("Selecionar MARIA DE TESTE"));
    fireEvent.click(screen.getByRole("button", { name: /Ver prévia/ }));
    await waitFor(() => expect(screen.getByText(/Prévia — nada foi movido ainda/)).toBeTruthy());

    fireEvent.change(screen.getByDisplayValue("Carteira Geral"), { target: { value: "FILA_LIVRE" } });

    await waitFor(() => expect(screen.queryByText(/Prévia — nada foi movido ainda/)).toBeNull());
    expect(screen.getByRole("button", { name: /Confirmar remanejamento/ }).disabled).toBe(true);
  });
});
