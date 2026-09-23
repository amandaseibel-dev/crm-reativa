// @vitest-environment jsdom
//
// A ABA "NAO BAIXADOS / REJEITADOS" DA PROJECAO.
//
// O QUE ESTE TESTE PROVA
//   * a tela chama UMA rpc, `projecao_nao_baixados`, e nenhuma de escrita --
//     abrir, filtrar e exportar nao baixam, nao reprocessam e nao mexem na fila;
//   * os filtros da tela chegam ao banco, e campo vazio NAO vira filtro;
//   * o motivo aparece em toda linha, inclusive o MOTIVO_NAO_CLASSIFICADO;
//   * rejeicao mostra o motivo e feito mostra a conclusao, em portugues;
//   * a visao por aluno abre os pagamentos daquele aluno;
//   * quem nao e da gestao ve a recusa, nao uma tela vazia.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import NaoBaixadosRejeitados from "./NaoBaixadosRejeitados";
import {
  linhaExportavel, COLUNAS_PAGAMENTO, COLUNAS_ALUNO, montarWorkbook, nomeArquivo,
} from "../../utils/relatorioNaoBaixados";

const q = vi.hoisted(() => ({ rpcs: [], resposta: { data: null, error: null } }));

vi.mock("../../services/supabase", () => ({
  supabase: {
    rpc(nome, args) {
      q.rpcs.push({ nome, args });
      return Promise.resolve(q.resposta);
    },
    from() { throw new Error("esta tela nao acessa tabela direto"); },
  },
}));

const LINHA_PENDENTE = {
  pagamento_id: "p1", data_pagamento: "2026-09-17", importado_em: "2026-09-17T14:04:00Z",
  arquivo_nome: "17.09 11.03.xlsx", aluno_id: "a1", aluno_nome: "Ana Pendente",
  matricula: "2320001", cpf_mascarado: "600.548.710-85", boleto: "50718590001",
  titulo_numero: "71859", acordo_numero: null, parcela_numero: null,
  valor_pago: 1000, valor_honorario: 80, operador_nome: "Nataly",
  status_conciliacao: "AGUARDANDO_ACORDO", status_baixa: "NAO_BAIXADO",
  situacao_parcela: "SEM_PARCELA", motivo_categoria: "AGUARDANDO_ACORDO",
  motivo_texto: "boleto 50718590001 nao existe em parcelas e o acordo 071859 nao esta no CRM",
  status_fila: "ABERTA", resultado_analise: "PENDENTE", decisao: null,
  conclusao: null, motivo_rejeicao: null, observacao: null,
  decidido_por: null, decidido_em: null, saldo_total: 5000, saldo_vencido: 2000,
  primeira_tentativa_em: "2026-09-17T14:04:00Z", ultima_tentativa_em: "2026-09-22T09:00:00Z",
  quantidade_tentativas: 3,
};

const LINHA_REJEITADA = {
  ...LINHA_PENDENTE, pagamento_id: "p2", aluno_id: "a2", aluno_nome: "Bruno Rejeitado",
  boleto: "50718600001", valor_pago: 2500, resultado_analise: "REJEITADO",
  status_fila: "DECIDIDA", decisao: "REJEITADO", motivo_rejeicao: "NAO_E_ENTRADA_DE_ACORDO",
  observacao: "conferido no Prime: e mensalidade avulsa",
  decidido_por: "amanda.seibel@aelbra.com.br", decidido_em: "2026-09-22T10:00:00Z",
  saldo_total: 0,
};

const LINHA_FEITA = {
  ...LINHA_PENDENTE, pagamento_id: "p3", aluno_id: "a3", aluno_nome: "Carla Feito",
  boleto: "50718610001", valor_pago: 300, status_conciliacao: "PARCELA_JA_PAGA",
  motivo_categoria: "PARCELA_JA_PAGA", situacao_parcela: "PAGA",
  resultado_analise: "FEITO", status_fila: "DECIDIDA", decisao: "FEITO",
  conclusao: "JA_TRATADO", motivo_rejeicao: null,
  decidido_por: "cobranca04@aelbra.com.br", decidido_em: "2026-09-21T11:00:00Z",
};

const LINHA_ANTIGA = {
  ...LINHA_PENDENTE, pagamento_id: "p4", aluno_id: null, aluno_nome: "Diego Antigo",
  boleto: "50700010001", valor_pago: 4321, status_conciliacao: null,
  status_baixa: "NAO_REGISTRADO", motivo_categoria: "MOTIVO_NAO_CLASSIFICADO",
  motivo_texto: "importado antes de 14/09/2026, quando a conciliacao passou a registrar o desfecho",
  resultado_analise: "SEM_ANALISE", status_fila: "FORA_DA_FILA", saldo_total: 0,
};

