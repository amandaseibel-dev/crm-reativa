// Interrupção no meio da coleta: a janela e a posição guardadas NÃO mudam, e a
// retomada coleta exatamente o que faltava: sem perda e sem repetição.
import { describe, it, expect } from "vitest";
import { colherConversas, novaJanela, type Janela } from "./sincronizar.ts";

const minuto = (n: number) =>
  `2026-11-08T${Math.floor(n / 60).toString().padStart(2, "0")}:${(n % 60).toString().padStart(2, "0")}:00.000Z`;

function apiDe(lista: Array<{ id: string; em: string }>, falhaNaLeitura: number | null = null) {
  let leituras = 0;
  return async (pagina: number) => {
    leituras++;
    if (falhaNaLeitura !== null && leituras === falhaNaLeitura) throw new Error("ULBRA_HTTP_503");
    const o = [...lista].sort((a, b) => (a.em < b.em ? 1 : a.em > b.em ? -1 : 0));
    const f = o.slice((pagina - 1) * 50, pagina * 50);
    return {
      conversas: f.map((i) => ({
        id: i.id, equipe: "Reativa", cliente: { id: `k${i.id}`, nome: i.id },
        ultimaMensagemEm: i.em, ultimaMensagem: { quem: "cliente", em: i.em },
      })),
      paginacao: { total: lista.length },
    };
  };
}

describe("interrupção e retomada da coleta", () => {
  it("falha no meio: janela e posição não mudam; a retomada completa sem perda nem repetição", async () => {
    const lista = Array.from({ length: 400 }, (_, i) => ({ id: `r${i}`, em: minuto(100 + i) }));
    const J0: Janela = { cursor: null, pendente: null, topo: null };

    // Ciclo 1: concluído até o teto. Guarda janela e posição, como a função faz.
    const c1 = await colherConversas(apiDe(lista), J0, { maxPaginas: 2, hardLeituras: 12 });
    expect(c1.truncado).toBe(true);
    const J1 = novaJanela(J0, c1);
    const pos1 = c1.offset_pendente;
    expect(pos1).not.toBeNull();

    // Ciclo 2: cai no meio. Nada é gravado; quem chama mantém J1 e pos1.
    await expect(
      colherConversas(apiDe(lista, 2), J1, { maxPaginas: 2, hardLeituras: 12, posicao: { offset: pos1! } }),
    ).rejects.toThrow("ULBRA_HTTP_503");

    // Retomada: a MESMA janela e posição, ciclo após ciclo, até fechar o backlog.
    const coletados: string[] = c1.conversas.map((c) => c.ulbra_conversa_id);
    let janela = J1;
    let posicao: number | null = pos1;
    for (let i = 0; i < 50; i++) {
      const c = await colherConversas(apiDe(lista), janela, {
        maxPaginas: 2, hardLeituras: 12, posicao: posicao !== null ? { offset: posicao } : undefined,
      });
      coletados.push(...c.conversas.map((x) => x.ulbra_conversa_id));
      janela = novaJanela(janela, c);
      posicao = c.offset_pendente;
      if (!c.truncado) break;
    }
    expect(new Set(coletados).size).toBe(400);
    expect(coletados.length).toBe(400);
  });

  it("ciclo que cai antes de qualquer leitura não altera nada: a janela segue a mesma", async () => {
    const lista = Array.from({ length: 10 }, (_, i) => ({ id: `q${i}`, em: minuto(100 + i) }));
    const J: Janela = { cursor: minuto(50), pendente: null, topo: null };
    await expect(colherConversas(apiDe(lista, 1), J, { maxPaginas: 2 })).rejects.toThrow();
    expect(J).toEqual({ cursor: minuto(50), pendente: null, topo: null });
  });
});
