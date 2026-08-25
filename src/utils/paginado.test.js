import { describe, it, expect } from "vitest";
import { buscarTudo, TETO_API } from "./paginado";

// Simula a API: devolve no maximo `pagina` linhas por chamada, como o teto de
// 1000 faz em producao, e registra as faixas pedidas.
function apiFalsa(totalDeLinhas, { pagina = TETO_API } = {}) {
  const chamadas = [];
  const todas = Array.from({ length: totalDeLinhas }, (_, i) => ({ id: i + 1 }));
  const montarQuery = (de, ate) => {
    chamadas.push([de, ate]);
    const fatia = todas.slice(de, Math.min(ate + 1, de + pagina));
    return Promise.resolve({ data: fatia, error: null });
  };
  return { montarQuery, chamadas };
}

describe("buscarTudo", () => {
  it("traz tudo quando existe mais do que cabe numa requisicao", async () => {
    // O caso que motivou isto: 2.258 pagamentos em aberto chegavam como 1.000.
    const { montarQuery, chamadas } = apiFalsa(2258);
    const linhas = await buscarTudo(montarQuery);

    expect(linhas).toHaveLength(2258);
    expect(chamadas).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  it("para na primeira pagina quando o resultado cabe nela", async () => {
    const { montarQuery, chamadas } = apiFalsa(42);
    const linhas = await buscarTudo(montarQuery);

    expect(linhas).toHaveLength(42);
    expect(chamadas).toHaveLength(1);
  });

  it("nao pede pagina a mais quando o total e multiplo exato do teto", async () => {
    // Pagina cheia nao prova que acabou: tem que pedir a seguinte e receber vazia.
    const { montarQuery, chamadas } = apiFalsa(2000);
    const linhas = await buscarTudo(montarQuery);

    expect(linhas).toHaveLength(2000);
    expect(chamadas).toHaveLength(3);
    expect(chamadas[2]).toEqual([2000, 2999]);
  });

  it("devolve lista vazia quando nao ha nada", async () => {
    const { montarQuery } = apiFalsa(0);
    expect(await buscarTudo(montarQuery)).toEqual([]);
  });

  it("propaga o erro do banco em vez de devolver resultado parcial", async () => {
    // Resultado parcial silencioso e justamente o bug que isto existe para matar.
    let chamada = 0;
    const montarQuery = () => {
      chamada += 1;
      if (chamada === 2) return Promise.resolve({ data: null, error: { message: "timeout" } });
      return Promise.resolve({ data: Array.from({ length: TETO_API }, (_, i) => ({ id: i })), error: null });
    };

    await expect(buscarTudo(montarQuery)).rejects.toMatchObject({ message: "timeout" });
  });

  it("respeita o limite de seguranca para nao virar laco infinito", async () => {
    const { montarQuery } = apiFalsa(10000);
    const linhas = await buscarTudo(montarQuery, { maximo: 3000 });

    expect(linhas).toHaveLength(3000);
  });

  it("aceita tamanho de pagina menor", async () => {
    const { montarQuery, chamadas } = apiFalsa(250, { pagina: 100 });
    const linhas = await buscarTudo(montarQuery, { pagina: 100 });

    expect(linhas).toHaveLength(250);
    expect(chamadas).toEqual([[0, 99], [100, 199], [200, 299]]);
  });
});