const RESPOSTA = {
  limite: 2000, truncado: false,
  contadores: {
    linhas: 4, valor_total: 8121, nao_baixados: 4, valor_nao_baixado: 8121,
    pendentes: 1, valor_pendente: 1000, feito: 1, valor_feito: 300,
    rejeitado: 1, valor_rejeitado: 2500, encerrado_gestao: 0, resolvido_automatico: 0,
    sem_analise: 1, sem_estrutura: 0, aguardando_acordo: 3, parcela_ja_paga: 1,
    revisao: 0, sem_motivo: 0, alunos_unicos: 4,
  },
  por_aluno: [
    { aluno_id: "a2", aluno_nome: "Bruno Rejeitado", matricula: "2320002", qtd: 1,
      qtd_nao_baixado: 1, valor_total: 2500, qtd_pendente: 0, qtd_feito: 0,
      qtd_rejeitado: 1, saldo_total: 0, pagamento_mais_antigo: "2026-09-16",
      ultimo_pagamento: "2026-09-16", principal_motivo: "AGUARDANDO_ACORDO" },
  ],
  linhas: [LINHA_REJEITADA, LINHA_PENDENTE, LINHA_ANTIGA, LINHA_FEITA],
};

beforeEach(() => {
  q.rpcs = [];
  q.resposta = { data: RESPOSTA, error: null };
});
afterEach(() => cleanup());

const esperarCarga = () => waitFor(() => expect(q.rpcs.length).toBeGreaterThan(0));

describe("a aba abre sem escrever nada", () => {
  it("chama so `projecao_nao_baixados`, e sem filtro nenhum", async () => {
    render(<NaoBaixadosRejeitados />);
    await esperarCarga();
    expect(q.rpcs).toHaveLength(1);
    expect(q.rpcs[0].nome).toBe("projecao_nao_baixados");
    expect(q.rpcs[0].args).toEqual({ p_filtros: {} });
  });

  it("nenhuma rpc de escrita da conciliacao e chamada, nem ao filtrar", async () => {
    render(<NaoBaixadosRejeitados />);
    await esperarCarga();
    fireEvent.click(screen.getByText("Aplicar filtros"));
    await waitFor(() => expect(q.rpcs.length).toBe(2));
    // Lista NOMINAL. Um padrao solto ("baixa") casaria com o proprio
    // `projecao_nao_baixados` e o teste passaria por acidente.
    const ESCRITA = [
      "conciliacao_feito", "conciliacao_rejeitar", "conciliacao_encerrar",
      "pagamento_vincular_aluno", "pagamento_conciliar_um", "conciliacao_reprocessar",
      "acordo_avista_registrar", "projecao_reprocessar_importacao",
    ];
    expect(q.rpcs.every((r) => r.nome === "projecao_nao_baixados")).toBe(true);
    expect(q.rpcs.some((r) => ESCRITA.includes(r.nome))).toBe(false);
  });
});

describe("os filtros chegam ao banco", () => {
  it("campo vazio nao vira filtro; campo preenchido vira", async () => {
    render(<NaoBaixadosRejeitados />);
    await esperarCarga();

    fireEvent.change(screen.getByPlaceholderText("nome, matrícula ou CPF"), { target: { value: " Bruno " } });
    fireEvent.click(screen.getByRole("button", { name: "Rejeitado" }));
    fireEvent.click(screen.getByLabelText(/anteriores a 14\/09\/2026/i, { exact: false }));
    fireEvent.click(screen.getByText("Aplicar filtros"));

    await waitFor(() => expect(q.rpcs.length).toBe(2));
    expect(q.rpcs[1].args.p_filtros).toEqual({
      termo: "Bruno",
      resultado: ["REJEITADO"],
      incluir_sem_estado: true,
    });
  });

  it("limpar volta ao recorte padrao", async () => {
    render(<NaoBaixadosRejeitados />);
    await esperarCarga();
    fireEvent.change(screen.getByPlaceholderText("50712620001"), { target: { value: "50718590001" } });
    fireEvent.click(screen.getByText("Aplicar filtros"));
    await waitFor(() => expect(q.rpcs.length).toBe(2));
    fireEvent.click(screen.getByText("Limpar"));
    await waitFor(() => expect(q.rpcs.length).toBe(3));
    expect(q.rpcs[2].args).toEqual({ p_filtros: {} });
  });
});

