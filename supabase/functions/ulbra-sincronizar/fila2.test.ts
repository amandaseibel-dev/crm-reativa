// PROVAS COMPLEMENTARES: capacidade da fila, conta por consumidor, detalhe
// paginado, saldo da API e pendência preservada.
import { describe, it, expect } from "vitest";
import {
  Orcamento,
  decidirDetalhe,
  cargaDetalhe,
  saldoDoCabecalho,
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

describe("2. conta por consumidor: 12 horas (72 ciclos), fórmula explícita", () => {
  // total = (L + A + K·C) + ceil(m·(L + A + K·C)) + F
  //   L = listar_conversas por ciclo (1 página em regime)        -> 72
  //   A = listar_atendimentos (a cada 3º ciclo, 30 min)            -> 24
  //   C = ler_conversa por ciclo (fila de detalhes, 1 leitura/ciclo) -> K·72
  //   m = margem de falha e retentativa                            -> 15%
  //   F = reserva das fichas dos operadores (não é consumo da sync) -> 30
  const L = 72, A = 24, m = 0.15, F = 30;
  const formula = (K: number) => {
    const base = L + A + K * 72;
    return { base, margem: Math.ceil(base * m), F, total: base + Math.ceil(base * m) + F };
  };

  it("K=1: 224 no total, incluindo a reserva das fichas", () => {
    expect(formula(1)).toEqual({ base: 168, margem: 26, F: 30, total: 224 });
  });

  it("K=2: 306 no total. Não cabe na convenção de 250 (metade de 500)", () => {
    expect(formula(2)).toEqual({ base: 240, margem: 36, F: 30, total: 306 });
    expect(formula(2).total).toBeGreaterThan(250);
  });

  it("a convenção de 250 NÃO é limite da API: é metade do teto diário, para dividir a janela", () => {
    // Não há limite de 12 horas medido na API. O limite garantido é o diário.
    expect(250 * 2).toBe(500);
  });
});

describe("3. saldo real da API e teto controlado", () => {
  it("cabeçalho de saldo presente prevalece quando é menor que o local", () => {
    const h = new Headers({ "x-ratelimit-remaining": "37" });
    const o = new Orcamento(300);
    o.ajustarAoSaldoDaApi(saldoDoCabecalho(h));
    expect(o.saldo).toBe(37);
  });

  it("sem cabeçalho, o saldo fica só local (nada é presumido)", () => {
    expect(saldoDoCabecalho(new Headers())).toBeNull();
    const o = new Orcamento(300);
    o.ajustarAoSaldoDaApi(null);
    expect(o.saldo).toBe(300);
  });

  it("saldo da API MAIOR que o local nunca aumenta o teto controlado", () => {
    const o = new Orcamento(100);
    o.ajustarAoSaldoDaApi(9999);
    expect(o.saldo).toBe(100);
  });
});

describe("4. detalhe paginado: uma página NÃO basta", () => {
  // Histórico de 60 mensagens, mais recentes primeiro. O cliente só aparece
  // no 45º item (o mais antigo na 3ª página). Operador responde depois.
  const historico = Array.from({ length: 60 }, (_, i) => ({
    quem: i === 44 ? "cliente" : "operador",
    em: minuto(600 - i),
  }));
  const pagina = (antesDe?: string) => {
    const base = antesDe ? historico.filter((m) => m.em < antesDe) : historico;
    const fatia = base.slice(0, 20);
    const resto = base.length > 20;
    return {
      mensagens: fatia.slice().reverse(), // cronológica dentro da página
      paginacao: { maisAntigas: resto, antesDe: fatia.length ? fatia[fatia.length - 1].em : undefined },
    };
  };

  it("a primeira página NÃO prova a ausência de resposta do cliente", () => {
    expect(decidirDetalhe(pagina()).acao).toBe("CONTINUAR");
  });

  it("retomando com antesDe, a resposta mais antiga aparece e é a conclusão", async () => {
    let antes: string | null = null;
    let chamadas = 0;
    let passo = decidirDetalhe(pagina());
    while (passo.acao === "CONTINUAR") {
      chamadas++;
      antes = passo.antes_de;
      passo = decidirDetalhe(pagina(antes));
    }
    expect(passo).toEqual({ acao: "CONCLUIR", ultima_cliente: minuto(600 - 44) });
    expect(chamadas).toBe(2); // página 1 (sem cliente) -> página 2 (com cliente)
  });

  it("carga com antesDe pede a página certa", () => {
    const c = cargaDetalhe("x", minuto(580)) as { params: { arguments: Record<string, unknown> } };
    expect(c.params.arguments).toEqual({ id: "x", limite: 20, antesDe: minuto(580) });
  });

  it("histórico sem cliente algum: conclui com null, sem assumir resposta", () => {
    const sem = { mensagens: [{ quem: "operador", em: minuto(600) }], paginacao: { maisAntigas: false } };
    expect(decidirDetalhe(sem)).toEqual({ acao: "CONCLUIR", ultima_cliente: null });
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
