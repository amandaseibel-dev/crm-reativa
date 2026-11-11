// Revisão da coleta: paginação, retomada, backlog e orçamento.
// Cada teste aqui reproduz um defeito encontrado na leitura do código de
// sincronizar.ts antes da correção. Nenhum chama a Mensageria: a lista é
// simulada em memória, ordenada como a API ordena (mais nova primeiro).
import { describe, it, expect } from "vitest";
import {
  CADENCIA_PADRAO,
  LIMITE_PAGINA,
  RESERVA_FICHAS_DIA,
  TETO_DIARIO_SYNC,
  colherConversas,
  custoDiarioEstimado,
  modoDoCiclo,
  novaJanela,
  type Janela,
} from "./sincronizar.ts";

const J0: Janela = { cursor: null, pendente: null, topo: null };

type Item = { id: string; em: string; quem: string };

function minuto(n: number): string {
  const h = Math.floor(n / 60).toString().padStart(2, "0");
  const m = (n % 60).toString().padStart(2, "0");
  return `2026-11-08T${h}:${m}:00.000Z`;
}

function apiSimulada(lista: Item[]) {
  return async (pagina: number) => {
    const ordenada = [...lista].sort((a, b) => (a.em < b.em ? 1 : a.em > b.em ? -1 : 0));
    const inicio = (pagina - 1) * LIMITE_PAGINA;
    const fatia = ordenada.slice(inicio, inicio + LIMITE_PAGINA);
    return {
      conversas: fatia.map((i) => ({
        id: i.id,
        canal: "whatsapp",
        situacao: "active",
        equipe: "Reativa",
        cliente: { id: `k${i.id}`, nome: i.id },
        ultimaMensagemEm: i.em,
        ultimaMensagem: { quem: i.quem, em: i.em, trecho: "x" },
      })),
      paginacao: { total: lista.length },
    };
  };
}

async function ciclo(lista: Item[], janela: Janela, maxPaginas = 3, hardLeituras = 12) {
  const api = apiSimulada(lista);
  const colheita = await colherConversas(api, janela, { maxPaginas, hardLeituras });
  return { colheita, proxima: novaJanela(janela, colheita) };
}

/** Roda ciclos até um completo; devolve ids coletados, ciclos e a última colheita. */
async function ateCompleto(lista: Item[], janela0: Janela, maxPaginas = 3, hardLeituras = 12, limite = 60) {
  let janela = janela0;
  const coletados: string[] = [];
  for (let i = 0; i < limite; i++) {
    const { colheita, proxima } = await ciclo(lista, janela, maxPaginas, hardLeituras);
    for (const c of colheita.conversas) coletados.push(c.ulbra_conversa_id);
    janela = proxima;
    if (!colheita.truncado) return { coletados, ciclos: i + 1, janela, completo: true };
  }
  return { coletados, ciclos: limite, janela, completo: false };
}

describe("defeito 1: exaurir o teto de leituras não pode fingir ciclo completo", () => {
  it("600 itens já processados à frente de 10 não processados: o ciclo sai INCOMPLETO e guarda o piso", async () => {
    // Janela: cursor antigo, pendente em 100, topo em 900. Os 600 itens entre
    // pendente e topo já foram processados e não geram coleta; 12 páginas
    // cheias de nada esgotam HARD_LEITURAS antes de alcançar os 10 de baixo.
    const lista: Item[] = [];
    for (let i = 0; i < 600; i++) lista.push({ id: `p${i}`, em: minuto(100 + i), quem: "cliente" });
    for (let i = 0; i < 10; i++) lista.push({ id: `b${i}`, em: minuto(50 + i), quem: "cliente" });
    const janela: Janela = { cursor: minuto(0), pendente: minuto(100), topo: minuto(700) };
    const { colheita, proxima } = await ciclo(lista, janela);
    expect(colheita.truncado).toBe(true);
    expect(proxima.cursor).toBe(minuto(0));
    expect(proxima.pendente).not.toBeNull();
  });

  it("ciclo que para por falta de página, sem teto atingido, não declara fim da janela", async () => {
    // Página única cheia sem nada novo a coletar, com mais páginas ainda:
    // o laço termina por HARD_LEITURAS, e isso é INCOMPLETO, nunca OK.
    const lista: Item[] = [];
    for (let i = 0; i < 700; i++) lista.push({ id: `x${i}`, em: minuto(10 + i), quem: "cliente" });
    const janela: Janela = { cursor: minuto(0), pendente: minuto(10), topo: minuto(709) };
    const { colheita } = await ciclo(lista, janela, 3, 2);
    expect(colheita.truncado).toBe(true);
  });
});

describe("defeito 2: grupo com o mesmo horário que atravessa mais de uma página não pode ser perdido", () => {
  it("empate de 99 que cruza três páginas, com teto de 1 página por ciclo: nenhum item fica de fora", async () => {
    const lista: Item[] = [];
    // 49 itens distintos mais novos + 1 item no horário T (página 1)
    for (let i = 0; i < 49; i++) lista.push({ id: `n${i}`, em: minuto(600 + i), quem: "cliente" });
    for (let i = 0; i < 99; i++) lista.push({ id: `t${i}`, em: minuto(500), quem: "cliente" });
    const r = await ateCompleto(lista, J0, 1, 12);
    expect(r.completo).toBe(true);
    const unicos = new Set(r.coletados);
    for (let i = 0; i < 99; i++) expect(unicos.has(`t${i}`)).toBe(true);
    for (let i = 0; i < 49; i++) expect(unicos.has(`n${i}`)).toBe(true);
  });
});

