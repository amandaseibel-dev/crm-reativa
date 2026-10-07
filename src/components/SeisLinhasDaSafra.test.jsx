// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

import SeisLinhasDaSafra from "./SeisLinhasDaSafra";

// DESDE 07/10/2026 ESTE COMPONENTE NÃO BUSCA NADA. Quem chama
// `carteira_safra_situacoes` é a página, uma vez, e passa o MESMO payload para
// o resumo executivo do topo e para este cartão — era a única forma de os dois
// não poderem divergir na mesma tela. Por isso o teste não dubla mais o
// supabase: ele entrega o payload por prop, que é o contrato real agora.
//
// "Alunos por status" saiu daqui (virou a composição financeira por status
// acadêmico, em ComposicaoAcademicaDoSaldo) e a abertura do Pendente também
// (virou PendenciasDeValidacao). Os testes dessas duas coisas moram nos
// arquivos daqueles componentes; aqui ficou o que é das seis linhas.
//
// Os números abaixo são os MEDIDOS em produção em 05/10/2026, não inventados:
// 2024 fecha em R$ 5.159.080,84 e o Pendente dele é R$ 14.401,19 em confirmação
// mais R$ 25.285,00 de "PAGO sem lastro".
const SAFRA_2024 = {
  recorte: "2024",
  natureza: "COBERTURA_HISTORICA",
  fonte: "acordos_titulos + serie da Prime, ao vivo",
  gerado_em: "2026-10-05T20:45:00Z",
  situacoes: {
    entrou:    { alunos: 2528, titulos: 8469, valor: 5159080.84 },
    pago:      { alunos: 24, titulos: 77, valor: 31369.29 },
    negociado: { alunos: 16, titulos: 58, valor: 34840.53 },
    cancelado: { alunos: 1, titulos: 5, valor: 57550.10 },
    em_aberto: { alunos: 2482, titulos: 8323, valor: 4995634.73 },
    pendente:  { alunos: 19, titulos: 52, valor: 39686.19 },
  },
  conferencia: { entrou: 5159080.84, soma_das_linhas: 5159080.84, diferenca: 0, fecha: true },
  pendente_detalhe: { pago_sem_lastro: 25285.00, em_confirmacao: 14401.19 },
};

const SAFRA_2026_1 = {
  recorte: "2026/1",
  natureza: "CARTEIRA_CONSOLIDADA",
  fonte: "carteira_2026_1_classificar() ao vivo",
  gerado_em: "2026-10-05T20:45:00Z",
  situacoes: {
    entrou:    { alunos: 5247, titulos: 14979, valor: 21710447.29 },
    pago:      { alunos: 1826, titulos: 5068, valor: 6005263.81 },
    negociado: { alunos: 944, titulos: 2961, valor: 4662443.01 },
    cancelado: { alunos: 3, titulos: 15, valor: 112595.16 },
    em_aberto: { alunos: 2103, titulos: 6779, valor: 9136169.08 },
    pendente:  { alunos: 1159, titulos: 2414, valor: 1793976.23 },
  },
  conferencia: { entrou: 21710447.29, soma_das_linhas: 21710447.29, diferenca: 0, fecha: true },
};

const montar = (props) =>
  render(<SeisLinhasDaSafra ano="2024" semestre={null} dados={SAFRA_2024} {...props} />);

afterEach(() => cleanup());

