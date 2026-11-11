// Coleta por período: `desde` é limite inferior da janela. Nada chama a
// Mensageria; a lista é simulada em memória, ordenada como a API (mais nova
// primeiro), com itens de várias equipes.
import { describe, it, expect } from "vitest";
import {
  DESDE_MAX_DIAS,
  LIMITE_PAGINA,
  antesDoInicio,
  colherConversas,
  lerParametros,
  modoDoCiclo,
  novaJanela,
  type Janela,
} from "./sincronizar.ts";

type Item = { id: string; em: string; quem?: string; equipe?: string };

function dia(d: number, h = 12): string {
  return `2026-11-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:00:00.000Z`;
}
function out(d: number, h = 12): string {
  return `2026-10-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:00:00.000Z`;
}

function apiSimulada(lista: Item[]) {
  const chamadas: number[] = [];
  const buscar = async (pagina: number) => {
    chamadas.push(pagina);
    const ordenada = [...lista].sort((a, b) => (a.em < b.em ? 1 : a.em > b.em ? -1 : 0));
    const fatia = ordenada.slice((pagina - 1) * LIMITE_PAGINA, pagina * LIMITE_PAGINA);
    return {
      conversas: fatia.map((i) => ({
        id: i.id, canal: "whatsapp", situacao: "active", equipe: i.equipe ?? "Reativa",
        cliente: { id: `cli-${i.id}`, nome: i.id },
        ultimaMensagemEm: i.em, ultimaMensagem: { quem: i.quem ?? "cliente", em: i.em, trecho: "..." },
      })),
      paginacao: { total: lista.length },
    };
  };
  return { buscar, chamadas };
}

// 120 itens: 70 de novembro (dias 1..10, 7 por dia) e 50 de outubro (dias 20..29),
// metade de outra equipe para provar o recorte.
function caixa(): Item[] {
  const l: Item[] = [];
  let n = 0;
  for (let d = 10; d >= 1; d--) for (let h = 1; h <= 7; h++) l.push({ id: `n${n++}`, em: dia(d, h), equipe: h % 2 ? "Reativa" : "Outra" });
  for (let d = 29; d >= 20; d--) for (let h = 1; h <= 5; h++) l.push({ id: `o${n++}`, em: out(d, h), equipe: h % 2 ? "Reativa" : "Outra" });
  return l;
}

const DESDE = "2026-11-01T00:00:00.000Z";

describe("antesDoInicio", () => {
  it("sem desde nunca; com desde compara por instante, não por texto", () => {
    expect(antesDoInicio("2026-10-31T23:59:59Z", { cursor: null, pendente: null, topo: null })).toBe(false);
    const j: Janela = { cursor: null, pendente: null, topo: null, desde: DESDE };
    expect(antesDoInicio("2026-10-31T23:59:59.000Z", j)).toBe(true);
    expect(antesDoInicio("2026-11-01T00:00:00.000Z", j)).toBe(false);
    expect(antesDoInicio("2026-10-31T21:00:00-03:00", j)).toBe(false); // = 00:00Z de 01/11
  });
});

