// Garantias do histórico somente leitura, sem rede e sem chamada real.
import { describe, it, expect, beforeEach } from "vitest";
import {
  parseRetryAfter,
  ALCANCE,
  CACHE_VALIDADE_MS,
  LIMITE_OPERADOR_DIA,
  RESERVA_GLOBAL,
  SALDO_VALIDADE_MS,
  TETO_HISTORICO_DIA,
  avaliarSaldo,
  autorizarHistorico,
  limparCacheParaTeste,
  lerHistoricoSomenteLeitura,
  type DependenciasHistorico,
  type FotografiaSaldo,
  diaDoOrcamento,
} from "./historico.ts";
import type { ContextoLeitura } from "./leitura.ts";

const AGORA = Date.parse("2026-11-10T12:00:00Z");
const SALDO_FRESCO: FotografiaSaldo = { restam: 300, em: new Date(AGORA - 60_000).toISOString() };
const DONO: ContextoLeitura = { operador: "cobranca10@aelbra.com.br", identidade_confirmada: true, dono_carteira: "cobranca10@aelbra.com.br", responsavel_atendimento: null };
const SO_VE: ContextoLeitura = { operador: "cobranca10@aelbra.com.br", identidade_confirmada: true, dono_carteira: "cobranca05@aelbra.com.br", responsavel_atendimento: null };

