import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { criarControleAbasPorVagas } from "./abaLider";

const SCOPE = "u1";
const JITTER = 200;
let store;
let listeners;

function setupEnv() {
  store = new Map();
  listeners = {};
  global.window = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    addEventListener: (t, f) => {
      (listeners[t] = listeners[t] || []).push(f);
    },
    removeEventListener: (t, f) => {
      if (listeners[t]) listeners[t] = listeners[t].filter((x) => x !== f);
    },
  };
  globalThis.BroadcastChannel = undefined;
}
function fireStorage(key) {
  (listeners.storage || []).forEach((f) => f({ key }));
}
function abrir() {
  const c = criarControleAbasPorVagas(SCOPE, { vagas: 2 });
  c.iniciar();
  vi.advanceTimersByTime(JITTER);
  return c;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  setupEnv();
});
afterEach(() => {
  vi.useRealTimers();
  delete global.window;
});

describe("abas por vagas (2 por pessoa)", () => {
  it("1ª e 2ª abas entram; a 3ª fica bloqueada", () => {
    const a = abrir();
    const b = abrir();
    const c = abrir();
    expect(a.estado().ehLider).toBe(true);
    expect(a.estado().vaga).toBe(1);
    expect(b.estado().ehLider).toBe(true);
    expect(b.estado().vaga).toBe(2);
    expect(c.estado().ehLider).toBe(false);
    // Uma aba nunca ocupa as duas vagas.
    const v1 = JSON.parse(store.get(`reativa_aba_lider__${SCOPE}__v1`)).tabId;
    const v2 = JSON.parse(store.get(`reativa_aba_lider__${SCOPE}__v2`)).tabId;
    expect(v1).not.toBe(v2);
  });

  it("fechando uma das ativas, a bloqueada assume a vaga", () => {
    const a = abrir();
    abrir();
    const c = abrir();
    expect(c.estado().ehLider).toBe(false);
    a.destruir();
    fireStorage(`reativa_aba_lider__${SCOPE}__v1`);
    vi.advanceTimersByTime(JITTER);
    expect(c.estado().ehLider).toBe(true);
    expect(c.estado().vaga).toBe(1);
  });

  it("'Usar esta aba' toma uma vaga à força e a antiga dona recua", () => {
    const a = abrir();
    abrir();
    const c = abrir();
    c.assumirForcado();
    vi.advanceTimersByTime(JITTER);
    fireStorage(`reativa_aba_lider__${SCOPE}__v1`);
    expect(c.estado().ehLider).toBe(true);
    expect(a.estado().ehLider).toBe(false);
  });
});
