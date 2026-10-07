// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

import ComposicaoAcademicaDoSaldo from "./ComposicaoAcademicaDoSaldo";

// O que se prova aqui é a COMPOSIÇÃO FINANCEIRA do saldo em aberto por status
// acadêmico — o bloco que substituiu "Alunos por status" e o card "Status
// acadêmico por safra", que eram quantitativos e diziam a mesma coisa.
//
// DESDE 07/10/2026 ESTE COMPONENTE NÃO BUSCA NADA: a página lê a fotografia por
// `carteira_efetividade_ler('composicao_academica', ...)` e passa o payload por
// prop, porque o MESMO total é o indicador "Saldo em aberto atual" do resumo.
// Buscar nos dois lugares daria dois saldos em aberto na mesma tela.
//
// Nenhuma conta acontece no front: o payload entra como a RPC o entrega, e a
// única conta do desenho é o share de cada linha sobre o total que já veio
// pronto.
//
// A RÉGUA de 2024/2025 é a histórica oficial — a mesma de
// `carteira_saldo_historico_por_ano().aberto`. Os totais abaixo são os medidos
// em produção em 07/10/2026: 1.975 alunos, 6.366 títulos e R$ 3.674.539,61.
const C_2024 = {
  recorte: "2024",
  natureza: "COBERTURA_HISTORICA",
  fonte: "acordos_titulos + serie da Prime, ao vivo",
  universo_em_aberto: "saldo em aberto atual (regua historica oficial)",
  regua: "carteira_saldo_historico_por_ano().aberto",
  gerado_em: "2026-10-07T19:30:00Z",
  snapshot: { gerado_em: "2026-10-07T23:40:00Z", duracao_ms: 2400, bloco: "composicao_academica" },
  total: { alunos: 1975, titulos: 6366, valor: 3674539.61 },
  linhas: [
    { status: "(sem situação importada)", alunos: 806, titulos: 2502, valor: 1964708.62 },
    { status: "Término do Contrato", alunos: 382, titulos: 1200, valor: 700000.00 },
    { status: "Formado", alunos: 152, titulos: 570, valor: 380060.92 },
    { status: "Aguardando Matrícula", alunos: 1, titulos: 2, valor: 1200.00 },
    { status: "Matriculado Curso Normal", alunos: 3, titulos: 8, valor: 4000.00 },
    { status: "Desvinculado", alunos: 631, titulos: 2084, valor: 624570.07 },
  ],
  conferencia: {
    total_valor: 3674539.61, soma_das_linhas: 3674539.61, diferenca: 0, fecha: true,
    titulos_total: 6366, titulos_soma: 6366, alunos_total: 1975, alunos_soma: 1975,
  },
  fonte_academica: { importacao_atualizada_em: "2026-08-04T15:19:51Z" },
};

const C_2026_1 = {
  ...C_2024,
  recorte: "2026/1",
  natureza: "CARTEIRA_CONSOLIDADA",
  fonte: "carteira_2026_1_classificar() ao vivo",
  universo_em_aberto: "inadimplencia + em_validacao",
  regua: "classificacao da safra 2026/1",
  total: { alunos: 2517, titulos: 7802, valor: 9876066.41 },
  linhas: [{ status: "Aguardando Matrícula", alunos: 2517, titulos: 7802, valor: 9876066.41 }],
  conferencia: {
    total_valor: 9876066.41, soma_das_linhas: 9876066.41, diferenca: 0, fecha: true,
    titulos_total: 7802, titulos_soma: 7802, alunos_total: 2517, alunos_soma: 2517,
  },
};

// `toLocaleString` com BRL separa "R$" do número com espaço NÃO quebrável
// (U+00A0). `getByText` normaliza isso sozinho; `textContent` não — e é por
// textContent que se confere uma LINHA inteira da tabela.
const txt = (el) => el.textContent.replace(/\u00a0/g, " ");

const montar = (props = {}) =>
  render(<ComposicaoAcademicaDoSaldo dados={C_2024} {...props} />);

afterEach(() => cleanup());

