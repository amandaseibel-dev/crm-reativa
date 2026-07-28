import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  criarControleAbaLider,
  HEARTBEAT_MS,
  EXPIRACAO_MS,
} from "./abaLider";

// Ambiente fake, sem jsdom: localStorage em memória + window com registro de
// listeners, BroadcastChannel desativado (força o caminho storage+timers) e
// timers/relogio controlados por fake timers do vitest.

const SCOPE = "u1";
const CHAVE = `reativa_aba_lider__${SCOPE}`;
const BASE_TS = 1_000_000;
const JITTER = 200; // > CLAIM_JITTER_MS interno

let store;
let listeners;

function setupEnv() {
  store = new Map();
  listeners = {};
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  global.window = {
    localStorage,
    addEventListener: (t, f) => {
      (listeners[t] = listeners[t] || []).push(f);
    },
    removeEventListener: (t, f) => {
      if (listeners[t]) listeners[t] = listeners[t].filter((x) => x !== f);
    },
  };
  // Desliga o BroadcastChannel para exercitar a coordenação por storage/timers.
  globalThis.BroadcastChannel = undefined;
}

function fireStorage(key = CHAVE) {
  (listeners.storage || []).forEach((f) => f({ key }));
}

function lerRegistro() {
  const raw = store.get(CHAVE);
  return raw ? JSON.parse(raw) : null;
}

function seedRegistro(tabId, ageMs = 0) {
  store.set(CHAVE, JSON.stringify({ tabId, ts: Date.now() - ageMs }));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BASE_TS);
  setupEnv();
});

afterEach(() => {
  vi.useRealTimers();
  delete global.window;
});

describe("abaLider — eleição básica", () => {
  it("aba única com storage vazio vira líder e grava o registro", () => {
    const c = criarControleAbaLider(SCOPE, {});
    c.iniciar();
    vi.advanceTimersByTime(JITTER);

    expect(c.estado().ehLider).toBe(true);
    expect(lerRegistro().tabId).toBe(c.tabId);
  });

  it("nunca duas líderes: a 2ª instância fica bloqueada com líder viva", () => {
    const a = criarControleAbaLider(SCOPE, {});
    a.iniciar();
    vi.advanceTimersByTime(JITTER);
    expect(a.estado().ehLider).toBe(true);

    const b = criarControleAbaLider(SCOPE, {});
    b.iniciar();
    vi.advanceTimersByTime(JITTER);

    expect(b.estado().ehLider).toBe(false);
    expect(a.estado().ehLider).toBe(true);
    expect(lerRegistro().tabId).toBe(a.tabId);
  });
});

describe("abaLider — sem assunção por expiração (correção do failover)", () => {
  it("secundária NÃO assume mesmo com o registro velho por >2min (líder viva em 2º plano)", () => {
    seedRegistro("OUTRA_ABA", 0); // registro fresco de outra aba
    const c = criarControleAbaLider(SCOPE, {});
    c.iniciar();
    vi.advanceTimersByTime(JITTER);
    expect(c.estado().ehLider).toBe(false);

    // Passam 2 minutos SEM a outra aba renovar (pior caso: timer congelado).
    vi.advanceTimersByTime(130_000);

    // A correção: continua bloqueada, não roubou a liderança.
    expect(c.estado().ehLider).toBe(false);
    expect(lerRegistro().tabId).toBe("OUTRA_ABA");
    // E sinaliza que a outra aba PODE ter encerrado (habilita o CTA).
    expect(c.estado().pareceExpirada).toBe(true);
  });

  it("líder em 2º plano por 2min continua líder (renova a própria posse)", () => {
    const c = criarControleAbaLider(SCOPE, {});
    c.iniciar();
    vi.advanceTimersByTime(JITTER);
    expect(c.estado().ehLider).toBe(true);

    vi.advanceTimersByTime(130_000);

    expect(c.estado().ehLider).toBe(true);
    expect(lerRegistro().tabId).toBe(c.tabId);
    // Registro renovado recentemente (não expirado).
    expect(Date.now() - lerRegistro().ts).toBeLessThanOrEqual(HEARTBEAT_MS);
  });

  it("sobe com registro velho (possível crash anterior): fica bloqueada e sinaliza CTA, sem assumir", () => {
    seedRegistro("ABA_MORTA", EXPIRACAO_MS + 60_000); // já velho ao subir
    const c = criarControleAbaLider(SCOPE, {});
    c.iniciar();
    vi.advanceTimersByTime(JITTER);

    expect(c.estado().ehLider).toBe(false);
    expect(c.estado().pareceExpirada).toBe(true);
    expect(lerRegistro().tabId).toBe("ABA_MORTA"); // não roubou
  });
});

