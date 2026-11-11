// Garantias do histórico somente leitura, sem rede e sem chamada real.
import { describe, it, expect, beforeEach } from "vitest";
import {
  ALCANCE,
  CACHE_VALIDADE_MS,
  LIMITE_OPERADOR_DIA,
  RESERVA_GLOBAL,
  SALDO_VALIDADE_MS,
  avaliarSaldo,
  autorizarHistorico,
  limparCacheParaTeste,
  lerHistoricoSomenteLeitura,
  type DependenciasHistorico,
  type FotografiaSaldo,
} from "./historico.ts";
import type { ContextoLeitura } from "../ulbra-conversa/leitura.ts";

const AGORA = Date.parse("2026-11-10T12:00:00Z");
const SALDO_FRESCO: FotografiaSaldo = { restam: 300, em: new Date(AGORA - 60_000).toISOString() };
const DONO: ContextoLeitura = { operador: "cobranca10@aelbra.com.br", identidade_confirmada: true, dono_carteira: "cobranca10@aelbra.com.br", responsavel_atendimento: null };
const SO_VE: ContextoLeitura = { operador: "cobranca10@aelbra.com.br", identidade_confirmada: true, dono_carteira: "cobranca05@aelbra.com.br", responsavel_atendimento: null };

function fabrica(over: Partial<DependenciasHistorico> & { usadosOperador?: number; usadosGlobal?: number } = {}) {
  let usadoOp = over.usadosOperador ?? 0;
  let usadoGl = over.usadosGlobal ?? 0;
  const reservas: Array<{ operador: string; tetoOp: number; tetoGl: number }> = [];
  const chamadas: Array<{ id: string; antes: string | null; limite: number }> = [];
  let agora = AGORA;
  const deps: DependenciasHistorico = {
    consultarPermissao: over.consultarPermissao ?? (async () => DONO),
    lerSaldo: over.lerSaldo ?? (async () => SALDO_FRESCO),
    reservar: async (operador, quantidade, tetoOp, tetoGl) => {
      reservas.push({ operador, tetoOp, tetoGl });
      if (usadoOp + quantidade > tetoOp || usadoGl + quantidade > tetoGl) {
        return { permitido: false, usadasOperador: usadoOp, usadasGlobal: usadoGl };
      }
      usadoOp += quantidade;
      usadoGl += quantidade;
      return { permitido: true, usadasOperador: usadoOp, usadasGlobal: usadoGl };
    },
    lerConversa: over.lerConversa ?? (async (id, antes, limite) => {
      chamadas.push({ id, antes, limite });
      return { mensagens: [{ quem: "cliente", em: "2026-11-10T10:00:00Z", texto: "oi" }], paginacao: { maisAntigas: false } };
    }),
    agora: () => agora,
  };
  return { deps, reservas, chamadas, avancar: (ms: number) => { agora += ms; } };
}

beforeEach(() => limparCacheParaTeste());

describe("autorização: carteira ou responsabilidade comprovada, não visibilidade", () => {
  it("dono da carteira pode ler", () => {
    expect(autorizarHistorico(DONO)).toEqual({ ok: true });
  });
  it("só enxergar o caso não basta: operador sem carteira nem responsabilidade é barrado", () => {
    expect(autorizarHistorico(SO_VE)).toEqual({ ok: false, motivo: "SEM_PERMISSAO_NA_CONVERSA" });
  });
  it("sem CPF confirmado, nada é lido", () => {
    expect(autorizarHistorico({ ...DONO, identidade_confirmada: false })).toEqual({ ok: false, motivo: "IDENTIDADE_NAO_CONFIRMADA" });
  });
  it("sem permissão, não reserva nem chama a ULBRA", async () => {
    const f = fabrica({ consultarPermissao: async () => SO_VE });
    const r = await lerHistoricoSomenteLeitura(SO_VE.operador, "c1", null, f.deps);
    expect(r).toEqual({ ok: false, motivo: "SEM_PERMISSAO_NA_CONVERSA" });
    expect(f.reservas).toHaveLength(0);
    expect(f.chamadas).toHaveLength(0);
  });
});

describe("saldo: fotografia com validade, sem presumir", () => {
  it("sem medida bloqueia", () => {
    expect(avaliarSaldo(null, AGORA)).toEqual({ ok: false, motivo: "SALDO_SEM_INFORMACAO" });
  });
  it("medida vencida (mais de 15 min) bloqueia", () => {
    const velho = { restam: 300, em: new Date(AGORA - SALDO_VALIDADE_MS - 1).toISOString() };
    expect(avaliarSaldo(velho, AGORA)).toEqual({ ok: false, motivo: "SALDO_DESATUALIZADO" });
  });
  it("medida recente informa até quando vale", () => {
    const r = avaliarSaldo(SALDO_FRESCO, AGORA);
    expect(r.ok).toBe(true);
    expect(r.validadeAte).toBe(new Date(Date.parse(SALDO_FRESCO.em) + SALDO_VALIDADE_MS).toISOString());
  });
  it("sem saldo recente, a leitura não chega a reservar", async () => {
    const f = fabrica({ lerSaldo: async () => null });
    const r = await lerHistoricoSomenteLeitura(DONO.operador, "c1", null, f.deps);
    expect(r).toEqual({ ok: false, motivo: "SALDO_SEM_INFORMACAO" });
    expect(f.reservas).toHaveLength(0);
  });
});