describe("a linha explica por que nao baixou", () => {
  it("toda linha mostra motivo -- inclusive a que nao tem estado gravado", async () => {
    render(<NaoBaixadosRejeitados />);
    await screen.findByText("Ana Pendente");
    expect(screen.getAllByText("Aguardando acordo").length).toBeGreaterThan(1);
    expect(screen.getByText("Motivo não classificado")).toBeTruthy();
    expect(screen.getByText(/antes de 14\/09\/2026/)).toBeTruthy();
    expect(screen.getByText("Sem registro de baixa")).toBeTruthy();
  });

  it("rejeicao e conclusao aparecem em portugues, com quem decidiu", async () => {
    render(<NaoBaixadosRejeitados />);
    await screen.findByText("Bruno Rejeitado");
    expect(screen.getByText("rejeição: Não é entrada de acordo")).toBeTruthy();
    expect(screen.getByText("conclusão: Pagamento já tratado corretamente")).toBeTruthy();
    expect(screen.getByText(/amanda\.seibel@aelbra\.com\.br/)).toBeTruthy();
    expect(screen.getByText("“conferido no Prime: e mensalidade avulsa”")).toBeTruthy();
  });

  it("mostra tentativas e saldo do aluno", async () => {
    render(<NaoBaixadosRejeitados />);
    await screen.findByText("Ana Pendente");
    expect(screen.getAllByText(/3 tentativa\(s\)/).length).toBeGreaterThan(0);
    expect(screen.getAllByText((t) => t.replace(/\u00a0/g, " ") === "R$ 5.000,00").length).toBeGreaterThan(0);
  });
});

describe("contadores e visao por aluno", () => {
  it("os contadores vem do banco, nao da lista da tela", async () => {
    render(<NaoBaixadosRejeitados />);
    await screen.findByText("Ana Pendente");
    const valorDe = (r) => screen.getByText(r).previousSibling.textContent.replace(/\u00a0/g, " ");
    expect(valorDe("Não baixados")).toBe("4");
    expect(valorDe("Valor não baixado")).toBe("R$ 8.121,00");
    expect(valorDe("Alunos envolvidos")).toBe("4");
  });

  it("a visao por aluno abre os pagamentos do aluno", async () => {
    render(<NaoBaixadosRejeitados />);
    await screen.findByText("Ana Pendente");
    fireEvent.click(screen.getByText("Por aluno"));
    const linhaAluno = await screen.findByText("Bruno Rejeitado");
    expect(screen.queryByText(/boleto 50718600001/)).toBeNull();
    fireEvent.click(linhaAluno);
    expect(await screen.findByText(/boleto 50718600001/)).toBeTruthy();
  });

  it("linha sem motivo nunca deveria existir -- e a tela avisa se existir", async () => {
    q.resposta = { data: { ...RESPOSTA, contadores: { ...RESPOSTA.contadores, sem_motivo: 2 } }, error: null };
    render(<NaoBaixadosRejeitados />);
    expect(await screen.findByText(/2 linha\(s\) sem motivo/)).toBeTruthy();
  });
});

describe("quem nao e da gestao", () => {
  it("ve a recusa, nao uma tela vazia", async () => {
    q.resposta = { data: null, error: { code: "42501", message: "... e da gestao financeira." } };
    render(<NaoBaixadosRejeitados />);
    expect(await screen.findByText("Este relatório é da gestão financeira.")).toBeTruthy();
  });
});

describe("exportacao", () => {
  it("leva TODOS os campos que a gestao pediu", async () => {
    const l = linhaExportavel(LINHA_REJEITADA);
    for (const k of ["motivo", "motivo_detalhe", "conclusao", "motivo_rejeicao", "observacao",
                     "decidido_por", "decidido_em", "saldo_total", "primeira_tentativa",
                     "ultima_tentativa", "quantidade_tentativas", "cpf_mascarado",
                     "importado_em", "status_baixa", "situacao_parcela", "resultado"]) {
      expect(Object.prototype.hasOwnProperty.call(l, k)).toBe(true);
    }
    expect(l.motivo_rejeicao).toBe("Não é entrada de acordo");
    expect(l.resultado).toBe("Rejeitado");
    expect(l.status_baixa).toBe("Não baixado");
    // toda coluna declarada tem chave na linha: cabecalho sem dado nao existe
    for (const col of COLUNAS_PAGAMENTO) {
      expect(Object.prototype.hasOwnProperty.call(l, col.k)).toBe(true);
    }
  });

  it("o arquivo tem as tres abas, e a de leitura explica o nao classificado", () => {
    const wb = montarWorkbook(RESPOSTA);
    expect(wb.SheetNames).toEqual(["Como ler", "Por pagamento", "Por aluno"]);
    const comoLer = JSON.stringify(wb.Sheets["Como ler"]);
    expect(comoLer).toMatch(/14\/09\/2026/);
    expect(comoLer).toMatch(/somente leitura/i);
    const porAluno = wb.Sheets["Por aluno"];
    expect(Object.keys(porAluno).some((k) => porAluno[k]?.v === "Principal motivo")).toBe(true);
    expect(COLUNAS_ALUNO.length).toBeGreaterThan(0);
  });

  it("o nome do arquivo carrega a data da geracao", () => {
    expect(nomeArquivo(new Date(2026, 8, 23, 7, 5))).toBe("nao-baixados-projecao-20260923-0705.xlsx");
  });
});