function fabrica(over: Partial<DependenciasHistorico> & { usadosOperador?: number; usadosGlobal?: number } = {}) {
  let usadoOp = over.usadosOperador ?? 0;
  let usadoGl = over.usadosGlobal ?? 0;
  const reservas: Array<{ operador: string; tetoOp: number; tetoGl: number }> = [];
  const chamadas: Array<{ id: string; antes: string | null; limite: number }> = [];
  const bloqueios: Array<number | null> = [];
  let agora = AGORA;
  const deps: DependenciasHistorico = {
    consultarPermissao: over.consultarPermissao ?? (async () => DONO),
    lerSaldo: over.lerSaldo ?? (async () => SALDO_FRESCO),
    renovarSaldo: over.renovarSaldo ?? (async () => ({ restam: 300, em: new Date(agora).toISOString() })),
    lerBloqueio: over.lerBloqueio ?? (async () => ({ ativo: false, ateMs: null, semPrazo: false })),
    registrarBloqueio: over.registrarBloqueio ?? (async (ra) => { bloqueios.push(ra); }),
    usoTotal: over.usoTotal ?? (async () => 0),
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
  return { deps, reservas, chamadas, bloqueios, avancar: (ms: number) => { agora += ms; } };
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
  it("teto diário fixo: com saldo alto, o teto global do histórico é TETO_HISTORICO_DIA, não o saldo menos a reserva", async () => {
    const f = fabrica({ lerSaldo: async () => ({ restam: 9821, em: SALDO_FRESCO.em }) });
    await lerHistoricoSomenteLeitura(DONO.operador, "c1", null, f.deps);
    expect(f.reservas[0]).toEqual({ operador: DONO.operador, tetoOp: LIMITE_OPERADOR_DIA, tetoGl: TETO_HISTORICO_DIA });
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

// ---------------------------------------------------------------------------
// Orçamento antes da chamada, bloqueio após 429 e dia de Brasília.
// Expectativas escritas à mão, com relógio fixo (AGORA = 2026-11-10T12:00:00Z).
// ---------------------------------------------------------------------------
const VENCIDO = () => ({ restam: 300, em: new Date(AGORA - 20 * 60_000).toISOString() });

describe("saldo vencido: a renovação é reservada ANTES da chamada e conta como tentativa", () => {
  it("reserva 2 unidades (renovação + leitura) antes de qualquer chamada externa", async () => {
    let reservasAntesDaRenovacao = -1;
    const f = fabrica({
      lerSaldo: async () => VENCIDO(),
      renovarSaldo: async () => { reservasAntesDaRenovacao = f.reservas.length; return { restam: 300, em: new Date(AGORA).toISOString() }; },
    });
    const r = await lerHistoricoSomenteLeitura(DONO.operador, "c1", null, f.deps);
    expect(reservasAntesDaRenovacao).toBe(1);
    expect(r.ok).toBe(true);
    expect(r.ok && r.chamadas).toBe(2);
  });
  it("com 19 de 20 usadas, saldo vencido NÃO renova: a renovação não cabe e nada sai", async () => {
    let renovou = false;
    const f = fabrica({
      usadosOperador: 19, lerSaldo: async () => VENCIDO(),
      renovarSaldo: async () => { renovou = true; return null; },
    });
    const r = await lerHistoricoSomenteLeitura(DONO.operador, "c1", null, f.deps);
    expect(r).toEqual({ ok: false, motivo: "LIMITE_OPERADOR_DIA" });
    expect(renovou).toBe(false);
    expect(f.chamadas).toHaveLength(0);
  });
});

describe("bloqueio compartilhado após 429", () => {
  function fabricaComBloqueio(extra: Partial<DependenciasHistorico> = {}) {
    let bloqueio = { ativo: false, ateMs: null as number | null, semPrazo: false };
    const f = fabrica({
      lerBloqueio: async () => bloqueio,
      registrarBloqueio: async (ra) => {
        f.bloqueios.push(ra);
        bloqueio = ra === null
          ? { ativo: true, ateMs: null, semPrazo: true }
          : { ativo: true, ateMs: AGORA + ra * 1000, semPrazo: false };
      },
      ...extra,
    });
    return f;
  }
  it("429 com Retry-After de 120 s: registra esse prazo; o próximo clique é barrado sem chamada nem reserva", async () => {
    const f = fabricaComBloqueio({
      lerConversa: async () => { throw Object.assign(new Error("ULBRA_LIMITE"), { retryAfterSegundos: 120 }); },
    });
    const primeiro = await lerHistoricoSomenteLeitura(DONO.operador, "c1", null, f.deps);
    expect(primeiro).toEqual({ ok: false, motivo: "ULBRA_LIMITE" });
    expect(f.bloqueios).toEqual([120]);
    const reservasAntes = f.reservas.length;
    const segundo = await lerHistoricoSomenteLeitura(DONO.operador, "c2", null, f.deps);
    expect(segundo).toEqual({ ok: false, motivo: "ULBRA_BLOQUEADA" });
    expect(f.reservas.length).toBe(reservasAntes);
  });
  it("429 SEM Retry-After: não inventa prazo; o bloqueio continua mesmo depois de muito tempo", async () => {
    const f = fabricaComBloqueio({
      lerConversa: async () => { throw Object.assign(new Error("ULBRA_LIMITE"), { retryAfterSegundos: null }); },
    });
    await lerHistoricoSomenteLeitura(DONO.operador, "c1", null, f.deps);
    expect(f.bloqueios).toEqual([null]);
    f.avancar(7 * 24 * 60 * 60 * 1000);
    const depois = await lerHistoricoSomenteLeitura(DONO.operador, "c2", null, f.deps);
    expect(depois).toEqual({ ok: false, motivo: "ULBRA_BLOQUEADA" });
  });
  it("passado o Retry-After, a leitura volta a ser permitida", async () => {
    let chamadas = 0;
    const f = fabricaComBloqueio({
      lerConversa: async () => {
        chamadas++;
        if (chamadas === 1) throw Object.assign(new Error("ULBRA_LIMITE"), { retryAfterSegundos: 120 });
        return { mensagens: [], paginacao: { maisAntigas: false } };
      },
    });
    await lerHistoricoSomenteLeitura(DONO.operador, "c1", null, f.deps);
    f.avancar(121_000);
    const r = await lerHistoricoSomenteLeitura(DONO.operador, "c2", null, f.deps);
    expect(r.ok).toBe(true);
  });
  it("429 na renovação de saldo também registra o bloqueio (e a tentativa conta)", async () => {
    const f = fabricaComBloqueio({
      lerSaldo: async () => VENCIDO(),
      renovarSaldo: async () => { throw Object.assign(new Error("ULBRA_LIMITE"), { retryAfterSegundos: 60 }); },
    });
    const r = await lerHistoricoSomenteLeitura(DONO.operador, "c1", null, f.deps);
    expect(r).toEqual({ ok: false, motivo: "ULBRA_LIMITE" });
    expect(f.bloqueios).toEqual([60]);
    expect(f.reservas[0]).toBeDefined();
  });
});

describe("tetos e dia de Brasília (valores fixos da especificação)", () => {
  it("teto compartilhado de 150: com 150 já usadas no dia, nada sai (RESERVA_GLOBAL)", async () => {
    const f = fabrica({ usadosGlobal: 150, lerSaldo: async () => ({ restam: 9821, em: new Date(AGORA - 60_000).toISOString() }) });
    const r = await lerHistoricoSomenteLeitura(DONO.operador, "c1", null, f.deps);
    expect(r).toEqual({ ok: false, motivo: "RESERVA_GLOBAL" });
    expect(f.chamadas).toHaveLength(0);
  });
  it("20 por usuário: a 21ª leitura do dia é barrada sem chamada", async () => {
    const f = fabrica({ usadosOperador: 20 });
    const r = await lerHistoricoSomenteLeitura(DONO.operador, "c1", null, f.deps);
    expect(r).toEqual({ ok: false, motivo: "LIMITE_OPERADOR_DIA" });
    expect(f.chamadas).toHaveLength(0);
  });
  it("virada do dia: 2026-11-15T02:59:59Z ainda é 14 em São Paulo; 03:00:00Z já é 15", () => {
    expect(diaDoOrcamento(Date.parse("2026-11-15T02:59:59Z"))).toBe("2026-11-14");
    expect(diaDoOrcamento(Date.parse("2026-11-15T03:00:00Z"))).toBe("2026-11-15");
  });
});

describe("Retry-After: segundos ou data HTTP; sem prazo quando não interpretável", () => {
  const AGORA_MS = Date.parse("2026-11-15T12:00:00Z");
  it("segundos inteiros valem como estão", () => {
    expect(parseRetryAfter("120", AGORA_MS)).toBe(120);
  });
  it("data HTTP vira segundos restantes (60 s à frente)", () => {
    expect(parseRetryAfter("Sun, 15 Nov 2026 12:01:00 GMT", AGORA_MS)).toBe(60);
  });
  it("data HTTP já passada vira zero (não bloqueia)", () => {
    expect(parseRetryAfter("Sun, 15 Nov 2026 11:00:00 GMT", AGORA_MS)).toBe(0);
  });
  it("ausente ou não interpretável vira null (sem prazo, nunca inventado)", () => {
    expect(parseRetryAfter(null, AGORA_MS)).toBeNull();
    expect(parseRetryAfter("amanhã cedo", AGORA_MS)).toBeNull();
  });
});

describe("429 com falha ao gravar o bloqueio: a memória da instância ainda bloqueia", () => {
  it("gravação do bloqueio falha; o próximo clique é barrado sem chamar a ULBRA", async () => {
    const f = fabrica({
      lerConversa: async () => { throw Object.assign(new Error("ULBRA_LIMITE"), { retryAfterSegundos: 300 }); },
      registrarBloqueio: async () => { throw new Error("BLOQUEIO_GRAVACAO_FALHOU"); },
    });
    // A gravação falha: a chamada do operador sobe como erro (502 na função); nada mais sai.
    await expect(lerHistoricoSomenteLeitura(DONO.operador, "c1", null, f.deps)).rejects.toThrow("BLOQUEIO_GRAVACAO_FALHOU");
    const chamadasAntes = f.chamadas.length;
    const segundo = await lerHistoricoSomenteLeitura(DONO.operador, "c2", null, f.deps);
    expect(segundo).toEqual({ ok: false, motivo: "ULBRA_BLOQUEADA" });
    expect(f.chamadas.length).toBe(chamadasAntes);
  });
  it("revogação: quem perdeu a carteira não lê nem do cache", async () => {
    let dono = DONO;
    const f = fabrica({ consultarPermissao: async () => dono });
    await lerHistoricoSomenteLeitura(DONO.operador, "c1", null, f.deps);
    dono = SO_VE;
    const r = await lerHistoricoSomenteLeitura(DONO.operador, "c1", null, f.deps);
    expect(r).toEqual({ ok: false, motivo: "SEM_PERMISSAO_NA_CONVERSA" });
  });
});
