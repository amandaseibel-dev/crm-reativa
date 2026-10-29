// O QUE ESTE ARQUIVO PROTEGE: retomar nunca pode virar "começar de novo".
//
// A regressão que ele impede é exatamente a que aconteceu em produção: o
// ponteiro do ciclo se perdia e o clique seguinte mandava `carteira_id`, que é
// o corpo que faz a Edge Function ABRIR ciclo novo e re-enfileirar quem já
// tinha sido consultado.
import { describe, it, expect } from "vitest";
import { rodarSincronizacao, VOLTAS_MAXIMAS } from "./sincronizacao";

// Dublê da Edge Function: guarda os corpos recebidos e responde o que mandarem.
function espiao(respostas) {
  const corpos = [];
  const fila = [...respostas];
  const invocar = async (body) => {
    corpos.push(body);
    return fila.shift() ?? { data: { concluido: true } };
  };
  return { invocar, corpos };
}

describe("retomada da sincronização com o Prime", () => {
  it("RETOMAR manda o sinc_id já na primeira chamada e nunca abre ciclo novo", async () => {
    const { invocar, corpos } = espiao([
      { data: { sinc_id: "c-1", concluido: false, faltam: 300 } },
      { data: { sinc_id: "c-1", concluido: true, faltam: 0 } },
    ]);

    const r = await rodarSincronizacao(invocar, { carteiraId: "cart-1", sincId: "c-1" });

    expect(corpos[0]).toEqual({ sinc_id: "c-1" });
    // nenhuma chamada pode carregar o corpo que abre ciclo novo
    expect(corpos.some((c) => "carteira_id" in c || "origem" in c)).toBe(false);
    expect(corpos.every((c) => c.sinc_id === "c-1")).toBe(true);
    expect(r).toEqual({ sincId: "c-1", concluido: true, voltas: 2 });
  });

  it("sem sinc_id, a primeira chamada abre o ciclo e as seguintes o reaproveitam", async () => {
    const { invocar, corpos } = espiao([
      { data: { sinc_id: "novo-9", concluido: false } },
      { data: { sinc_id: "novo-9", concluido: false } },
      { data: { sinc_id: "novo-9", concluido: true } },
    ]);

    const r = await rodarSincronizacao(invocar, { carteiraId: "cart-1" });

    expect(corpos[0]).toEqual({ carteira_id: "cart-1", origem: "manual" });
    expect(corpos[1]).toEqual({ sinc_id: "novo-9" });
    expect(corpos[2]).toEqual({ sinc_id: "novo-9" });
    expect(r.sincId).toBe("novo-9");
    expect(r.concluido).toBe(true);
  });

  it("para assim que a Edge Function diz que concluiu", async () => {
    const { invocar, corpos } = espiao([{ data: { sinc_id: "c-1", concluido: true } }]);
    const r = await rodarSincronizacao(invocar, { carteiraId: "x", sincId: "c-1" });
    expect(corpos).toHaveLength(1);
    expect(r.voltas).toBe(1);
  });

  it("não roda para sempre: respeita o teto de voltas e não mente que concluiu", async () => {
    const nunca = Array.from({ length: 10 }, () => ({ data: { sinc_id: "c-1", concluido: false } }));
    const { invocar, corpos } = espiao(nunca);
    const r = await rodarSincronizacao(invocar, { carteiraId: "x", sincId: "c-1", voltasMaximas: 5 });
    expect(corpos).toHaveLength(5);
    expect(r.concluido).toBe(false);
    expect(r.sincId).toBe("c-1");   // o ponteiro volta, para poder continuar depois
  });

  it("o teto padrão é 40 voltas", () => {
    expect(VOLTAS_MAXIMAS).toBe(40);
  });

  it("erro da Edge Function sobe e não apaga o ponteiro do ciclo", async () => {
    const invocar = async () => ({ error: new Error("limite da API") });
    await expect(
      rodarSincronizacao(invocar, { carteiraId: "x", sincId: "c-1" })
    ).rejects.toThrow("limite da API");
  });

  it("resposta sem sinc_id não zera o ciclo que estava em mãos", async () => {
    const { invocar, corpos } = espiao([
      { data: { concluido: false } },                 // veio sem sinc_id
      { data: { sinc_id: "c-1", concluido: true } },
    ]);
    const r = await rodarSincronizacao(invocar, { carteiraId: "x", sincId: "c-1" });
    expect(corpos[1]).toEqual({ sinc_id: "c-1" });    // continuou no mesmo
    expect(r.sincId).toBe("c-1");
  });
});
