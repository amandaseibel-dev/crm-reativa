// ACOES MASSIVAS: CANAL E VALOR NO BANCO, ANTES DO CORTE -- COMPORTAMENTO.
//
// PostgreSQL real (PGlite) com as definicoes de producao de 16/09/2026 mais as
// migrations do PR #397. Nenhum SQL muda neste ajuste: a tela passa a mandar
// p_canal, p_valor_min e p_valor_max, que a previa ja aceita.
//
// O QUE ESTE TESTE PROVA
//   * a populacao nao muda: com canal/valor no banco a previa devolve exatamente
//     os alunos que a tela obtinha filtrando a lista sem limite (tem_telefone /
//     tem_email e valor), em toda a matriz de filtros, tipos e operadores;
//   * a contagem por tipo e o total da opcao passam a contar essa mesma
//     populacao -- entao contagem e lista so diferem pela Quantidade;
//   * o defeito: com limite pequeno, filtrar depois do corte perde alunos que
//     existem; filtrar antes do corte enche a lista ate o limite.
//
// Bancada (esquema, dubles, carteira inventada): fixtures/acoes_massivas_prod_20260916/bancada.js
import { describe, it, expect, beforeAll, vi } from "vitest";
import {
  MATRIZ, OP_A, OP_B, NOME_POR_ID, previa, novoBanco, chaves,
} from "./fixtures/acoes_massivas_prod_20260916/bancada.js";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

const TIPOS = ["MENSALIDADES", "ACORDOS_VENCIDOS", "MENSALIDADES_E_ACORDOS"];
const CONTATO = { WHATSAPP: (e) => e.tem_telefone, EMAIL: (e) => e.tem_email };
const TOTAL_DA_OPCAO = { MENSALIDADES: "mensalidades", ACORDOS_VENCIDOS: "acordos_vencidos", MENSALIDADES_E_ACORDOS: "total_unico" };

// Empate na ordem (varios "nunca acionado" = mesma chave NULL) nao tem ordem
// garantida no Postgres, nem em producao: desempata por id para comparar. A
// ordem por data_ultimo_acionamento continua conferida.
const ordem = (lista) => [...lista]
  .sort((a, b) => (a.data_ultimo_acionamento ?? "").localeCompare(b.data_ultimo_acionamento ?? "") || a.id.localeCompare(b.id))
  .map((e) => NOME_POR_ID[e.id]);

// O que a tela fazia: pede sem canal/valor e filtra a lista que voltou.
function filtroDaTela(elegiveis, canal, min, max) {
  return elegiveis.filter((e) => CONTATO[canal](e) && Number(e.valor) >= min && (max == null || Number(e.valor) <= max));
}

describe("canal e valor no banco nao mudam a populacao", () => {
  let db;
  beforeAll(async () => { db = await novoBanco({ tipo: true }); });

  it("em toda a matriz x tipo x operador: mesmos alunos, mesma ordem, e a contagem conta essa populacao", async () => {
    const semCanalValor = MATRIZ.filter((a) => !("p_canal" in a) && !("p_valor_min" in a) && !("p_valor_max" in a) && a.p_limite == null);
    let comparacoes = 0;
    for (const op of [null, OP_A, OP_B]) {
      for (const args of semCanalValor) {
        for (const tipo of TIPOS) {
          const base = { ...args, p_tipo_cobranca: tipo, ...(op ? { p_operador_email: op } : {}) };
          const bruta = await previa(db, base);
          for (const [canal, min, max] of [["WHATSAPP", 100, null], ["EMAIL", 100, null], ["WHATSAPP", 300, 800]]) {
            const noBanco = await previa(db, { ...base, p_canal: canal, p_valor_min: min, p_valor_max: max });
            const naTela = filtroDaTela(bruta.elegiveis, canal, min, max);
            expect(ordem(noBanco.elegiveis)).toEqual(ordem(naTela));
            expect(noBanco.total_elegivel_filtros).toBe(naTela.length);
            expect(noBanco.contagem_tipo[TOTAL_DA_OPCAO[tipo]]).toBe(naTela.length);
            comparacoes += 1;
          }
        }
      }
    }
    expect(comparacoes).toBeGreaterThan(100);
  }, 240000);
});

describe("o defeito do corte antes do filtro", () => {
  it("com limite 1 e valor minimo 700, filtrar depois zera a lista; filtrar no banco traz quem existe", async () => {
    const db = await novoBanco({ tipo: true });
    // Carteira de B em "Somente mensalidades", pela ordem da previa:
    // B1 (nunca acionado, R$ 600), B2 (acionado ha 30 dias, R$ 900), B3 (ha 1 dia, R$ 350).
    const base = { p_operador_email: OP_B, p_tipo_cobranca: "MENSALIDADES", p_limite: 1 };
    // Como a tela fazia: o banco devolve so B1, e o filtro de valor o descarta.
    const antes = filtroDaTela((await previa(db, base)).elegiveis, "WHATSAPP", 700, null);
    expect(antes).toEqual([]);
    // Com o valor no banco: vem B2, que existe e atende.
    const depois = await previa(db, { ...base, p_canal: "WHATSAPP", p_valor_min: 700, p_valor_max: null });
    expect(chaves(depois)).toEqual(["B2"]);
    // e a contagem diz quantos existem de verdade para esse canal e valor
    expect(depois.contagem_tipo.mensalidades).toBe(1);
    expect(depois.total_elegivel_filtros).toBe(1);
  });

  it("limite de fora: quem esta em confirmacao de pagamento ainda ocupa vaga no limite (efeito conhecido, anterior)", async () => {
    // A4 (em confirmacao, nunca acionado) disputa as primeiras vagas com A1. A
    // tela manda Quantidade x 3 justamente para sobrar folga; em producao, em
    // 16/09, no maximo 14 das 300 primeiras vagas de um cenario eram assim.
    const db = await novoBanco({ tipo: true });
    const r = await previa(db, { p_operador_email: OP_A, p_tipo_cobranca: "MENSALIDADES", p_limite: 2,
      p_canal: "WHATSAPP", p_valor_min: 100, p_valor_max: null });
    const ocupadas = r.elegiveis.length + r.excluidos_confirmacao.length;
    expect(ocupadas).toBe(2);
    expect(r.total_elegivel_filtros).toBe(4);
  });
});
