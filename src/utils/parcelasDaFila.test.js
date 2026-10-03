// A fila de baixas era o TERCEIRO ponto que criava parcela com 'A_VENCER'
// fixo. Ali os vencimentos nascem em hoje e para a frente, mas o operador
// edita cada data na mao antes de salvar -- entao o retroativo entra por
// digitacao, e a parcela nascia "a vencer" ate o cron das 03:05.
import { describe, it, expect } from "vitest";
import { montarParcelasDaFila } from "./parcelasDaFila";
import { hojeISO } from "./statusParcela";

// Datas montadas a partir do dia LOCAL, igual a hojeISO(), para o teste valer
// nesta maquina (BRT) e no CI (UTC).
const diaRelativo = (n) => {
  const [a, m, d] = hojeISO().split("-").map(Number);
  const x = new Date(a, m - 1, d + n);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
};
const ONTEM = diaRelativo(-1);
const HOJE = diaRelativo(0);
const AMANHA = diaRelativo(1);

const montar = (parcelas) => montarParcelasDaFila({
  acordoId: "acordo-1", parcelas, email: "operador@aelbra.com.br",
  agoraISO: "2026-09-29T12:00:00.000Z",
});

describe("parcelas do acordo registrado pela fila de baixas", () => {
  // A primeira linha e o pagamento que acabou de ser baixado.
  it("a primeira parcela continua PAGA, com data e autor", () => {
    const [p] = montar([{ valor: 100, vencimento: ONTEM }]);
    expect(p.status).toBe("PAGO");
    expect(p.pago_em).toBe("2026-09-29T12:00:00.000Z");
    expect(p.confirmado_por_email).toBe("operador@aelbra.com.br");
    expect(p.numero).toBe(1);
  });

  it("a primeira parcela segue PAGA mesmo com vencimento futuro", () => {
    const [p] = montar([{ valor: 100, vencimento: AMANHA }]);
    expect(p.status).toBe("PAGO");
  });

  it("parcela nao paga vencida ontem nasce VENCIDA", () => {
    const linhas = montar([{ valor: 100, vencimento: HOJE }, { valor: 100, vencimento: ONTEM }]);
    expect(linhas[1].status).toBe("VENCIDA");
    expect(linhas[1].pago_em).toBeNull();
    expect(linhas[1].confirmado_por_email).toBeNull();
  });

  // A FRONTEIRA: vencimento hoje ainda nao venceu.
  it("parcela nao paga vencendo hoje nasce A_VENCER", () => {
    const linhas = montar([{ valor: 100, vencimento: HOJE }, { valor: 100, vencimento: HOJE }]);
    expect(linhas[1].status).toBe("A_VENCER");
  });

  it("parcela futura nasce A_VENCER", () => {
    const linhas = montar([{ valor: 100, vencimento: HOJE }, { valor: 100, vencimento: diaRelativo(90) }]);
    expect(linhas[1].status).toBe("A_VENCER");
  });

  // O motivo de a decisao morar no insert, e nao na geracao das linhas: o
  // operador digita a data depois de a tela montar o parcelamento.
  it("usa o vencimento FINAL, ja editado antes de salvar", () => {
    const geradasNaTela = [{ valor: 100, vencimento: HOJE }, { valor: 100, vencimento: diaRelativo(30) }];
    const editadasPeloOperador = geradasNaTela.map((p, i) => (i === 1 ? { ...p, vencimento: ONTEM } : p));
    expect(montar(geradasNaTela)[1].status).toBe("A_VENCER");
    expect(montar(editadasPeloOperador)[1].status).toBe("VENCIDA");
  });

  it("status terminal que ja venha na linha nao e sobrescrito pela data", () => {
    const linhas = montar([
      { valor: 100, vencimento: HOJE },
      { valor: 100, vencimento: ONTEM, status: "CANCELADA" },
      { valor: 100, vencimento: ONTEM, status: "RENEGOCIADA" },
      { valor: 100, vencimento: AMANHA, status: "PAGO" },
    ]);
    expect(linhas.map((l) => l.status)).toEqual(["PAGO", "CANCELADA", "RENEGOCIADA", "PAGO"]);
  });

  it("sem vencimento nao inventa VENCIDA", () => {
    const linhas = montar([{ valor: 100, vencimento: HOJE }, { valor: 100, vencimento: null }]);
    expect(linhas[1].status).toBe("A_VENCER");
    expect(linhas[1].vencimento).toBeNull();
  });

  it("numeracao e valor seguem como antes", () => {
    const linhas = montar([{ valor: "150,00", vencimento: HOJE }, { valor: 200, vencimento: AMANHA }]);
    expect(linhas.map((l) => l.numero)).toEqual([1, 2]);
    expect(linhas[1].valor).toBe(200);
    expect(linhas[0].acordo_id).toBe("acordo-1");
  });

  it("lista vazia nao quebra", () => {
    expect(montarParcelasDaFila({ acordoId: "x", parcelas: [], email: "", agoraISO: "" })).toEqual([]);
  });
});
