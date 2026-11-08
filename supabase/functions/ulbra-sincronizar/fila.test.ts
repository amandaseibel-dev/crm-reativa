// PROVAS DA FILA DE DETALHES E DO ORÇAMENTO.
//
// A simulação usa a MESMA `selecionarDetalhes` que a função de produção usa.
// O que se prova aqui:
//  1. convergência: a fila esvazia se e somente se a chegada média ≤ K;
//  2. nenhuma conversa se perde nem é lida duas vezes por falha;
//  3. falha persistente desiste, e a desistência fica contada;
//  4. 12 horas e 24 horas cabem (ou não cabem) no orçamento, com a conta à vista;
//  5. o portão de orçamento para a leitura no ponto exato em que o saldo acaba.
import { describe, it, expect } from "vitest";
import {
  DETALHE_TENTATIVAS_MAX,
  Orcamento,
  TETO_DIARIO_SYNC,
  candidatasDaColheita,
  colherConversas,
  selecionarDetalhes,
  type FilaDetalhe,
  type Janela,
} from "./sincronizar.ts";

const minuto = (n: number) =>
  `2026-11-08T${Math.floor(n / 60).toString().padStart(2, "0")}:${(n % 60).toString().padStart(2, "0")}:00.000Z`;

/** Roda a fila ciclo a ciclo com a seleção de produção. */
function simular(
  ciclos: number,
  chegadas: (t: number) => string[],
  K: number,
  falha: (id: string, tentativa: number) => boolean,
) {
  const fila = new Map<string, FilaDetalhe>();
  const lidas: string[] = [];
  const desistidas: string[] = [];
  const tamanhos: number[] = [];
  const tentativasDe = new Map<string, number>();
  let entradas = 0;
  for (let t = 0; t < ciclos; t++) {
    for (const id of chegadas(t)) {
      if (!fila.has(id)) {
        fila.set(id, { ulbra_conversa_id: id, ulbra_cliente_id: `k${id}`, na_lista_em: minuto(t), tentativas: 0 });
        entradas++;
      }
    }
    const sel = selecionarDetalhes([...fila.values()], K);
    for (const d of sel.desistidas) {
      fila.delete(d.ulbra_conversa_id);
      desistidas.push(d.ulbra_conversa_id);
    }
    for (const f of sel.escolhidas) {
      const n = (tentativasDe.get(f.ulbra_conversa_id) ?? 0) + 1;
      tentativasDe.set(f.ulbra_conversa_id, n);
      if (falha(f.ulbra_conversa_id, n)) {
        fila.set(f.ulbra_conversa_id, { ...f, tentativas: f.tentativas + 1 });
      } else {
        fila.delete(f.ulbra_conversa_id);
        lidas.push(f.ulbra_conversa_id);
      }
    }
    tamanhos.push(fila.size);
  }
  return { lidas, desistidas, tamanhos, entradas, restante: fila.size, maxFila: Math.max(0, ...tamanhos) };
}

const SEM_FALHA = () => false;

describe("fila de detalhes: convergência", () => {
  it("chegada ≤ K: cada conversa é lida uma vez e a fila esvazia", () => {
    const r = simular(72, (t) => (t < 30 ? [`c${t}`] : []), 1, SEM_FALHA);
    expect(r.lidas.length).toBe(30);
    expect(new Set(r.lidas).size).toBe(30);
    expect(r.restante).toBe(0);
    expect(r.maxFila).toBeLessThanOrEqual(1);
  });

  it("chegada MAIOR que K: a fila cresce sem limite. Por isso K precisa cobrir a chegada", () => {
    // 2 novas conversas por ciclo contra K=1: não converge. A condição é
    // chegada média ≤ K; o teste documenta o lado que quebra.
    const r = simular(72, (t) => [`a${t}`, `b${t}`], 1, SEM_FALHA);
    expect(r.restante).toBeGreaterThan(50);
    expect(r.tamanhos[71]).toBeGreaterThan(r.tamanhos[35]);
  });

  it("dedupe: a mesma conversa chegando todo ciclo ocupa UMA posição na fila", () => {
    const r = simular(10, () => ["mesma"], 0, SEM_FALHA);
    expect(r.maxFila).toBe(1);
  });

  it("ordem: a conversa mais antiga é lida primeiro", () => {
    const fila: FilaDetalhe[] = [
      { ulbra_conversa_id: "nova", ulbra_cliente_id: "k", na_lista_em: minuto(50), tentativas: 0 },
      { ulbra_conversa_id: "velha", ulbra_cliente_id: "k", na_lista_em: minuto(10), tentativas: 0 },
    ];
    expect(selecionarDetalhes(fila, 1).escolhidas[0].ulbra_conversa_id).toBe("velha");
  });
});

