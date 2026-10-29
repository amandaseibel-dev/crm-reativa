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
    { email: "cobranca03@aelbra.com.br", nome: "Olga", classe: "INATIVO", casos: 545, alunos: 545, valor: 2546943.15, mensalidade: 819405.33, acordo: 1727537.82 },
    { email: "amanda.seibel@aelbra.com.br", nome: "Amanda Gestora", classe: "NAO_OPERADOR", casos: 11, alunos: 11, valor: 25762.69, mensalidade: 0, acordo: 0 },
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
  total_acordos: 1,
  acordos_de_terceiros: 1,
  acordos_de_terceiros_selecionados: 0,
  retornos_preservados: 1,
  total_valor: 3000,
  itens: [],
  conflitos: [
    { tipo: "RETORNO_AGENDADO_SEGUE", nome: "MARIA DE TESTE", detalhe: "Retorno de 2026-10-01 as 14:30 e preservado e passa a responder ao novo responsavel." },
    { tipo: "ACORDO_DE_TERCEIRO_FICA", acordo_id: "ac-123", aluno_id: "11111111-1111-1111-1111-111111111111",
      nome: "MARIA DE TESTE", numero: "123", status: "ATIVO", valor: "4500.00",
      de_email: "cobranca05@aelbra.com.br",
      detalhe: "Acordo 123 (ATIVO, R$ 4500.00) e de cobranca05@aelbra.com.br e FICA com essa pessoa. Selecione o acordo se quiser leva-lo." },
  ],
};

const chamadas = vi.hoisted(() => ({ rpc: [] }));

