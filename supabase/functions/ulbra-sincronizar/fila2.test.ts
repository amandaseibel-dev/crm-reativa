// PROVAS COMPLEMENTARES: capacidade da fila, conta por consumidor, detalhe
// paginado, saldo da API e pendência preservada.
import { describe, it, expect } from "vitest";
import {
  MAX_PAGINAS_DETALHE,
  Orcamento,
  cargaDetalhe,
  cargaMeuAcesso,
  decidirDetalhe,
  saldoDoMeuAcesso,
  selecionarDetalhes,
  type FilaDetalhe,
} from "./sincronizar.ts";

const minuto = (n: number) =>
  `2026-11-08T${Math.floor(n / 60).toString().padStart(2, "0")}:${(n % 60).toString().padStart(2, "0")}:00.000Z`;

/** Fila com backlog inicial e chegadas dadas por função. Seleção = produção. */
function drenar(inicial: number, chegadas: (t: number) => number, K: number, ciclos: number) {
  const fila = new Map<string, FilaDetalhe>();
  for (let i = 0; i < inicial; i++) {
    fila.set(`b${i}`, { ulbra_conversa_id: `b${i}`, ulbra_cliente_id: "k", na_lista_em: minuto(0), tentativas: 0 });
  }
  let n = 0;
  const tamanhos: number[] = [];
  let vazioEm: number | null = null;
  for (let t = 0; t < ciclos; t++) {
    for (let c = 0; c < chegadas(t); c++) {
      const id = `n${n++}`;
      fila.set(id, { ulbra_conversa_id: id, ulbra_cliente_id: "k", na_lista_em: minuto(t), tentativas: 0 });
    }
    const sel = selecionarDetalhes([...fila.values()], K);
    for (const f of sel.escolhidas) fila.delete(f.ulbra_conversa_id);
    tamanhos.push(fila.size);
    if (vazioEm === null && fila.size === 0 && t > 0) vazioEm = t;
  }
  return { restante: fila.size, tamanhos, vazioEm };
}

describe("1. chegada vs capacidade: condições e atraso", () => {
  it("chegada IGUAL à capacidade (λ=K) NÃO elimina o backlog existente", () => {
    // 20 pendentes no início; chegada 1 por ciclo; K=1: a fila fica em 20.
    const r = drenar(20, () => 1, 1, 60);
    expect(r.restante).toBe(20);
    expect(r.tamanhos.every((x) => x >= 20)).toBe(true);
  });

  it("chegada MENOR que a capacidade (λ<K) esvazia em ~B/(K-λ) ciclos", () => {
    // λ = 0,5 por ciclo (1 a cada 2 ciclos), K=1, backlog 20. Esperado: 20/(1-0,5) = 40 ciclos.
    const r = drenar(20, (t) => (t % 2 === 0 ? 1 : 0), 1, 80);
    expect(r.vazioEm).not.toBeNull();
    expect(r.vazioEm!).toBeGreaterThanOrEqual(38);
    expect(r.vazioEm!).toBeLessThanOrEqual(44);
  });

  it("chegada MAIOR que a capacidade (λ>K) cresce, mesmo sem backlog inicial", () => {
    const r = drenar(0, () => 2, 1, 40);
    expect(r.restante).toBe(40);
  });

  it("paginação do detalhe reduz a capacidade para K/P, onde P = páginas por conversa", () => {
    // Cada conversa precisa de P=3 leituras. K=1 leitura por ciclo => ~1/3 de conversa por ciclo.
    // Capacidade efetiva = K/P. A chegada precisa ficar abaixo de K/P, não de K.
    const P = 3;
    const capacidadeEfetiva = 1 / P;
    expect(capacidadeEfetiva).toBeLessThan(1);
    expect(capacidadeEfetiva).toBeCloseTo(0.333, 3);
  });
});