describe("orçamento: cada chamada externa conta, inclusive 'Carregar anteriores'", () => {
  it("o teto global é o saldo medido menos a reserva", async () => {
    const f = fabrica({ lerSaldo: async () => ({ restam: 150, em: SALDO_FRESCO.em }) });
    await lerHistoricoSomenteLeitura(DONO.operador, "c1", null, f.deps);
    expect(f.reservas[0]).toEqual({ operador: DONO.operador, tetoOp: LIMITE_OPERADOR_DIA, tetoGl: 150 - RESERVA_GLOBAL });
  });
  it("limite por operador bloqueia sem chamar a ULBRA", async () => {
    const f = fabrica({ usadosOperador: LIMITE_OPERADOR_DIA, usadosGlobal: LIMITE_OPERADOR_DIA });
    const r = await lerHistoricoSomenteLeitura(DONO.operador, "c1", null, f.deps);
    expect(r).toEqual({ ok: false, motivo: "LIMITE_OPERADOR_DIA" });
    expect(f.chamadas).toHaveLength(0);
  });
  it("reserva global bloqueia quando a cota do dia acabou", async () => {
    const f = fabrica({ lerSaldo: async () => ({ restam: RESERVA_GLOBAL + 2, em: SALDO_FRESCO.em }), usadosGlobal: 2 });
    const r = await lerHistoricoSomenteLeitura(DONO.operador, "c1", null, f.deps);
    expect(r).toEqual({ ok: false, motivo: "RESERVA_GLOBAL" });
    expect(f.chamadas).toHaveLength(0);
  });
  it("'Carregar anteriores' é outra chamada externa e conta de novo", async () => {
    const f = fabrica();
    await lerHistoricoSomenteLeitura(DONO.operador, "c1", null, f.deps);
    await lerHistoricoSomenteLeitura(DONO.operador, "c1", "2026-11-10T09:00:00Z", f.deps);
    expect(f.reservas).toHaveLength(2);
    expect(f.chamadas).toHaveLength(2);
  });
  it("falha da ULBRA depois da reserva continua contando como chamada", async () => {
    const f = fabrica({ lerConversa: async () => { throw new Error("ULBRA_HTTP_500"); } });
    const r = await lerHistoricoSomenteLeitura(DONO.operador, "c1", null, f.deps);
    expect(r).toEqual({ ok: false, motivo: "ULBRA_INDISPONIVEL" });
    expect(f.reservas).toHaveLength(1);
  });
});

describe("cache e pedidos simultâneos", () => {
  it("cache acertado custa zero chamadas e zero reservas", async () => {
    const f = fabrica();
    await lerHistoricoSomenteLeitura(DONO.operador, "c1", null, f.deps);
    const r2 = await lerHistoricoSomenteLeitura(DONO.operador, "c1", null, f.deps);
    expect(r2.ok && r2.origem).toBe("cache");
    expect(f.reservas).toHaveLength(1);
    expect(f.chamadas).toHaveLength(1);
  });
  it("cache vence depois de 5 minutos", async () => {
    const f = fabrica();
    await lerHistoricoSomenteLeitura(DONO.operador, "c1", null, f.deps);
    f.avancar(CACHE_VALIDADE_MS + 1);
    await lerHistoricoSomenteLeitura(DONO.operador, "c1", null, f.deps);
    expect(f.chamadas).toHaveLength(2);
  });
  it("dois pedidos idênticos ao mesmo tempo viram uma reserva e uma chamada", async () => {
    const f = fabrica({ lerConversa: async (id) => { await new Promise((r) => setTimeout(r, 5)); return { mensagens: [], paginacao: {} }; } });
    const [a, b] = await Promise.all([
      lerHistoricoSomenteLeitura(DONO.operador, "c1", null, f.deps),
      lerHistoricoSomenteLeitura(DONO.operador, "c1", null, f.deps),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(f.reservas).toHaveLength(1);
  });
});

describe("resposta declara o que prova", () => {
  it("leitura feita informa a validade do saldo e o alcance não comprovado", async () => {
    const f = fabrica();
    const r = await lerHistoricoSomenteLeitura(DONO.operador, "c1", null, f.deps);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.chamadas).toBe(1);
      expect(r.saldoAte).not.toBeNull();
      expect(r.alcance).toBe(ALCANCE);
      expect(r.alcance).toMatch(/NÃO comprovado/);
    }
  });
  it("envia o tamanho de página combinado", async () => {
    const f = fabrica();
    await lerHistoricoSomenteLeitura(DONO.operador, "c1", null, f.deps);
    expect(f.chamadas[0].limite).toBe(20);
  });
});