describe("As seis linhas da safra", () => {
  it("desenha as seis linhas na ordem da gestão", () => {
    montar();
    // `getAllByText`: alguns rótulos de linha aparecem também no texto de
    // apoio de outra linha ("Pago", "Negociado"). O que se prova aqui é que as
    // seis existem e na ordem, não que a string é única na tela.
    const rotulos = ["Entrou", "Pago", "Negociado", "Cancelado", "Em aberto",
                     "Pendente de classificação"];
    for (const r of rotulos) {
      expect(screen.getAllByText(r).length).toBeGreaterThanOrEqual(1);
    }
    const texto = document.body.textContent;
    const posicoes = rotulos.map((r) => texto.indexOf(r));
    expect(posicoes).toEqual([...posicoes].sort((a, b) => a - b));
  });

  it("mostra os valores medidos de 2024 sem recompor nada", () => {
    montar();
    // O Entrou vem compacto aqui: o valor é a régua declarada das barras, e a
    // manchete dele é o indicador "Universo recebido" no topo da página.
    expect(screen.getByText(/R\$ 5\.159\.080,84 — é a régua das barras/)).toBeTruthy();
    expect(screen.getByText("R$ 31.369,29")).toBeTruthy();
    expect(screen.getByText("R$ 4.995.634,73")).toBeTruthy();
  });

  it("em 2024/2025 avisa que Entrou é saldo residual, não a carteira original", () => {
    montar();
    expect(screen.getByText(/não é a carteira original/)).toBeTruthy();
    expect(screen.getByText(/saldo residual/)).toBeTruthy();
  });

  it("em 2026/1 diz que os números são de fotografia — nunca que são de agora", () => {
    montar({ ano: "2026", semestre: "1", dados: SAFRA_2026_1 });
    // Calcular esta safra ao vivo não cabe no teto de 8 s, então o rodapé não
    // pode prometer "ao vivo". Prometer frescor que não existe é pior do que
    // dizer a data.
    expect(screen.getByText(/Números de fotografia, não de agora/)).toBeTruthy();
    expect(screen.queryByText(/ao vivo/i)).toBeNull();
    expect(screen.queryByText(/carteira original/)).toBeNull();
  });

  it("mostra a conferência da invariante com a diferença, mesmo quando fecha", () => {
    montar();
    expect(screen.getByText(/Conferência da invariante/)).toBeTruthy();
    expect(screen.getByText(/diferença de R\$ 0,00/)).toBeTruthy();
  });

  it("quando a invariante NÃO fecha, avisa e não ajusta número nenhum", () => {
    montar({ dados: {
      ...SAFRA_2024,
      conferencia: { entrou: 5159080.84, soma_das_linhas: 5159068.50, diferenca: 12.34, fecha: false },
    } });
    expect(screen.getByText(/difere de Entrou em R\$ 12,34/)).toBeTruthy();
    // o Entrou segue exibido como veio, sem correção
    expect(screen.getAllByText(/R\$ 5\.159\.080,84/).length).toBeGreaterThanOrEqual(1);
  });

  it("avisa que contagem de aluno não soma entre linhas", () => {
    montar();
    expect(screen.getByText(/não devem ser somadas/)).toBeTruthy();
  });

  it("aponta onde o Pendente é aberto, em vez de abri-lo aqui de novo", () => {
    montar();
    expect(screen.getByText(/Pendências de validação/)).toBeTruthy();
    // a abertura em frase corrida saiu: ela virou tabela no bloco próprio
    expect(screen.queryByText(/marcado como PAGO sem lastro nenhum/)).toBeNull();
  });

  it("a lista acadêmica quantitativa não mora mais aqui", () => {
    montar();
    expect(screen.queryByText("Alunos por status")).toBeNull();
  });

  it("erro vindo da página aparece na tela em vez de cartão vazio", () => {
    montar({ dados: null, erro: "Acesso negado." });
    expect(screen.getByText(/Não foi possível carregar as seis linhas: Acesso negado./)).toBeTruthy();
  });

  it("enquanto a página busca, diz que está somando", () => {
    montar({ dados: null, carregando: true });
    expect(screen.getByText(/Somando as seis linhas de 2024/)).toBeTruthy();
  });

  it("singular quando é um só", () => {
    montar({ dados: {
      ...SAFRA_2024,
      situacoes: { ...SAFRA_2024.situacoes, cancelado: { alunos: 1, titulos: 1, valor: 10 } },
    } });
    expect(screen.queryByText(/\b1 alunos\b/)).toBeNull();
    expect(screen.queryByText(/\b1 títulos\b/)).toBeNull();
  });
});
