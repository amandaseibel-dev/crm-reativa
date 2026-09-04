import { describe, it, expect } from "vitest";
import {
  etapaDe,
  naTrilha,
  ehDispensado,
  dataEtapa,
  podeDevolverAoOperador,
  ETAPA_LABEL,
  ETAPAS_ASSINATURA,
} from "./termosAssinatura";

describe("termosAssinatura: dispensado e devolução", () => {
  it("DISPENSADO é etapa conhecida, mas fica fora da trilha e da lista de etapas vivas", () => {
    const t = { etapa_assinatura: "DISPENSADO" };
    expect(etapaDe(t)).toBe("DISPENSADO");
    expect(ehDispensado(t)).toBe(true);
    expect(naTrilha(t)).toBe(false);
    expect(ETAPAS_ASSINATURA).not.toContain("DISPENSADO");
    expect(ETAPA_LABEL.DISPENSADO).toBe("Não será assinado");
  });

  it("na trilha: só liberado e não dispensado", () => {
    expect(naTrilha({ etapa_assinatura: "PENDENTE_ENVIO" })).toBe(true);
    expect(naTrilha({ etapa_assinatura: "COMPLETO" })).toBe(true);
    expect(naTrilha({ etapa_assinatura: "NAO_APLICAVEL" })).toBe(false);
    expect(naTrilha({})).toBe(false);
  });

  it("dispensado ordena pela data da dispensa", () => {
    const t = {
      etapa_assinatura: "DISPENSADO",
      dispensado_em: "2026-09-04T12:00:00Z",
      validado_em: "2026-08-01T12:00:00Z",
    };
    expect(dataEtapa(t)).toBe(new Date("2026-09-04T12:00:00Z").getTime());
  });

  it("devolver ao operador: termo liberado (manual ou gov) que não esteja COMPLETO", () => {
    expect(podeDevolverAoOperador({ status: "TERMO_RECEBIDO_LIBERADO", etapa_assinatura: "PENDENTE_ENVIO" })).toBe(true);
    expect(podeDevolverAoOperador({ status: "TERMO_LIBERADO_AUTOMATICO_GOV", etapa_assinatura: "ENVIADO_ASSINATURA" })).toBe(true);
    expect(podeDevolverAoOperador({ status: "TERMO_RECEBIDO_LIBERADO", etapa_assinatura: "DISPENSADO" })).toBe(true);
    expect(podeDevolverAoOperador({ status: "TERMO_RECEBIDO_LIBERADO", etapa_assinatura: "COMPLETO" })).toBe(false);
    expect(podeDevolverAoOperador({ status: "TERMO_ENVIADO_ADM", etapa_assinatura: "NAO_APLICAVEL" })).toBe(false);
    expect(podeDevolverAoOperador({ status: "TERMO_REJEITADO", etapa_assinatura: "NAO_APLICAVEL" })).toBe(false);
  });
});