describe("fila de detalhes: falha e retomada", () => {
  it("falhas intermitentes: nenhuma conversa se perde nem é lida duas vezes", () => {
    // Cada conversa falha na primeira tentativa, sucede na segunda.
    const chegadas = (t: number) => (t < 40 ? [`c${t}`] : []);
    const r = simular(120, chegadas, 1, (_id, tentativa) => tentativa === 1);
    expect(new Set(r.lidas).size).toBe(40);
    expect(r.lidas.length).toBe(40);
    expect(r.desistidas.length).toBe(0);
    expect(r.restante).toBe(0);
  });

  it("falha persistente desiste após o máximo de tentativas, e não volta", () => {
    const r = simular(20, (t) => (t === 0 ? ["ruim"] : []), 1, () => true);
    expect(r.desistidas).toEqual(["ruim"]);
    expect(r.lidas).not.toContain("ruim");
    expect(r.restante).toBe(0);
    expect(DETALHE_TENTATIVAS_MAX).toBeGreaterThan(1);
  });

  it("conservação: cada entrada na fila acaba lida, desistida ou ainda pendente, sem sobra", () => {
    // Uma conversa lida pode voltar quando ganha mensagem nova: é uma nova entrada.
    const r = simular(60, (t) => [`c${t % 15}`], 1, (_id, n) => n % 3 === 0);
    expect(r.entradas).toBe(r.lidas.length + r.desistidas.length + r.restante);
  });
});

describe("candidatas da colheita", () => {
  it("só entram conversas com última mensagem que não é do cliente", () => {
    const cands = candidatasDaColheita([
      { ulbra_conversa_id: "a", ulbra_cliente_id: "k", cliente_nome: null, canal: "whatsapp", situacao: "active",
        equipe: "Reativa", responsavel_ulbra: null, ultima_mensagem_em: minuto(5), ultima_mensagem_quem: "operador",
        ultima_mensagem_previa: null, ultima_mensagem_cliente_em: null, precisa_detalhe: true },
      { ulbra_conversa_id: "b", ulbra_cliente_id: "k", cliente_nome: null, canal: "whatsapp", situacao: "active",
        equipe: "Reativa", responsavel_ulbra: null, ultima_mensagem_em: minuto(6), ultima_mensagem_quem: "cliente",
        ultima_mensagem_previa: null, ultima_mensagem_cliente_em: minuto(6), precisa_detalhe: false },
    ]);
    expect(cands.map((c) => c.ulbra_conversa_id)).toEqual(["a"]);
  });
});

describe("orçamento: 12 horas e 24 horas (consumo estimado, por ciclo de 10 min)", () => {
  // Conta explícita. Consumo ESTIMADO, não limite: o limite é o portão por chamada.
  const MARGEM = 0.15;
  const RESERVA_FICHAS_12H = 30;
  const conta = (ciclos: number, atendimentos: number, K: number, fichas: number) => {
    const base = ciclos + atendimentos + ciclos * K; // listar + atendimentos + detalhe
    return { base, total: Math.ceil(base * (1 + MARGEM)) + fichas };
  };

  it("12 horas (72 ciclos), K=1: cabe em 250 (metade do teto)", () => {
    const c = conta(72, 24, 1, RESERVA_FICHAS_12H);
    expect(c.base).toBe(168);
    expect(c.total).toBe(Math.ceil(168 * 1.15) + 30); // 194 + 30 = 224
    expect(c.total).toBeLessThanOrEqual(250);
  });

  it("12 horas, K=2: NAO cabe em 250. Por isso K=1", () => {
    const c = conta(72, 24, 2, RESERVA_FICHAS_12H);
    expect(c.total).toBeGreaterThan(250);
  });

  it("24 horas (144 ciclos), K=1: cabe no teto controlado de sync (440)", () => {
    const c = conta(144, 48, 1, 60);
    expect(c.total).toBeLessThanOrEqual(TETO_DIARIO_SYNC + 60);
    expect(TETO_DIARIO_SYNC).toBe(440);
  });

  it("24 horas, K=2: o teto controlado CORTA antes do fim do dia", () => {
    const c = conta(144, 48, 2, 0);
    expect(c.base).toBe(480);
    expect(c.total).toBeGreaterThan(TETO_DIARIO_SYNC);
  });
});

describe("portão de orçamento: limite controlado por chamada", () => {
  it("sem saldo no meio da paginação, para e marca INCOMPLETO sem fingir página vazia", async () => {
    const lista = Array.from({ length: 200 }, (_, i) => ({ id: `r${i}`, em: minuto(100 + i) }));
    const api = async (p: number) => {
      const o = [...lista].sort((a, b) => (a.em < b.em ? 1 : -1));
      const f = o.slice((p - 1) * 50, p * 50);
      return {
        conversas: f.map((i) => ({ id: i.id, equipe: "Reativa", cliente: { id: `k${i.id}` },
          ultimaMensagemEm: i.em, ultimaMensagem: { quem: "cliente", em: i.em } })),
        paginacao: { total: lista.length },
      };
    };
    const orc = new Orcamento(2); // saldo para só 2 leituras
    let lidas = 0;
    const janela: Janela = { cursor: null, pendente: null, topo: null };
    const c = await colherConversas(async (p) => { orc.gastar(); lidas++; return api(p); }, janela,
      { maxPaginas: 3, hardLeituras: 12, pode: () => orc.pode() });
    expect(lidas).toBe(2);
    expect(c.leituras).toBe(2);
    expect(c.truncado).toBe(true);
  });

  it("Orcamento nunca fica negativo", () => {
    const o = new Orcamento(1);
    o.gastar(); o.gastar(); o.gastar();
    expect(o.saldo).toBe(0);
    expect(o.pode()).toBe(false);
  });
});
