// @vitest-environment jsdom
//
// A GUARDA NO PAINEL. O motor ja recusa parcela/acordo fora de cobranca, mas o
// painel jogava `resultados` fora e exibia so "Revisao necessaria ·
// CONJUNTO_COM_EXCECAO": o operador via QUE precisava revisar e nao via POR QUE.
// Estes testes travam as tres regras que a gestao pediu por escrito:
//   1. sem identidade, ambiguo ou divergente => revisao manual, com o motivo visivel;
//   2. candidato NAO e pagamento confirmado nem baixa autorizada, e a tela diz isso;
//   3. o painel nao aciona baixa, quitacao ou qualquer escrita.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

const analisar = vi.fn();
// O cliente falso registra TODA chamada. Se o painel tentar escrever, o teste ve.
const chamadas = [];
const supabaseFalso = {
  from: (tabela) => {
    chamadas.push({ tipo: "from", tabela });
    const q = {
      select: () => q, eq: () => q, order: () => q,
      limit: () => Promise.resolve({ data: [{ id: "c1", data_pagamento: "2026-10-07" }], error: null }),
      insert: () => { chamadas.push({ tipo: "insert", tabela }); return q; },
      update: () => { chamadas.push({ tipo: "update", tabela }); return q; },
      upsert: () => { chamadas.push({ tipo: "upsert", tabela }); return q; },
      delete: () => { chamadas.push({ tipo: "delete", tabela }); return q; },
    };
    return q;
  },
  rpc: (fn) => { chamadas.push({ tipo: "rpc", fn }); return Promise.resolve({ data: null, error: null }); },
};

vi.mock("../services/supabase", () => ({ supabase: supabaseFalso }));
vi.mock("../services/analiseFinanceiraF1b", () => ({
  analisarConfirmacaoF1bNoCRM: (...a) => analisar(...a),
}));

const { default: DiagnosticoF1b } = await import("./DiagnosticoF1b");

afterEach(cleanup);
beforeEach(() => { analisar.mockReset(); chamadas.length = 0; });

async function abrir() {
  render(<DiagnosticoF1b alunoId="u1" />);
  fireEvent.click(screen.getByRole("button", { name: /Análise F1\.b/ }));
  await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
  return screen.getByRole("status");
}