describe("coleta por período (desde)", () => {
  it("cold start com desde: lê só até a página em que o piso passa do início e fecha COMPLETO", async () => {
    const api = apiSimulada(caixa());
    const j: Janela = { cursor: null, pendente: null, topo: null, desde: DESDE };
    const c = await colherConversas(api.buscar, j, { maxPaginas: 12, hardLeituras: 12 });
    // 70 itens de novembro = páginas 1 e 2 (a 2ª já tem piso em outubro); só Reativa entra
    expect(api.chamadas).toEqual([1, 2]);
    expect(c.conversas.every((x) => x.ultima_mensagem_em >= DESDE)).toBe(true);
    expect(c.conversas).toHaveLength(40); // 4 de 7 por dia são Reativa (h ímpar) × 10 dias
    expect(c.truncado).toBe(false);
    expect(c.pendente_proximo).toBeNull();
    // o próximo ciclo é INCREMENTAL a partir do topo: o que ficou abaixo não é backlog
    const prox = novaJanela(j, c);
    expect(prox.cursor).toBe(dia(10, 7));
    expect(prox.pendente).toBeNull();
    expect(modoDoCiclo(prox)).toBe("INCREMENTAL");
  });

  it("sem desde, a mesma caixa é backlog: lê tudo que o teto permite e sai INCOMPLETO", async () => {
    const api = apiSimulada(caixa());
    const c = await colherConversas(api.buscar, { cursor: null, pendente: null, topo: null }, { maxPaginas: 1, hardLeituras: 1 });
    expect(c.truncado).toBe(true);
    expect(c.pendente_proximo).not.toBeNull();
  });

  it("teto de leituras no meio de novembro: INCOMPLETO com pendente dentro do período; a retomada com desde termina", async () => {
    // 7 páginas de novembro (350 itens) para forçar o teto de 3 leituras
    const l: Item[] = [];
    let n = 0;
    for (let d = 10; d >= 1; d--) for (let h = 1; h <= 35; h++) l.push({ id: `n${n++}`, em: dia(d, Math.min(h, 23)) });
    for (let d = 29; d >= 20; d--) l.push({ id: `o${n++}`, em: out(d) });
    const api = apiSimulada(l);
    const j: Janela = { cursor: null, pendente: null, topo: null, desde: DESDE };
    const c1 = await colherConversas(api.buscar, j, { maxPaginas: 3, hardLeituras: 3 });
    expect(c1.truncado).toBe(true);
    expect(c1.pendente_proximo! >= DESDE).toBe(true);
    const j2: Janela = { ...novaJanela(j, c1), desde: DESDE };
    expect(modoDoCiclo(j2)).toBe("BACKLOG");
    const api2 = apiSimulada(l);
    const c2 = await colherConversas(api2.buscar, j2, { maxPaginas: 12, hardLeituras: 12, posicao: c1.offset_pendente != null ? { offset: c1.offset_pendente } : undefined });
    expect(c2.truncado).toBe(false);
    const ids = new Set([...c1.conversas, ...c2.conversas].map((x) => x.ulbra_conversa_id));
    expect(ids.size).toBe(350);
    expect([...ids].every((id) => id.startsWith("n"))).toBe(true);
  });

  it("incremental depois do período: só o que está acima do topo, e nada abaixo do início", async () => {
    const l = caixa();
    const j: Janela = { cursor: dia(10, 7), pendente: null, topo: dia(10, 7), desde: DESDE };
    l.push({ id: "novo", em: dia(11, 9) });
    const api = apiSimulada(l);
    const c = await colherConversas(api.buscar, j, { maxPaginas: 3, hardLeituras: 3 });
    expect(c.conversas.map((x) => x.ulbra_conversa_id)).toEqual(["novo"]);
    expect(c.truncado).toBe(false);
    expect(api.chamadas).toEqual([1]);
  });
});

describe("parâmetros da chamada manual", () => {
  const AGORA = Date.parse("2026-11-11T12:00:00Z");
  it("corpo vazio = sem parâmetros; campos válidos são lidos; data pura vira meia-noite de Brasília", () => {
    expect(lerParametros("", AGORA)).toBeNull();
    const p = lerParametros(JSON.stringify({ teto_chamadas: 12, desde: "2026-11-01", detalhes: 5 }), AGORA);
    expect(p).toEqual({ teto_chamadas: 12, teto_total: null, desde: "2026-11-01T03:00:00.000Z", detalhes: 5 });
    expect(lerParametros(JSON.stringify({ desde: "2026-11-01T00:00:00Z" }), AGORA)).toEqual({ teto_chamadas: null, teto_total: null, desde: "2026-11-01T00:00:00.000Z", detalhes: null });
  });
  it("recusa teto fora de 1..12, detalhes fora de 1..20, desde no futuro, antigo demais ou malformado", () => {
    for (const corpo of [
      { teto_chamadas: 13 }, { teto_chamadas: 0 }, { detalhes: 21 }, { detalhes: 0 },
      { desde: "2026-11-12" }, { desde: "2026-01-01" }, { desde: "ontem" }, { desde: 20261101 },
    ]) expect(lerParametros(JSON.stringify(corpo), AGORA)).toBe("INVALIDO");
    expect(lerParametros("{nao é json", AGORA)).toBe("INVALIDO");
    expect(DESDE_MAX_DIAS).toBe(120);
  });
});