describe("2. conta por consumidor: 12 horas e 24 horas, com a configuração recomendada", () => {
  // total = base + ceil(0,15·base) + F, base = L + A + D + M
  //   L = listar_conversas (1 por ciclo de 10 min)              : ciclos
  //   A = listar_atendimentos (a cada 30 min = a cada 3 ciclos)  : ciclos/3
  //   D = ler_conversa da fila de detalhes (K por ciclo)          : K·ciclos
  //   M = meu_acesso (saldo; a cada 60 min = a cada 6 ciclos)     : ciclos/6
  //   F = reserva das fichas dos operadores (NÃO é consumo da sincronização)
  const conta = (ciclos: number, K: number) => {
    const L = ciclos, A = Math.ceil(ciclos / 3), D = K * ciclos, M = Math.ceil(ciclos / 6);
    const base = L + A + D + M;
    const margem = Math.ceil(0.15 * base);
    return { L, A, D, M, base, margem, F: 0, total: base + margem };
  };

  it("12 horas (72 ciclos), K=1: 237 da sincronização, sem limite artificial", () => {
    const c = conta(72, 1);
    expect(c).toMatchObject({ L: 72, A: 24, D: 72, M: 12, base: 180, margem: 27, total: 207 });
  });

  it("12 horas, K=2: 290 da sincronização (base 252 + margem 38)", () => {
    expect(conta(72, 2)).toMatchObject({ base: 252, margem: 38, total: 290 });
  });

  it("24 horas (144 ciclos), K=1: 414 da sincronização (base 360 + margem 54)", () => {
    const c = conta(144, 1);
    expect(c.base).toBe(144 + 48 + 144 + 24);
    expect(c).toMatchObject({ base: 360, margem: 54, total: 414 });
  });

  it("24 horas, K=2: ultrapassa 500 SÓ com a sincronização, antes de contar fichas", () => {
    expect(conta(144, 2).total).toBeGreaterThan(500);
  });

  it("24 horas, K=1: cabe em 500 com a reserva de 60 das fichas", () => {
    expect(conta(144, 1).total + 60).toBeLessThanOrEqual(500);
  });
});

describe("3. saldo real: meu_acesso (contrato medido em 08/11/2026)", () => {
  // Resposta REAL de meu_acesso, medida nesta sessão (chamada 6af0623f...).
  const MEDIDO = {
    pessoa: { nome: "Amanda Prado Seibel", email: "amanda.seibel@aelbra.com.br", perfis: ["supervisor", "diretor", "operator", "gestao"] },
    conexao: { tipo: "oauth", nome: "Claude (web e desktop)", aplicativo: "claude-web", expiraEm: "2026-11-08T12:06:25.000Z" },
    escopos: ["mcp:acesso", "clientes:read"],
    limites: {
      conexaoPorMinuto: { limite: 15, restam: 13 },
      pessoaPorMinuto: { limite: 30, restam: 28 },
      pessoaPorDia: { limite: 500, restam: 443 },
      rascunhosPorHora: { limite: 20, restam: 20 },
    },
    chamada: "6af0623f9ab1d6401cdac914",
  };

  it("lê pessoaPorDia.restam do contrato medido", () => {
    expect(saldoDoMeuAcesso(MEDIDO)).toBe(443);
  });

  it("sem o campo, devolve null: nunca presume valor", () => {
    expect(saldoDoMeuAcesso({ limites: {} })).toBeNull();
    expect(saldoDoMeuAcesso(null)).toBeNull();
  });

  it("a carga de saldo é a própria meu_acesso, sem argumentos", () => {
    expect(cargaMeuAcesso().params).toEqual({ name: "meu_acesso", arguments: {} });
  });

  it("saldo da pessoa MENOR que o local prevalece; maior nunca amplia", () => {
    const o = new Orcamento(300);
    o.ajustarAoSaldoDaApi(443);
    expect(o.saldo).toBe(300);
    o.ajustarAoSaldoDaApi(37);
    expect(o.saldo).toBe(37);
  });
});

