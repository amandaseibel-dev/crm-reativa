// O BUG DO FUSO. `datetime-local` fala hora LOCAL; `toISOString()` devolve UTC.
// Em Brasília (UTC-3) isso empurrava o campo 3 horas para a frente — e, à
// noite, mudava o DIA, que é justamente o que ordena as remessas.
import { describe, it, expect } from "vitest";
import { agoraLocalParaInput } from "./preventivoFormato";

describe("data inicial do campo de extração", () => {
  it("devolve a hora LOCAL, não a UTC", () => {
    // 21:30 local — em UTC-3 isso é 00:30 do dia seguinte em UTC
    const d = new Date(2026, 9, 6, 21, 30, 0);
    expect(agoraLocalParaInput(d)).toBe("2026-10-06T21:30");
  });

  it("não vira o dia à noite", () => {
    const d = new Date(2026, 9, 6, 23, 59, 0);
    const local = agoraLocalParaInput(d);
    expect(local.slice(0, 10)).toBe("2026-10-06");
    // é exatamente onde o toISOString errava em UTC-3
    if (d.getTimezoneOffset() > 0) {
      expect(d.toISOString().slice(0, 10)).not.toBe(local.slice(0, 10));
    }
  });

  it("preenche com zero à esquerda", () => {
    expect(agoraLocalParaInput(new Date(2026, 0, 2, 3, 4, 0))).toBe("2026-01-02T03:04");
  });

  it("o valor volta ao instante certo quando reconvertido", () => {
    const d = new Date(2026, 9, 6, 21, 30, 0);
    expect(new Date(agoraLocalParaInput(d)).getTime()).toBe(d.getTime());
  });
});
