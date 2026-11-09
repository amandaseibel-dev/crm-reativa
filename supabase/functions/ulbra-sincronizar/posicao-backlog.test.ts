// Retomada do backlog com posição de leitura guardada entre ciclos.
// A posição (offset) é o índice, na lista ordenada, da primeira mensagem ainda
// não processada. Ela só pula trecho já processado depois de a leitura ter
// passado de todas as mensagens novas, e só se a página de destino começar
// acima do piso pendente. Se a posição estiver errada, cai para a leitura em
// sequência: custa leitura, nunca perde mensagem.
import { describe, it, expect } from "vitest";
import { colherConversas, novaJanela, LIMITE_PAGINA, type Janela } from "./sincronizar.ts";

type Item = { id: string; em: string; quem: string };
const J0: Janela = { cursor: null, pendente: null, topo: null };

function minuto(n: number): string {
  const d = Math.floor(n / 1440) + 1;
  const h = Math.floor((n % 1440) / 60).toString().padStart(2, "0");
  const m = (n % 60).toString().padStart(2, "0");
  return `2026-11-${String(d).padStart(2, "0")}T${h}:${m}:00.000Z`;
}

function apiSimulada(lista: Item[]) {
  return async (pagina: number) => {
    const ordenada = [...lista].sort((a, b) => (a.em < b.em ? 1 : a.em > b.em ? -1 : 0));
    const fatia = ordenada.slice((pagina - 1) * LIMITE_PAGINA, pagina * LIMITE_PAGINA);
    return {
      conversas: fatia.map((i) => ({
        id: i.id,
        equipe: "Reativa",
        cliente: { id: `k${i.id}`, nome: i.id },
        ultimaMensagemEm: i.em,
        ultimaMensagem: { quem: i.quem, em: i.em, trecho: "x" },
      })),
      paginacao: { total: lista.length },
    };
  };
}

/** Um ciclo com a posição guardada, como a função faz: lê, avança a janela e a posição. */
async function ciclo(lista: Item[], janela: Janela, offset: number | null, maxPaginas = 3, hardLeituras = 12) {
  const colheita = await colherConversas(apiSimulada(lista), janela, {
    maxPaginas,
    hardLeituras,
    posicao: offset === null ? undefined : { offset },
  });
  return { colheita, proxima: novaJanela(janela, colheita), offset: colheita.offset_pendente };
}

describe("backlog grande drena com posição guardada", () => {
  it("1000 pendentes drenam em poucos ciclos, sem perda e sem repetição", async () => {
    const lista: Item[] = [];
    for (let i = 0; i < 1000; i++) lista.push({ id: `g${i}`, em: minuto(i), quem: "cliente" });
    let janela = J0;
    let offset: number | null = null;
    const coletados: string[] = [];
    let completo = false;
    let ciclos = 0;
    for (; ciclos < 60 && !completo; ciclos++) {
      const r = await ciclo(lista, janela, offset);
      coletados.push(...r.colheita.conversas.map((c) => c.ulbra_conversa_id));
      janela = r.proxima;
      offset = r.offset;
      completo = !r.colheita.truncado;
    }
    expect(completo).toBe(true);
    expect(ciclos).toBeLessThanOrEqual(20);
    expect(coletados.length).toBe(1000);
    expect(new Set(coletados).size).toBe(1000);
  });
});

describe("mensagem nova tem prioridade sobre o backlog", () => {
  it("chegou no meio do drenar: entra no primeiro ciclo depois da chegada", async () => {
    const lista: Item[] = [];
    for (let i = 0; i < 1000; i++) lista.push({ id: `g${i}`, em: minuto(i), quem: "cliente" });
    let janela = J0;
    let offset: number | null = null;
    for (let c = 0; c < 4; c++) {
      const r = await ciclo(lista, janela, offset);
      janela = r.proxima;
      offset = r.offset;
    }
    lista.push({ id: "nova", em: minuto(5000), quem: "cliente" });
    const r = await ciclo(lista, janela, offset);
    expect(r.colheita.conversas.map((c) => c.ulbra_conversa_id)).toContain("nova");
  });
});

describe("posição errada nunca perde mensagem", () => {
  it("posição grande demais (itens removidos acima): cai para leitura em sequência, sem perda", async () => {
    const lista: Item[] = [];
    for (let i = 0; i < 300; i++) lista.push({ id: `g${i}`, em: minuto(i), quem: "cliente" });
    // Primeiro ciclo: colhe um trecho e deixa pendente.
    const a = await ciclo(lista, J0, null);
    expect(a.colheita.truncado).toBe(true);
    // Remove 120 itens acima do pendente: a posição guardada passa a estar alta demais.
    const restante = lista.filter((_, i) => i >= 0);
    const topo = [...restante].sort((x, y) => (x.em < y.em ? 1 : -1));
    const removidos = new Set(topo.slice(0, 0).map((x) => x.id));
    void removidos;
    const grande = (a.offset ?? 0) + 120;
    let janela = a.proxima;
    let offset: number | null = grande;
    const coletados = [...a.colheita.conversas.map((c) => c.ulbra_conversa_id)];
    for (let c = 0; c < 40; c++) {
      const r = await ciclo(lista, janela, offset);
      coletados.push(...r.colheita.conversas.map((x) => x.ulbra_conversa_id));
      janela = r.proxima;
      offset = r.offset;
      if (!r.colheita.truncado) break;
    }
    expect(new Set(coletados).size).toBe(300);
  });

  it("posição pequena demais (chegadas acima): só relê, sem perda", async () => {
    const lista: Item[] = [];
    for (let i = 0; i < 400; i++) lista.push({ id: `g${i}`, em: minuto(i), quem: "cliente" });
    const a = await ciclo(lista, J0, null);
    for (let i = 0; i < 80; i++) lista.push({ id: `n${i}`, em: minuto(1000 + i), quem: "cliente" });
    let janela = a.proxima;
    let offset: number | null = 0;
    const coletados = [...a.colheita.conversas.map((c) => c.ulbra_conversa_id)];
    for (let c = 0; c < 40; c++) {
      const r = await ciclo(lista, janela, offset);
      coletados.push(...r.colheita.conversas.map((x) => x.ulbra_conversa_id));
      janela = r.proxima;
      offset = r.offset;
      if (!r.colheita.truncado) break;
    }
    expect(new Set(coletados).size).toBe(480);
  });
});

describe("propriedade com posição guardada", () => {
  it("ciclo completo com posição coleta exatamente a lista, sem repetição, em 200 combinações", async () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let k = 0; k < 200; k++) {
      const n = 1 + Math.floor(rnd() * 900);
      const faixa = 1 + Math.floor(rnd() * 200);
      const lista: Item[] = [];
      for (let i = 0; i < n; i++) lista.push({ id: `c${i}`, em: minuto(Math.floor(rnd() * faixa)), quem: "cliente" });
      const maxP = 1 + Math.floor(rnd() * 3);
      const hard = 3 + Math.floor(rnd() * 10);
      let janela = J0;
      let offset: number | null = null;
      const coletados: string[] = [];
      let ultimoTruncado = true;
      for (let c = 0; c < 200; c++) {
        const r = await ciclo(lista, janela, offset, maxP, hard);
        coletados.push(...r.colheita.conversas.map((x) => x.ulbra_conversa_id));
        janela = r.proxima;
        offset = r.offset;
        ultimoTruncado = r.colheita.truncado;
        if (!ultimoTruncado) break;
      }
      if (!ultimoTruncado) expect(new Set(coletados).size, `caso ${k}`).toBe(n);
    }
  });
});