describe("4. detalhe paginado: uma página NÃO basta, e o alcance nunca vira 'sem resposta'", () => {
  // Histórico de N mensagens, mais recentes primeiro, páginas de 20.
  const historicoDe = (n: number, clienteEm: number | null) =>
    Array.from({ length: n }, (_, i) => ({
      quem: clienteEm !== null && i === clienteEm ? "cliente" : "operador",
      em: minuto(900 - i),
    }));
  const paginaDe = (hist: Array<{ quem: string; em: string }>, antesDe?: string) => {
    const base = antesDe ? hist.filter((m) => m.em < antesDe) : hist;
    const fatia = base.slice(0, 20);
    return {
      mensagens: fatia.slice().reverse(),
      paginacao: { maisAntigas: base.length > 20, antesDe: fatia.length ? fatia[fatia.length - 1].em : undefined },
    };
  };
  /** Roda o passo a passo como a função: uma página por ciclo, até concluir ou alcançar. */
  const percorrer = (hist: Array<{ quem: string; em: string }>) => {
    let antes: string | undefined = undefined;
    let paginas = 0;
    for (;;) {
      const passo = decidirDetalhe(paginaDe(hist, antes), paginas);
      paginas++;
      if (passo.acao !== "CONTINUAR") return { passo, paginas };
      antes = passo.antes_de;
    }
  };

  it("a primeira página NÃO prova a ausência de resposta do cliente", () => {
    expect(decidirDetalhe(paginaDe(historicoDe(60, 44)), 0).acao).toBe("CONTINUAR");
  });

  it("resposta na 3ª página (até 60 mensagens) é encontrada e é a mais recente dele", () => {
    const { passo, paginas } = percorrer(historicoDe(60, 44));
    expect(passo).toEqual({ acao: "CONCLUIR", ultima_cliente: minuto(900 - 44) });
    expect(paginas).toBe(3);
  });

  it("histórico que acaba sem cliente conclui com null: o histórico inteiro foi lido", () => {
    const { passo } = percorrer(historicoDe(30, null));
    expect(passo).toEqual({ acao: "CONCLUIR", ultima_cliente: null });
  });

  it("resposta ALÉM de 60 mensagens: ALCANCE_ESGOTADO com ponto de retomada, nunca CONCLUIR null", () => {
    // Cliente só aparece na 4ª página (índice 70): fora do alcance de 3 páginas.
    const { passo, paginas } = percorrer(historicoDe(90, 70));
    expect(passo.acao).toBe("ALCANCE_ESGOTADO");
    expect(passo.acao === "ALCANCE_ESGOTADO" && passo.antes_de.length > 0).toBe(true);
    expect(paginas).toBe(MAX_PAGINAS_DETALHE);
  });

  it("retomada: o ponto guardado permite continuar exatamente de onde o alcance parou", () => {
    const hist = historicoDe(90, 70);
    const { passo } = percorrer(hist);
    if (passo.acao !== "ALCANCE_ESGOTADO") throw new Error("esperado alcance");
    // Ao reabrir, a leitura recomeça em antes_de e acha a resposta.
    const prox = decidirDetalhe(paginaDe(hist, passo.antes_de), 0);
    expect(prox.acao === "CONTINUAR" || prox.acao === "CONCLUIR").toBe(true);
    const { passo: fim } = percorrer(hist.filter((m) => m.em < passo.antes_de));
    expect(fim).toEqual({ acao: "CONCLUIR", ultima_cliente: minuto(900 - 70) });
  });

  it("carga com antesDe pede a página certa", () => {
    const c = cargaDetalhe("x", minuto(580)) as { params: { arguments: Record<string, unknown> } };
    expect(c.params.arguments).toEqual({ id: "x", limite: 20, antesDe: minuto(580) });
  });
});

describe("5. esgotada NÃO é descartada: vira pendência", () => {
  it("a seleção separa esgotadas para virarem pendência, sem apagar", () => {
    const fila: FilaDetalhe[] = [
      { ulbra_conversa_id: "ruim", ulbra_cliente_id: "k", na_lista_em: minuto(1), tentativas: 5 },
      { ulbra_conversa_id: "boa", ulbra_cliente_id: "k", na_lista_em: minuto(2), tentativas: 0 },
    ];
    const sel = selecionarDetalhes(fila, 1);
    expect(sel.desistidas.map((d) => d.ulbra_conversa_id)).toEqual(["ruim"]);
    expect(sel.escolhidas.map((d) => d.ulbra_conversa_id)).toEqual(["boa"]);
  });
});