describe("painel F1.b: a guarda de cancelamento na tela", () => {
  it("parcela fora de cobrança diz POR QUE, com o status que causou a recusa", async () => {
    analisar.mockResolvedValue({
      situacao: "REVISAO", motivo: "CONJUNTO_COM_EXCECAO", prova_do_conjunto: "VINCULO_GRAVADO",
      resultados: [{ pagamento_id: "g1", situacao: "REVISAO", motivo: "PARCELA_FORA_DE_COBRANCA",
                     status_parcela: "CANCELADA", acordo_id: "a1", parcela_id: "p1" }],
    });
    const painel = await abrir();
    expect(painel.textContent).toMatch(/Revisão necessária/);
    expect(painel.textContent).toMatch(/a parcela está fora de cobrança \(CANCELADA\)/);
    // e nunca a palavra que faria o operador agir como se estivesse resolvido
    expect(painel.textContent).not.toMatch(/Candidato identificado/);
  });

  it("acordo fora de cobrança aparece com o status do acordo", async () => {
    analisar.mockResolvedValue({
      situacao: "REVISAO", motivo: "CONJUNTO_COM_EXCECAO",
      resultados: [{ pagamento_id: "g1", situacao: "REVISAO", motivo: "ACORDO_FORA_DE_COBRANCA",
                     status_acordo: "CANCELADO" }],
    });
    expect((await abrir()).textContent).toMatch(/o acordo está fora de cobrança \(CANCELADO\)/);
  });

  it("status não carregado é dito como tal, não como cancelamento", async () => {
    analisar.mockResolvedValue({
      situacao: "REVISAO", motivo: "CONJUNTO_COM_EXCECAO",
      resultados: [{ pagamento_id: "g1", situacao: "REVISAO", motivo: "PARCELA_SEM_STATUS",
                     status_parcela: null }],
    });
    const painel = await abrir();
    expect(painel.textContent).toMatch(/o status da parcela não foi carregado/);
    expect(painel.textContent).not.toMatch(/fora de cobrança/);
  });

  it("REGRA 1: falta de identidade vai para revisão com o motivo na tela", async () => {
    analisar.mockResolvedValue({
      situacao: "REVISAO", motivo: "IDENTIDADE_NAO_COMPROVADA",
      motivo_identidade: "MATRICULA_SEM_REGISTRO_PRIME",
    });
    const painel = await abrir();
    expect(painel.textContent).toMatch(/Revisão necessária/);
    expect(painel.textContent).toMatch(/IDENTIDADE_NAO_COMPROVADA/);
    expect(painel.textContent).toMatch(/identidade: MATRICULA_SEM_REGISTRO_PRIME/);
  });

  it("REGRA 1: ambiguidade do resolver chega à tela com o texto dele", async () => {
    analisar.mockResolvedValue({
      situacao: "REVISAO", motivo: "RESOLVER_AMBIGUO",
      motivo_resolver: "vinculo gravado nao confere: soma 50 x valor 100",
    });
    const painel = await abrir();
    expect(painel.textContent).toMatch(/RESOLVER_AMBIGUO/);
    expect(painel.textContent).toMatch(/soma 50 x valor 100/);
  });

  it("REGRA 2: candidato é apresentado como candidato, nunca como pagamento confirmado", async () => {
    analisar.mockResolvedValue({
      situacao: "CANDIDATOS_IDENTIFICADOS", motivo: "CONJUNTO_RESOLVIDO_IDENTIFICADORES_VALIDOS",
      prova_do_conjunto: "CHAVE_MESMA_TRANSACAO", pagamento_confirmado: false, baixa_confirmada: false,
      resultados: [{ pagamento_id: "g1", situacao: "CANDIDATO_DETERMINISTICO", prova: "CHAVE_MESMA_TRANSACAO" }],
    });
    const painel = await abrir();
    expect(painel.textContent)
      .toMatch(/Candidato identificado — não é pagamento confirmado nem baixa autorizada/);
    expect(painel.textContent).toMatch(/Somente leitura; não comprova pagamento nem baixa/);
    // a origem do conjunto fica explicita: as duas rotas nao tem o mesmo peso
    expect(painel.textContent).toMatch(/reconstruído pela transação do import \(legado\)/);
    // candidato nao gera linha de excecao
    expect(painel.textContent).not.toMatch(/⚠/);
  });

  it("REGRA 3: abrir e ler o painel não dispara nenhuma escrita nem RPC", async () => {
    analisar.mockResolvedValue({ situacao: "REVISAO", motivo: "SEM_VINCULO_GRAVADO" });
    await abrir();
    expect(chamadas.filter(c => ["insert", "update", "upsert", "delete", "rpc"].includes(c.tipo)))
      .toEqual([]);
    // o painel so le a fila de confirmacoes; o resto e do servico, que tem teste proprio
    expect(chamadas.map(c => c.tabela)).toEqual(["solicitacoes_confirmacao_pagamento"]);
  });

  it("REGRA 3: o painel não oferece botão de ação — só abrir e ocultar", async () => {
    analisar.mockResolvedValue({ situacao: "REVISAO", motivo: "SEM_VINCULO_GRAVADO" });
    await abrir();
    const rotulos = screen.getAllByRole("button").map(b => b.textContent);
    expect(rotulos).toEqual(["Ocultar análise F1.b"]);
    expect(rotulos.some(r => /baix|quit|confirm|aplicar|vincul/i.test(r))).toBe(false);
  });

  it("várias exceções no mesmo conjunto aparecem todas", async () => {
    analisar.mockResolvedValue({
      situacao: "REVISAO", motivo: "CONJUNTO_COM_EXCECAO",
      resultados: [
        { pagamento_id: "g1", situacao: "REVISAO", motivo: "PARCELA_FORA_DE_COBRANCA", status_parcela: "SUSPENSA" },
        { pagamento_id: "g2", situacao: "REVISAO", motivo: "ACORDO_NAO_ENCONTRADO" },
        { pagamento_id: "g3", situacao: "CANDIDATO_DETERMINISTICO" },
      ],
    });
    const painel = await abrir();
    expect(painel.textContent).toMatch(/a parcela está fora de cobrança \(SUSPENSA\)/);
    expect(painel.textContent).toMatch(/pagamento de mensalidade/);
    expect(painel.querySelectorAll("div")).toBeTruthy();
    // a linha que virou candidato nao entra nas excecoes
    expect((painel.textContent.match(/⚠/g) ?? [])).toHaveLength(2);
  });

  it("motivo desconhecido não quebra a tela: aparece cru em vez de desaparecer", async () => {
    analisar.mockResolvedValue({
      situacao: "REVISAO", motivo: "CONJUNTO_COM_EXCECAO",
      resultados: [{ pagamento_id: "g1", situacao: "REVISAO", motivo: "MOTIVO_QUE_AINDA_NAO_EXISTE" }],
    });
    expect((await abrir()).textContent).toMatch(/MOTIVO_QUE_AINDA_NAO_EXISTE/);
  });

  it("erro de leitura diz que nada foi proposto", async () => {
    analisar.mockRejectedValue(new Error("falhou"));
    expect((await abrir()).textContent)
      .toMatch(/Não foi possível concluir a leitura\. Nenhum vínculo foi proposto\./);
  });
});