describe("modo do ciclo: backlog e incremental são distintos", () => {
  it("cold start e janela com pendente são BACKLOG; janela fechada é INCREMENTAL", () => {
    expect(modoDoCiclo(J0)).toBe("BACKLOG");
    expect(modoDoCiclo({ cursor: minuto(5), pendente: minuto(3), topo: minuto(9) })).toBe("BACKLOG");
    expect(modoDoCiclo({ cursor: minuto(9), pendente: null, topo: minuto(9) })).toBe("INCREMENTAL");
  });
});

describe("orçamento: o custo estimado inclui o que a função realmente chama", () => {
  // Composição medida no código: listar_conversas (1 por ciclo), ler_conversa
  // (1 por ciclo, K=DETALHE_POR_CICLO), listar_atendimentos (a cada 30 min),
  // meu_acesso (1 por hora, cache de 60 min).
  it("10 minutos: 144 + 144 + 48 + 24 = 360 de base, 414 com margem, cabe no teto de sync", () => {
    const c = custoDiarioEstimado(CADENCIA_PADRAO);
    expect(c).toMatchObject({ conversas: 144, detalhes: 144, atendimentos: 48, saldo: 24, base: 360, margem: 54, total: 414 });
    expect(c.total).toBeLessThanOrEqual(TETO_DIARIO_SYNC);
    expect(c.cabe).toBe(true);
  });

  it("5 minutos: não cabe com leitura de detalhe em todo ciclo", () => {
    const c = custoDiarioEstimado({ ...CADENCIA_PADRAO, cadencia_conversas_min: 5 });
    expect(c.total).toBeGreaterThan(TETO_DIARIO_SYNC);
    expect(c.cabe).toBe(false);
  });

  it("15 minutos: cabe com folga", () => {
    const c = custoDiarioEstimado({ ...CADENCIA_PADRAO, cadencia_conversas_min: 15 });
    expect(c).toMatchObject({ conversas: 96, detalhes: 96, base: 264, total: 304 });
    expect(c.cabe).toBe(true);
  });

  it("30 minutos: cabe com bastante folga", () => {
    const c = custoDiarioEstimado({ ...CADENCIA_PADRAO, cadencia_conversas_min: 30 });
    expect(c).toMatchObject({ conversas: 48, detalhes: 48, base: 168, total: 194 });
    expect(c.cabe).toBe(true);
  });

  it("fichas acima da reserva não cabem, mesmo com a sincronização dentro do teto", () => {
    const c = custoDiarioEstimado({ ...CADENCIA_PADRAO, fichas_por_dia: RESERVA_FICHAS_DIA + 1 });
    expect(c.cabe).toBe(false);
  });
});

describe("backlog grande: nunca termina OK com itens por coletar", () => {
  it("1000 conversas, teto de 3 páginas e 12 leituras: ou esvazia por completo, ou o último ciclo sai INCOMPLETO", async () => {
    const lista: Item[] = [];
    for (let i = 0; i < 1000; i++) lista.push({ id: `g${i}`, em: minuto(i), quem: "cliente" });
    const r = await ateCompleto(lista, J0, 3, 12, 40);
    if (r.completo) {
      expect(new Set(r.coletados).size).toBe(1000);
    } else {
      // Ainda há backlog: a janela guardada tem pendente, e nada foi dado como visto.
      expect(r.janela.pendente).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Propriedade: num ciclo COMPLETO, nada se perde, com empates e mensagens que
// se repetem no horário. Medida contra o código original: esta mesma verificação
// acusou perda em 1 de 1 execução de origin/main (100 de 192 coletados).
// ---------------------------------------------------------------------------
function rng(seed: number) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

describe("propriedade: ciclo completo nunca perde item, com empates e tetos variados", () => {
  it("400 combinações aleatórias: todo ciclo completo coleta exatamente a lista inteira", async () => {
    for (let seed = 1; seed <= 400; seed++) {
      const r = rng(seed);
      const n = 1 + Math.floor(r() * 260);
      const faixa = 1 + Math.floor(r() * 40); // faixa pequena gera empates de horário
      const lista: Item[] = [];
      for (let i = 0; i < n; i++) {
        lista.push({ id: `c${i}`, em: minuto(Math.floor(r() * faixa)), quem: r() < 0.5 ? "cliente" : "operador" });
      }
      const maxP = 1 + Math.floor(r() * 3);
      const hard = 2 + Math.floor(r() * 12);
      let janela: Janela = J0;
      const todos: string[] = [];
      let ultimo: { truncado: boolean } = { truncado: true };
      for (let c = 0; c < 80; c++) {
        const { colheita, proxima } = await ciclo(lista, janela, maxP, hard);
        todos.push(...colheita.conversas.map((x) => x.ulbra_conversa_id));
        janela = proxima;
        ultimo = colheita;
        if (!colheita.truncado) break;
      }
      if (!ultimo.truncado) {
        expect(new Set(todos).size, `seed ${seed}`).toBe(n);
      }
    }
  });
});

describe("limite conhecido: backlog grande não drena com 12 leituras por ciclo", () => {
  it("1000 pendentes: o backlog para com INCOMPLETO visível, nunca OK com itens de fora", async () => {
    const lista: Item[] = [];
    for (let i = 0; i < 1000; i++) lista.push({ id: `g${i}`, em: minuto(i), quem: "cliente" });
    let janela: Janela = J0;
    let ultimo: { truncado: boolean } = { truncado: true };
    for (let c = 0; c < 30; c++) {
      const { colheita, proxima } = await ciclo(lista, janela, 3, 12);
      janela = proxima;
      ultimo = colheita;
    }
    // Sem o deslocamento persistido, cada ciclo relê o trecho já processado e
    // para. Continua INCOMPLETO e com pendente guardado: nada é dado como fim.
    expect(ultimo.truncado).toBe(true);
    expect(janela.pendente).not.toBeNull();
  });
});
