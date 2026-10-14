// O rodízio das Quebras de Objeção, testado como MATEMÁTICA e não como aparência.
//
// As quatro exigências da gestão (08/10/2026) viram quatro propriedades que têm
// de valer para QUALQUER catálogo, não só para os 35 de hoje — por isso cada
// caso roda numa faixa de tamanhos. Se amanhã alguém acrescentar uma objeção, o
// rodízio continua correto ou a suíte quebra.
import { describe, it, expect } from "vitest";
import { indiceDaObjecao, passoCoprimo, diaDoCalendario } from "./tvRodizioObjecao";

const TAMANHOS = [1, 2, 3, 4, 5, 6, 7, 10, 12, 20, 35, 36, 49, 50, 100];
const DIA = new Date(2026, 9, 8); // 08/10/2026, meio-dia local não importa

const mdc = (a, b) => (b ? mdc(b, a % b) : a);

describe("passo do rodízio", () => {
  it("é sempre coprimo com o total — é isso que faz passar por todas", () => {
    for (const n of TAMANHOS.filter((x) => x > 2)) {
      expect(mdc(passoCoprimo(n), n)).toBe(1);
    }
  });

  it("fica dentro do catálogo e nunca é zero", () => {
    for (const n of TAMANHOS) {
      const p = passoCoprimo(n);
      expect(p).toBeGreaterThanOrEqual(1);
      expect(p).toBeLessThan(Math.max(2, n));
    }
  });

  it("com as 35 objeções de hoje, o salto é largo — não anda de um em um", () => {
    expect(passoCoprimo(35)).toBe(22);
  });
});

describe("1) não repete a mesma objeção em voltas consecutivas", () => {
  it("vale em todo tamanho com mais de uma objeção", () => {
    for (const n of TAMANHOS.filter((x) => x > 1)) {
      for (let g = 0; g < n * 2; g++) {
        expect(indiceDaObjecao(g, n, DIA)).not.toBe(indiceDaObjecao(g + 1, n, DIA));
      }
    }
  });
});

describe("2) distribui ao longo dos ciclos, em vez de andar para a vizinha", () => {
  it("com 35, voltas seguidas ficam longe uma da outra", () => {
    // Distância circular mínima entre voltas consecutivas. Com passo 22 em 35,
    // o salto é 22 para frente ou 13 para trás — bem longe da vizinha.
    for (let g = 0; g < 35; g++) {
      const a = indiceDaObjecao(g, 35, DIA);
      const b = indiceDaObjecao(g + 1, 35, DIA);
      const d = Math.min(Math.abs(a - b), 35 - Math.abs(a - b));
      expect(d).toBeGreaterThan(5);
    }
  });
});

describe("3) não fica presa nas primeiras — todas entram no ar", () => {
  it("uma volta completa cobre o catálogo inteiro, sem repetir", () => {
    for (const n of TAMANHOS) {
      const vistos = new Set();
      for (let g = 0; g < n; g++) vistos.add(indiceDaObjecao(g, n, DIA));
      expect(vistos.size).toBe(n);
    }
  });

  it("as últimas do catálogo aparecem tão cedo quanto as primeiras", () => {
    // O defeito antigo era OBJECOES[giro % total]: a objeção 34 só entrava na
    // 35ª volta, que o telão quase nunca alcançava antes de ser recarregado.
    const quando = (alvo) => {
      for (let g = 0; g < 35; g++) if (indiceDaObjecao(g, 35, DIA) === alvo) return g;
      return -1;
    };
    expect(quando(34)).toBeGreaterThanOrEqual(0);
    expect(quando(34)).toBeLessThan(35);
    // A média de espera é a mesma para todas: é uma permutação, não uma fila.
    const esperas = Array.from({ length: 35 }, (_, i) => quando(i));
    expect(Math.max(...esperas)).toBe(34);
    expect(new Set(esperas).size).toBe(35);
  });
});

describe("4) o dia seguinte não recomeça na mesma objeção", () => {
  it("a primeira objeção do dia muda a cada dia, por 35 dias seguidos", () => {
    const primeiras = [];
    for (let d = 0; d < 35; d++) {
      primeiras.push(indiceDaObjecao(0, 35, new Date(2026, 9, 8 + d)));
    }
    // Nenhuma repetição em 35 dias: o ciclo de aberturas também é completo.
    expect(new Set(primeiras).size).toBe(35);
    // E dois dias seguidos nunca abrem igual.
    for (let i = 0; i < primeiras.length - 1; i++) {
      expect(primeiras[i]).not.toBe(primeiras[i + 1]);
    }
  });

  it("recarregar a página no MESMO dia não volta para a objeção de ontem", () => {
    // O contador do carrossel vive em useState(0) e zera em toda recarga. O que
    // garante variedade dentro do dia é a volta; o que garante variedade entre
    // dias é a data. Aqui: mesma data, mesmo giro => mesma objeção (estável).
    const a = indiceDaObjecao(0, 35, new Date(2026, 9, 8));
    const b = indiceDaObjecao(0, 35, new Date(2026, 9, 8));
    expect(a).toBe(b);
    // E no dia seguinte, outra.
    expect(indiceDaObjecao(0, 35, new Date(2026, 9, 9))).not.toBe(a);
  });
});

describe("bordas", () => {
  it("catálogo vazio não estoura", () => {
    expect(indiceDaObjecao(5, 0, DIA)).toBe(0);
    expect(indiceDaObjecao(5, -3, DIA)).toBe(0);
  });

  it("catálogo de uma objeção só devolve sempre ela", () => {
    for (let g = 0; g < 5; g++) expect(indiceDaObjecao(g, 1, DIA)).toBe(0);
  });

  it("giro sujo não quebra e nunca sai da faixa", () => {
    for (const g of [null, undefined, NaN, "7", -4, 3.9, Infinity]) {
      const r = indiceDaObjecao(g, 35, DIA);
      expect(Number.isInteger(r)).toBe(true);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(35);
    }
  });

  it("data inválida cai no relógio real em vez de devolver NaN", () => {
    const r = indiceDaObjecao(0, 35, new Date("não é data"));
    expect(Number.isInteger(r)).toBe(true);
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThan(35);
  });

  it("o dia é o mesmo número a qualquer hora da mesma data", () => {
    const manha = diaDoCalendario(new Date(2026, 9, 8, 6, 0, 0));
    const noite = diaDoCalendario(new Date(2026, 9, 8, 23, 59, 59));
    expect(manha).toBe(noite);
    expect(diaDoCalendario(new Date(2026, 9, 9, 0, 0, 1))).toBe(manha + 1);
  });
});
