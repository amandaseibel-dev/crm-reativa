import { describe, it, expect } from "vitest";
import {
  chaveSilenciados,
  horaAgoraLocal,
  horaChegou,
  minutosDeAtraso,
  normalizarHora,
  retornoParaAvisar,
  somarMinutos,
} from "./alarmeRetorno";

const HOJE = "2026-10-15";
const r = (o) => ({ id: "a1", nome: "Aluna Um", telefone: "51999990000", data: HOJE, hora_retorno: "14:30", valor_em_aberto: 1200, tratado: false, ...o });

describe("hora", () => {
  it("normaliza o que o input time e o banco devolvem", () => {
    expect(normalizarHora("9:05")).toBe("09:05");
    expect(normalizarHora("14:30:00")).toBe("14:30");
    expect(normalizarHora("")).toBe("");
    expect(normalizarHora(null)).toBe("");
    expect(normalizarHora("meio-dia")).toBe("");
  });

  it("horaAgoraLocal usa o relogio de quem olha, nao UTC", () => {
    const d = new Date(2026, 9, 15, 7, 5); // 07:05 local
    expect(horaAgoraLocal(d)).toBe("07:05");
  });

  it("a hora chega quando o relogio alcanca o combinado", () => {
    expect(horaChegou("14:30", "14:29")).toBe(false);
    expect(horaChegou("14:30", "14:30")).toBe(true);
    expect(horaChegou("14:30", "15:00")).toBe(true);
    expect(horaChegou("", "15:00")).toBe(false);
  });

  it("somar minutos nao vira o dia", () => {
    expect(somarMinutos("14:30", 10)).toBe("14:40");
    expect(somarMinutos("09:55", 10)).toBe("10:05");
    expect(somarMinutos("23:50", 30)).toBe("23:59");
  });

  it("atraso em minutos, nunca negativo", () => {
    expect(minutosDeAtraso("14:30", "14:42")).toBe(12);
    expect(minutosDeAtraso("14:30", "14:00")).toBe(0);
  });

  it("a memoria do navegador e por dia", () => {
    expect(chaveSilenciados(HOJE)).toBe("rv-retorno-silenciado-2026-10-15");
    expect(chaveSilenciados("2026-10-16")).not.toBe(chaveSilenciados(HOJE));
  });
});

describe("qual retorno avisar", () => {
  const ctx = (o) => ({ hoje: HOJE, horaAgora: "14:35", silenciados: new Map(), ...o });

  it("avisa o retorno de hoje cuja hora ja chegou", () => {
    expect(retornoParaAvisar([r()], ctx())?.id).toBe("a1");
  });

  it("nao avisa antes da hora, nem o de outro dia, nem o ja tratado", () => {
    expect(retornoParaAvisar([r({ hora_retorno: "16:00" })], ctx())).toBeNull();
    expect(retornoParaAvisar([r({ data: "2026-10-16" })], ctx())).toBeNull();
    expect(retornoParaAvisar([r({ tratado: true })], ctx())).toBeNull();
  });

  it("retorno sem hora nunca toca -- a gestao manteve a hora opcional", () => {
    expect(retornoParaAvisar([r({ hora_retorno: "" })], ctx())).toBeNull();
    expect(retornoParaAvisar([r({ hora_retorno: null })], ctx())).toBeNull();
  });

  it("um de cada vez, o mais atrasado primeiro", () => {
    const lista = [r({ id: "tarde", hora_retorno: "14:30" }), r({ id: "cedo", hora_retorno: "09:00" })];
    expect(retornoParaAvisar(lista, ctx())?.id).toBe("cedo");
  });

  it("'abri a ficha' / 'ja falei' calam o aviso pelo resto do dia", () => {
    const silenciados = new Map([["a1", ""]]);
    expect(retornoParaAvisar([r()], ctx({ silenciados }))).toBeNull();
  });

  it("'lembrar em 10 min' volta quando a hora nova chega, nao antes", () => {
    const silenciados = new Map([["a1", "14:45"]]);
    expect(retornoParaAvisar([r()], ctx({ horaAgora: "14:40", silenciados }))).toBeNull();
    expect(retornoParaAvisar([r()], ctx({ horaAgora: "14:45", silenciados }))?.id).toBe("a1");
  });

  it("o silenciado nao esconde o retorno de outro aluno", () => {
    const silenciados = new Map([["a1", ""]]);
    const lista = [r(), r({ id: "a2", nome: "Aluna Dois", hora_retorno: "14:00" })];
    expect(retornoParaAvisar(lista, ctx({ silenciados }))?.id).toBe("a2");
  });

  it("sem hoje ou sem relogio valido nao inventa aviso", () => {
    expect(retornoParaAvisar([r()], ctx({ hoje: "" }))).toBeNull();
    expect(retornoParaAvisar([r()], ctx({ horaAgora: "" }))).toBeNull();
    expect(retornoParaAvisar(null, ctx())).toBeNull();
  });
});