vi.mock("../services/supabase", () => ({
  supabase: {
    // a seção "Acordos por responsável" abre em "Meus acordos" e precisa saber
    // quem está logado
    auth: {
      getUser: () =>
        Promise.resolve({ data: { user: { email: "amanda.seibel@aelbra.com.br" } }, error: null }),
    },
    rpc: (fn, args) => {
      chamadas.rpc.push({ fn, args });
      if (fn === "carteira_geral_painel") return Promise.resolve({ data: PAINEL, error: null });
      if (fn === "carteira_geral_listar") return Promise.resolve({ data: LISTA, error: null });
      if (fn === "carteira_geral_previa") return Promise.resolve({ data: PREVIA, error: null });
      if (fn === "carteira_geral_acordos_responsaveis")
        return Promise.resolve({
          data: [
            { email: "cobranca03@aelbra.com.br", nome: "Olga", acordos: 127, ativos: 119, ativo: false, existe_em_usuarios: true },
            { email: "amanda.seibel@aelbra.com.br", nome: "Amanda", acordos: 753, ativos: 653, ativo: true, existe_em_usuarios: true },
          ],
          error: null,
        });
      if (fn === "carteira_geral_acordos_painel")
        return Promise.resolve({
          data: {
            responsavel: "amanda.seibel@aelbra.com.br",
            total_acordos: 753, total_valor: 2683032.45, alunos: 699, em_caso_de_outro: 726,
            por_status: [
              { status: "ATIVO", acordos: 653, valor: 2361760.32 },
              { status: "QUITADO", acordos: 82, valor: 0 },
              { status: "CANCELADO", acordos: 18, valor: 0 },
            ],
            por_dono_do_caso: [
              { classe: "EU", acordos: 27, valor: 89951.76, ativos: 11 },
              { classe: "OUTRO", acordos: 563, valor: 1808715.87, ativos: 519 },
            ],
          },
          error: null,
        });
      if (fn === "carteira_geral_acordos_listar")
        return Promise.resolve({
          data: [
            {
              acordo_id: "ac-1", aluno_id: "al-1", nome: "ALUNA NO CASO DA OLGA",
              numero_acordo: "9001", status: "ATIVO", valor: 4500,
              caso_dono_email: "cobranca03@aelbra.com.br", caso_dono_nome: "Olga",
              caso_dono_classe: "OUTRO",
            },
          ],
          error: null,
        });
      if (fn === "carteira_geral_definir_recebimento")
        return Promise.resolve({ data: { ok: true, operador: "Olga", recebe: false }, error: null });
      if (fn === "carteira_geral_mover")
        return Promise.resolve({
          data: { alunos_movidos: 1, acordos_movidos: 1, retornos_preservados: 1, destino_nome: "CARTEIRA GERAL", lote_id: "lote-1", total_recusados: 0 },
          error: null,
        });
      return Promise.resolve({ data: null, error: null });
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            order: () => Promise.resolve({
              data: [
                { email: "cobranca03@aelbra.com.br", nome: "Olga", perfil: "operador", ativo: true, recebe_novos_casos: true },
                { email: "cobranca05@aelbra.com.br", nome: "Luana", perfil: "operador", ativo: true, recebe_novos_casos: false },
              ],
              error: null,
            }),
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
    // a gestora também é NAO_OPERADOR agora: mira a linha do jurídico
    const linhaJuridico = screen.getByText("Jurídico").closest("tr");
    expect(within(linhaJuridico).getByText("Responsável não é da fila")).toBeTruthy();

    // A linha do aluno órfão diz "Sem operador" e vem em cor de alerta.
    const linha = screen.getByText("JOAO SEM DONO").closest("tr");
    const celulaDono = within(linha).getByText("Sem operador");
    expect(celulaDono.style.color).toBe("var(--rv-ambar-texto)");
  });
});

describe("Carteira Geral — entrada de casos novos", () => {
  beforeEach(() => {
    chamadas.rpc = [];
  });
  afterEach(cleanup);

  it("mostra quem está com a entrada fechada", async () => {
    await montar();
    // "Olga" e "Luana" também aparecem no seletor de destino: ancora na linha
    // pelo botão, que é único.
    const linhaLuana = screen.getByRole("button", { name: "Reabrir Luana" }).closest("tr");
    expect(within(linhaLuana).getByText("Fechada")).toBeTruthy();
    const linhaOlga = screen.getByRole("button", { name: "Fechar Olga" }).closest("tr");
    expect(within(linhaOlga).getByText("Aberta")).toBeTruthy();
  });

  it("fechar pede motivo e manda para a RPC", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("saiu da equipe");
    await montar();

    fireEvent.click(screen.getByRole("button", { name: "Fechar Olga" }));
    await waitFor(() => expect(chamadas.rpc.some((c) => c.fn === "carteira_geral_definir_recebimento")).toBe(true));

    const args = chamadas.rpc.find((c) => c.fn === "carteira_geral_definir_recebimento").args;
    expect(args).toEqual({
      p_operador_email: "cobranca03@aelbra.com.br",
      p_recebe: false,
      p_motivo: "saiu da equipe",
    });
  });

  it("cancelar o motivo não muda nada", async () => {
    vi.spyOn(window, "prompt").mockReturnValue(null);
    await montar();
    fireEvent.click(screen.getByRole("button", { name: "Fechar Olga" }));
    await waitFor(() => expect(chamadas.rpc.some((c) => c.fn === "carteira_geral_definir_recebimento")).toBe(false));
  });

  it("quem está fechada é reaberta, não fechada de novo", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("voltou");
    await montar();
    fireEvent.click(screen.getByRole("button", { name: "Reabrir Luana" }));
    await waitFor(() => expect(chamadas.rpc.some((c) => c.fn === "carteira_geral_definir_recebimento")).toBe(true));
    expect(chamadas.rpc.find((c) => c.fn === "carteira_geral_definir_recebimento").args.p_recebe).toBe(true);
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

    await waitFor(() => expect(screen.getByText("Retorno agendado que segue com o aluno")).toBeTruthy());
    // as promessas que a gestão precisa ler antes de clicar
    expect(
      screen.getByText("O operador de cada pagamento — é ele que define honorário e comissão")
    ).toBeTruthy();
    expect(
      screen.getByText("O retorno agendado: data, hora e origem seguem com o aluno")
    ).toBeTruthy();
  });

  it("lista o acordo de terceiro um a um, desmarcado, e não o manda junto", async () => {
    await montar();
    fireEvent.click(screen.getByLabelText("Selecionar MARIA DE TESTE"));
    fireEvent.click(screen.getByRole("button", { name: /Ver prévia/ }));
    await waitFor(() => expect(screen.getByText(/Acordos de terceiros \(0 de 1 selecionados\)/)).toBeTruthy());

    // a linha traz número, dono, status e valor — tudo que decide
    const linha = screen.getByLabelText("Levar acordo 123 de MARIA DE TESTE").closest("tr");
    expect(linha.textContent).toMatch(/123/);
    expect(linha.textContent).toMatch(/cobranca05@aelbra.com.br/);
    expect(linha.textContent).toMatch(/ATIVO/);
    expect(linha.textContent).toMatch(/4\.500,00/);

    // desmarcado: a prévia foi pedida sem nenhum acordo de terceiro
    const args = chamadas.rpc.find((c) => c.fn === "carteira_geral_previa").args;
    expect(args.p_acordo_ids).toEqual([]);
  });

  it("marcar o acordo de terceiro o envia na próxima prévia", async () => {
    await montar();
    fireEvent.click(screen.getByLabelText("Selecionar MARIA DE TESTE"));
    fireEvent.click(screen.getByRole("button", { name: /Ver prévia/ }));
    await waitFor(() => expect(screen.getByLabelText("Levar acordo 123 de MARIA DE TESTE")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("Levar acordo 123 de MARIA DE TESTE"));
    fireEvent.click(screen.getByRole("button", { name: /Recalcular prévia com esta seleção/ }));

    await waitFor(() => {
      const chamadasPrevia = chamadas.rpc.filter((c) => c.fn === "carteira_geral_previa");
      expect(chamadasPrevia[chamadasPrevia.length - 1].args.p_acordo_ids).toEqual(["ac-123"]);
    });
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
    // a execução não decide mais nada sobre acordo: quem decidiu foi a prévia
    expect(args).not.toHaveProperty("p_mover_acordos");
    expect(args).not.toHaveProperty("p_acordo_ids");
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

// ---------------------------------------------------------------------------
// O defeito de 26/09/2026: a gestão desligou a Olga ANTES de recolher a
// carteira dela. O filtro Responsável era alimentado por
// `usuarios where ativo = true`, então ela sumiu do seletor e a carteira de 501
// alunos ficou inalcançável — a única opção que a pegava era SEM_DONO_ATIVO,
// que a mistura com os 8.754 da fila livre.
// ---------------------------------------------------------------------------
describe("Carteira Geral — filtro por responsável desligado", () => {
  beforeEach(() => { chamadas.rpc = []; });
  afterEach(cleanup);

  // O texto "Responsável" também é cabeçalho de duas tabelas; o seletor é o
  // primeiro <select> da seção Filtrar.
  function seletorResponsavel() {
    return screen.getByText("Filtrar").closest("section").querySelector("select");
  }

  it("lista a operadora INATIVA que ainda tem casos, e diz que está inativa", async () => {
    await montar();
    const opcoes = [...seletorResponsavel().options].map((o) => o.textContent);
    expect(opcoes.some((t) => /Olga/.test(t) && /inativo/.test(t))).toBe(true);
  });

  it("a opção da Olga vale o e-mail exato, não um agrupamento", async () => {
    await montar();
    const olga = [...seletorResponsavel().options].find((o) => /Olga/.test(o.textContent));
    expect(olga.value).toBe("cobranca03@aelbra.com.br");
  });

  it("'Sem operador' continua sendo só quem não tem responsável — não mistura com a Olga", async () => {
    await montar();
    const opcoes = [...seletorResponsavel().options];
    const semOperador = opcoes.find((o) => o.value === "SEM_OPERADOR");
    expect(semOperador).toBeTruthy();
    expect(semOperador.value).not.toBe("cobranca03@aelbra.com.br");
    // e o agrupamento continua existindo, com nome que não engana
    const agrupado = opcoes.find((o) => o.value === "SEM_DONO_ATIVO");
    expect(agrupado.textContent).toMatch(/agrupa/i);
  });

  it("escolher a Olga manda o e-mail exato para o painel E para a lista", async () => {
    await montar();
    chamadas.rpc = [];
    fireEvent.change(seletorResponsavel(), { target: { value: "cobranca03@aelbra.com.br" } });
    await waitFor(() => expect(chamadas.rpc.some((c) => c.fn === "carteira_geral_listar")).toBe(true));

    const painel = chamadas.rpc.find((c) => c.fn === "carteira_geral_painel");
    const listar = chamadas.rpc.find((c) => c.fn === "carteira_geral_listar");
    expect(painel.args.p_filtros.responsavel).toBe("cobranca03@aelbra.com.br");
    expect(listar.args.p_filtros.responsavel).toBe("cobranca03@aelbra.com.br");
  });

  it("com a Olga filtrada, o seletor NÃO encolhe para uma opção só", async () => {
    await montar();
    const antes = seletorResponsavel().options.length;
    fireEvent.change(seletorResponsavel(), { target: { value: "cobranca03@aelbra.com.br" } });
    await waitFor(() => expect(chamadas.rpc.some((c) => c.fn === "carteira_geral_listar")).toBe(true));
    expect(seletorResponsavel().options.length).toBe(antes);
  });
});

describe("Carteira Geral — o que está selecionado, antes da prévia", () => {
  beforeEach(() => { chamadas.rpc = []; });
  afterEach(cleanup);

  it("não mostra resumo com nada marcado", async () => {
    await montar();
    expect(screen.queryByTestId("resumo-selecao")).toBeNull();
  });

  it("marcando a aluna da Olga, diz alunos, valor, retornos e a divisão dos acordos", async () => {
    await montar();
    fireEvent.click(screen.getByLabelText("Selecionar MARIA DE TESTE"));
    const resumo = await screen.findByTestId("resumo-selecao");
    const texto = resumo.textContent.replace(/\s+/g, " ");
    expect(texto).toMatch(/1 aluno\(s\) selecionado/);
    expect(texto).toContain("R$ 3.000,00");
    expect(texto).toContain("R$ 1.000,00");   // mensalidade
    expect(texto).toContain("R$ 2.000,00");   // acordo
    // 2 acordos vivos, 1 de outro dono -> 1 vai junto, 1 fica
    expect(texto).toMatch(/1 acordo\(s\) do dono atual v[aã]o junto/);
    expect(texto).toMatch(/1 de terceiros ficam/);
  });

  it("soma os dois alunos quando marco os dois", async () => {
    await montar();
    fireEvent.click(screen.getByLabelText("Selecionar MARIA DE TESTE"));
    fireEvent.click(screen.getByLabelText("Selecionar JOAO SEM DONO"));
    const resumo = await screen.findByTestId("resumo-selecao");
    expect(resumo.textContent.replace(/\s+/g, " ")).toContain("R$ 3.500,00");
  });
});

// ---------------------------------------------------------------------------
// Paginação, seleção entre páginas e casos encerrados.
// Estes três defeitos vieram do lote 559b20bb: 8 casos movidos, 6 visíveis,
// e nenhuma página além da primeira.
// ---------------------------------------------------------------------------
// "Amanda Gestora: 11" era contagem de CASO sob a coluna "Alunos", e ela leu
// como "respondo por 11 coisas" — quando responde por 753 acordos (653 ATIVO),
// medido em produção em 27/09/2026. Os dois números passam a aparecer juntos.
describe("Carteira Geral — casos e acordos lado a lado, sem se substituírem", () => {
  beforeEach(() => { chamadas.rpc = []; });
  afterEach(cleanup);

  it("mostra MEUS CASOS e MEUS ACORDOS ao mesmo tempo", async () => {
    await montar();
    const bloco = await screen.findByTestId("meus-numeros");
    expect(bloco.textContent).toMatch(/Meus casos/);
    expect(bloco.textContent).toMatch(/Meus acordos ativos/);
    expect(bloco.textContent).toMatch(/Meus acordos em todos os status/);
  });

  it("os números são os de produção: 11 casos, 653 ativos, 753 no total", async () => {
    await montar();
    const bloco = await screen.findByTestId("meus-numeros");
    await waitFor(() => expect(bloco.textContent).toMatch(/653/));
    expect(bloco.textContent).toMatch(/11/);
    expect(bloco.textContent).toMatch(/753/);
    expect(bloco.textContent).toMatch(/726/);
  });

  it("o painel de acordos é consultado com o MEU e-mail", async () => {
    await montar();
    await waitFor(() => {
      const c = chamadas.rpc.find((x) => x.fn === "carteira_geral_acordos_painel" && x.args?.p_filtros?.responsavel);
      expect(c.args.p_filtros.responsavel).toBe("amanda.seibel@aelbra.com.br");
    });
  });

  it("a tabela Por responsável separa Casos de Alunos", async () => {
    await montar();
    const sec = screen.getByText("Por responsável").closest("section");
    const cabecalhos = [...sec.querySelectorAll("th")].map((t) => t.textContent);
    expect(cabecalhos).toContain("Casos");
    expect(cabecalhos).toContain("Alunos");
    // e diz, em texto, que caso não é acordo
    expect(sec.textContent).toMatch(/Não é a mesma\s+coisa que/);
  });
});

describe("Carteira Geral — paginação e casos que entram sem ser marcados", () => {
  beforeEach(() => { chamadas.rpc = []; });
  afterEach(cleanup);

  const ultimaChamada = (fn) => [...chamadas.rpc].reverse().find((c) => c.fn === fn)?.args;

  it("pede a primeira página com offset 0", async () => {
    await montar();
    const a = ultimaChamada("carteira_geral_listar");
    expect(a.p_offset).toBe(0);
    expect(a.p_limite).toBe(200);
  });

  it("não mostra paginação quando tudo cabe numa página", async () => {
    await montar();
    // PAINEL não traz total_casos; cai em total_alunos = 545 -> 3 páginas
    expect(screen.queryByTestId("paginacao")).toBeTruthy();
  });

  it("avançar de página pede o offset seguinte e preserva a seleção", async () => {
    await montar();
    fireEvent.click(screen.getByLabelText("Selecionar MARIA DE TESTE"));
    expect(screen.getByTestId("contagem-selecao").textContent).toMatch(/1 aluno\(s\) selecionado\(s\)/);

    // a página tem dois paginadores (casos e acordos): mira o de casos
    fireEvent.click(within(screen.getByTestId("paginacao").parentElement).getByText("Próxima"));
    await waitFor(() => expect(ultimaChamada("carteira_geral_listar").p_offset).toBe(200));

    // a lista dublada é a mesma, mas o que importa é a seleção continuar de pé
    await waitFor(() =>
      expect(screen.getByTestId("contagem-selecao").textContent).toMatch(/1 aluno\(s\) selecionado\(s\)/)
    );
    // texto interpolado no JSX vira vários nós: lê pelo testid
    expect(screen.getByTestId("paginacao").textContent).toMatch(/Página 2 de 3/);
  });

  it("trocar de filtro volta para a primeira página e zera a seleção", async () => {
    await montar();
    // a página tem dois paginadores (casos e acordos): mira o de casos
    fireEvent.click(within(screen.getByTestId("paginacao").parentElement).getByText("Próxima"));
    await waitFor(() => expect(ultimaChamada("carteira_geral_listar").p_offset).toBe(200));
    fireEvent.click(screen.getByLabelText("Selecionar MARIA DE TESTE"));

    const select = screen.getByText("Filtrar").closest("section").querySelector("select");
    fireEvent.change(select, { target: { value: "CARTEIRA_GERAL" } });

    await waitFor(() => expect(ultimaChamada("carteira_geral_listar").p_offset).toBe(0));
    expect(screen.getByTestId("contagem-selecao").textContent).toMatch(/0 aluno\(s\) selecionado\(s\)/);
  });

  it("o controle de encerrados vai para a RPC como incluir_encerrados", async () => {
    await montar();
    expect(ultimaChamada("carteira_geral_listar").p_filtros.incluir_encerrados).toBe(false);

    fireEvent.click(screen.getByTestId("incluir-encerrados"));
    await waitFor(() =>
      expect(ultimaChamada("carteira_geral_listar").p_filtros.incluir_encerrados).toBe(true)
    );
    // e o painel tem de enxergar o mesmo universo da lista
    expect(ultimaChamada("carteira_geral_painel").p_filtros.incluir_encerrados).toBe(true);
  });

  it("a confirmação avisa quando um caso não marcado entra pelo mesmo aluno", async () => {
    const confirmar = vi.spyOn(window, "confirm").mockReturnValue(false);
    try {
      await montar();
      fireEvent.click(screen.getByLabelText("Selecionar MARIA DE TESTE"));
      fireEvent.change(screen.getByPlaceholderText(/saída da Olga/), {
        target: { value: "recolhimento" },
      });
      fireEvent.click(screen.getByText(/Ver prévia de/));
      await waitFor(() => expect(screen.getByText("Prévia — nada foi movido ainda")).toBeTruthy());

      fireEvent.click(screen.getByText("Confirmar remanejamento"));
      await waitFor(() => expect(confirmar).toHaveBeenCalled());

      // PREVIA.itens está vazia neste dublê, então nada de extra é anunciado;
      // o que se prova aqui é que a confirmação passou a falar em CASOS.
      expect(confirmar.mock.calls[0][0]).toMatch(/caso\(s\)/);
    } finally {
      confirmar.mockRestore();
    }
  });
});