describe("Composição do saldo em aberto por status acadêmico", () => {
  it("declara a régua do universo que está decompondo", () => {
    montar();
    expect(screen.getByText(/régua: carteira_saldo_historico_por_ano/)).toBeTruthy();
    expect(screen.getByText(/Saldo em aberto atual, pela régua histórica oficial/)).toBeTruthy();
    expect(screen.getByText(/Não é o balde .Em aberto. das seis linhas/)).toBeTruthy();
  });

  it("fecha também em alunos, não só em valor e títulos", () => {
    montar();
    expect(screen.getByText(/1\.975 alunos contra 1\.975 somados/)).toBeTruthy();
  });

  it("sem fotografia, DIZ que falta — não mostra tabela vazia", () => {
    montar({ dados: { sem_snapshot: true, recorte: "2024", bloco: "composicao_academica" } });
    expect(screen.getByText(/ainda não tem fotografia de 2024/)).toBeTruthy();
    expect(screen.queryByText("Total em aberto")).toBeNull();
  });

  it("diz que é lido de fotografia, com a data, e que não dispara reconstrução", () => {
    montar();
    expect(screen.getByText(/Esta composição é lida de fotografia/)).toBeTruthy();
    expect(screen.getByText(/sem disparar reconstrução pesada/)).toBeTruthy();
  });

  it("enquanto a página lê, diz que está compondo", () => {
    montar({ dados: null, carregando: true });
    expect(screen.getByText(/Compondo o saldo em aberto/)).toBeTruthy();
  });

  it("responde a pergunta da diretoria: alunos, títulos e saldo por status", () => {
    montar();
    const linha = screen.getByText("Formado").closest("tr");
    expect(txt(linha)).toContain("152");
    expect(txt(linha)).toContain("570");
    expect(txt(linha)).toContain("R$ 380.060,92");
    expect(txt(linha)).toContain("10,34%");
  });

  it("não agrupa categorias diferentes nem inventa equivalência", () => {
    montar();
    expect(screen.getByText("Aguardando Matrícula")).toBeTruthy();
    expect(screen.getByText("Matriculado Curso Normal")).toBeTruthy();
    expect(screen.queryByText("Outros")).toBeNull();
  });

  it("fecha com o total: a tabela mostra o total em aberto e 100%", () => {
    montar();
    const rodape = screen.getByText("Total em aberto").closest("tr");
    expect(txt(rodape)).toContain("1.975");
    expect(txt(rodape)).toContain("6.366");
    expect(txt(rodape)).toContain("R$ 3.674.539,61");
    expect(txt(rodape)).toContain("100,00%");
  });

  it("mantém visível o buraco de cobertura de 2024, com o percentual", () => {
    montar();
    expect(screen.getByText("(sem situação importada)")).toBeTruthy();
    expect(screen.getByText(/53,47% do saldo de 2024 está sem situação acadêmica importada/)).toBeTruthy();
  });

  it("diz que o status é fotografia da importação, com a data — não consulta de hoje", () => {
    montar();
    expect(screen.getByText(/relatório acadêmico importado em 04\/08\/2026/)).toBeTruthy();
    expect(screen.getByText(/não consulta de hoje/)).toBeTruthy();
  });

  it("publica a conferência da composição mesmo quando ela fecha", () => {
    montar();
    expect(screen.getByText(/Conferência da composição/)).toBeTruthy();
    expect(screen.getByText(/diferença de R\$ 0,00/)).toBeTruthy();
  });

  it("quando a composição NÃO fecha, avisa e não ajusta nada", () => {
    montar({ dados: { ...C_2024, conferencia: { ...C_2024.conferencia, diferenca: 9.9, fecha: false } } });
    expect(screen.getByText(/difere do saldo em aberto em R\$ 9,90/)).toBeTruthy();
    expect(screen.getAllByText("R$ 3.674.539,61").length).toBeGreaterThanOrEqual(1);
  });

  it("em 2026/1 declara que o universo em aberto inclui a validação", () => {
    montar({ dados: C_2026_1 });
    expect(screen.getByText(/universo em aberto inclui o que está em validação/)).toBeTruthy();
  });

  it("erro vindo da página aparece na tela e diz que o resto segue válido", () => {
    montar({ dados: null, erro: "Acesso negado." });
    expect(screen.getByText(/Não foi possível compor o saldo por status acadêmico: Acesso negado/)).toBeTruthy();
    expect(screen.getByText(/seguem válidos/)).toBeTruthy();
  });

});