describe("abaLider — failover de fechamento normal", () => {
  it("registro removido (fechamento normal) -> a secundária assume", () => {
    seedRegistro("OUTRA_ABA", 0);
    const c = criarControleAbaLider(SCOPE, {});
    c.iniciar();
    vi.advanceTimersByTime(JITTER);
    expect(c.estado().ehLider).toBe(false);

    // A líder fecha normalmente: destruir() remove o registro.
    store.delete(CHAVE);
    fireStorage();
    vi.advanceTimersByTime(JITTER);

    expect(c.estado().ehLider).toBe(true);
    expect(lerRegistro().tabId).toBe(c.tabId);
  });

  it("destruir() da líder libera o registro (habilita failover ~imediato)", () => {
    const c = criarControleAbaLider(SCOPE, {});
    c.iniciar();
    vi.advanceTimersByTime(JITTER);
    expect(lerRegistro().tabId).toBe(c.tabId);

    c.destruir();

    expect(store.has(CHAVE)).toBe(false);
  });
});

describe("abaLider — transferência e revalidação", () => {
  it('"Usar esta aba" transfere a liderança para a secundária', () => {
    seedRegistro("OUTRA_ABA", 0);
    const c = criarControleAbaLider(SCOPE, {});
    c.iniciar();
    vi.advanceTimersByTime(JITTER);
    expect(c.estado().ehLider).toBe(false);

    c.assumirForcado();
    vi.advanceTimersByTime(JITTER);

    expect(c.estado().ehLider).toBe(true);
    expect(lerRegistro().tabId).toBe(c.tabId);
  });

  it("antiga líder recua ao voltar e ver o registro de outra aba (heartbeat revalida a posse)", () => {
    const c = criarControleAbaLider(SCOPE, {});
    c.iniciar();
    vi.advanceTimersByTime(JITTER);
    expect(c.estado().ehLider).toBe(true);

    // Enquanto "congelada", outra aba assumiu à força (sobrescreveu o registro).
    store.set(CHAVE, JSON.stringify({ tabId: "NOVA_LIDER", ts: Date.now() }));

    // Ao "descongelar", a próxima batida de heartbeat revalida e ela recua.
    vi.advanceTimersByTime(HEARTBEAT_MS + 50);

    expect(c.estado().ehLider).toBe(false);
    expect(lerRegistro().tabId).toBe("NOVA_LIDER");
  });

  it("antiga líder recua imediatamente ao receber o storage event da transferência", () => {
    const c = criarControleAbaLider(SCOPE, {});
    c.iniciar();
    vi.advanceTimersByTime(JITTER);
    expect(c.estado().ehLider).toBe(true);

    store.set(CHAVE, JSON.stringify({ tabId: "NOVA_LIDER", ts: Date.now() }));
    fireStorage();

    expect(c.estado().ehLider).toBe(false);
  });
});

describe("abaLider — modo degradado (sem storage)", () => {
  it("sem localStorage disponível, a aba assume como líder (não trava o operacional)", () => {
    // Faz o probe de localStorage falhar.
    global.window.localStorage.setItem = () => {
      throw new Error("storage indisponível");
    };
    const c = criarControleAbaLider(SCOPE, {});
    c.iniciar();

    expect(c._temStorage).toBe(false);
    expect(c.estado().ehLider).toBe(true);
    expect(c.estado().degradado).toBe(true);
  });
});
