import { describe, it, expect } from "vitest";
import { esperaDesde, linkWhatsApp } from "./whatsapp";

const MIN = 60 * 1000;
const HORA = 60 * MIN;
const DIA = 24 * HORA;
const atras = (ms) => new Date(Date.now() - ms).toISOString();
const daqui = (ms) => new Date(Date.now() + ms).toISOString();

describe("esperaDesde — quanto tempo a pessoa está sem resposta", () => {
  it("conta em minutos na primeira hora", () => {
    expect(esperaDesde(atras(20 * MIN)).texto).toBe("20min");
  });

  it("conta em horas depois de 1h", () => {
    expect(esperaDesde(atras(3 * HORA)).texto).toBe("3h");
  });

  it("conta em dias depois de 24h", () => {
    expect(esperaDesde(atras(2 * DIA)).texto).toBe("2d");
  });

  it("escala a urgencia: calmo -> atencao -> critico", () => {
    expect(esperaDesde(atras(10 * MIN)).nivel).toBe("calmo");
    expect(esperaDesde(atras(2 * HORA)).nivel).toBe("atencao");
    expect(esperaDesde(atras(30 * HORA)).nivel).toBe("critico");
  });

  it("1h e 24h sao os limites exatos", () => {
    expect(esperaDesde(atras(HORA + 1000)).nivel).toBe("atencao");
    expect(esperaDesde(atras(DIA + 1000)).nivel).toBe("critico");
  });

  it("sem data nao inventa espera", () => {
    expect(esperaDesde(null)).toBeNull();
    expect(esperaDesde(undefined)).toBeNull();
  });

  it("data no futuro nao vira espera negativa", () => {
    expect(esperaDesde(daqui(HORA))).toBeNull();
  });
});

// A JANELA DE 24H NAO EXISTE MAIS. Ela era regra de tarifacao da Cloud API da
// Meta: fora dela so passava modelo aprovado, que e cobrado. No caminho por QR
// Code nao ha template, nao ha custo por conversa e nao ha prazo para
// responder. Os testes de `tempoRestanteJanela` sairam junto com a funcao.
//
// O que passou a travar o campo de resposta e outra coisa, e e testado na tela:
// o NUMERO estar fora do ar, ou a conversa estar finalizada.

describe("linkWhatsApp", () => {
  it("monta o link no numero certo", () => {
    expect(linkWhatsApp("5551999998888")).toBe("https://wa.me/5551999998888");
  });

  it("limpa mascara", () => {
    expect(linkWhatsApp("+55 (51) 99999-8888")).toBe("https://wa.me/5551999998888");
  });

  it("sem telefone nao gera link quebrado", () => {
    expect(linkWhatsApp("")).toBeNull();
    expect(linkWhatsApp(null)).toBeNull();
  });
});
