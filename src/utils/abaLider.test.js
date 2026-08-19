import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  criarControleAbaLider,
  HEARTBEAT_MS,
  EXPIRACAO_MS,
  ORFAO_MS,
} from "./abaLider";

// Ambiente fake, sem jsdom: localStorage em memória + window com registro de
// listeners, BroadcastChannel desativado (força o caminho storage+timers) e
// timers/relogio controlados por fake timers do vitest.

const SCOPE = "u1";
const CHAVE = `reativa_aba_lider__${SCOPE}`;
const BASE_TS = 1_000_000;
const JITTER = 200; // > CLAIM_JITTER_MS interno
const MONITOR = 3000; // MONITOR_MS interno: varredura local da secundária

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
  globalThis.BroadcastChannel = undefined;
});

// BroadcastChannel de mentira: entrega síncrona para os OUTROS inscritos no
// mesmo nome. Os testes de órfão precisam dele porque a sonda "quem-e-lider"
// só pode ser respondida por esse caminho.
function instalarBroadcastChannel() {
  const canais = new Map();
  globalThis.BroadcastChannel = class {
    constructor(nome) {
      this.nome = nome;
      this.onmessage = null;
      if (!canais.has(nome)) canais.set(nome, new Set());
      canais.get(nome).add(this);
    }
    postMessage(data) {
      for (const outro of canais.get(this.nome) || []) {
        if (outro !== this && typeof outro.onmessage === "function") outro.onmessage({ data });
      }
    }
    close() {
      canais.get(this.nome)?.delete(this);
    }
  };
}

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

// ---------------------------------------------------------------------------
// Registro órfão — o incidente de 19/08/2026.
//
// O Mac reiniciou e o Chrome morreu sem rodar `pagehide`. O registro da líder
// ficou no localStorage sem dono nenhum, e como a regra proíbe assumir por
// expiração, TODA aba nova ficava bloqueada para sempre: o CRM não montava e de
// fora parecia "a Central não carrega as mensagens".
// ---------------------------------------------------------------------------
describe("abaLider — registro órfão de crash/reboot", () => {
  const SONDA = 700 + JITTER; // janela da sonda + folga do desempate

  it("reboot do navegador deixa registro órfão: a aba destrava sozinha após a sonda", () => {
    seedRegistro("ABA_MORTA_NO_REBOOT", ORFAO_MS + 60_000); // 6 min sem renovar
    const c = criarControleAbaLider(SCOPE, {});
    c.iniciar();
    vi.advanceTimersByTime(JITTER);

    // Não pode assumir de imediato: primeiro pergunta.
    expect(c.estado().ehLider).toBe(false);
    expect(lerRegistro().tabId).toBe("ABA_MORTA_NO_REBOOT");

    // Ninguém responde a sonda e o registro não é tocado: assume.
    vi.advanceTimersByTime(SONDA);

    expect(c.estado().ehLider).toBe(true);
    expect(lerRegistro().tabId).toBe(c.tabId);
  });

  it("órfão que aparece com a aba já aberta também destrava (varredura do monitor)", () => {
    seedRegistro("OUTRA_ABA", 0); // começa fresco: aba fica secundária
    const c = criarControleAbaLider(SCOPE, {});
    c.iniciar();
    vi.advanceTimersByTime(JITTER);
    expect(c.estado().ehLider).toBe(false);

    // A outra aba morre sem limpar. O tempo passa muito além do congelamento.
    vi.advanceTimersByTime(ORFAO_MS + MONITOR + SONDA);

    expect(c.estado().ehLider).toBe(true);
    expect(lerRegistro().tabId).toBe(c.tabId);
  });

  it("registro velho mas AINDA NÃO órfão continua protegido (congelamento de 2min)", () => {
    seedRegistro("LIDER_CONGELADA", 0);
    const c = criarControleAbaLider(SCOPE, {});
    c.iniciar();
    vi.advanceTimersByTime(JITTER);

    // 2 minutos: passa da expiração (25s) mas NÃO do limite de órfão (5min).
    vi.advanceTimersByTime(130_000);

    expect(c.estado().ehLider).toBe(false);
    expect(c.estado().pareceExpirada).toBe(true); // CTA continua disponível
    expect(lerRegistro().tabId).toBe("LIDER_CONGELADA");
  });
});

describe("abaLider — duas abas vivas continuam protegidas", () => {
  const SONDA = 700 + JITTER;

  it("líder viva responde a sonda: a secundária NÃO rouba, mesmo com registro antigo", () => {
    instalarBroadcastChannel();
    seedRegistro("LIDER_VIVA", ORFAO_MS + 60_000); // registro velho de propósito

    // Uma aba viva que não renovou o registro, mas responde quando perguntam.
    const canal = new BroadcastChannel(`reativa_aba_lider__${SCOPE}`);
    let perguntas = 0;
    canal.onmessage = (ev) => {
      if (ev.data?.tipo === "quem-e-lider") {
        perguntas += 1;
        canal.postMessage({ tipo: "heartbeat", tabId: "LIDER_VIVA", ts: Date.now() });
      }
    };

    const c = criarControleAbaLider(SCOPE, {});
    c.iniciar();
    vi.advanceTimersByTime(JITTER + SONDA);

    expect(perguntas).toBeGreaterThan(0); // a sonda realmente perguntou
    expect(c.estado().ehLider).toBe(false); // e recuou ao ouvir prova de vida
    expect(lerRegistro().tabId).toBe("LIDER_VIVA");
  });

  it("duas abas reais: a 2ª nunca assume, por mais tempo que passe", () => {
    instalarBroadcastChannel();
    const a = criarControleAbaLider(SCOPE, {});
    a.iniciar();
    vi.advanceTimersByTime(JITTER);
    expect(a.estado().ehLider).toBe(true);

    const b = criarControleAbaLider(SCOPE, {});
    b.iniciar();
    vi.advanceTimersByTime(JITTER);
    expect(b.estado().ehLider).toBe(false);

    // 10 minutos — o dobro do limite de órfão. A líder segue renovando.
    vi.advanceTimersByTime(600_000);

    expect(a.estado().ehLider).toBe(true);
    expect(b.estado().ehLider).toBe(false);
    expect(lerRegistro().tabId).toBe(a.tabId);
  });

  it("líder viva que renova o registro impede o takeover mesmo sem BroadcastChannel", () => {
    // BroadcastChannel desligado (padrão do setup): a única prova de vida é o
    // registro ser tocado durante a janela da sonda.
    seedRegistro("LIDER_SEM_CANAL", ORFAO_MS + 60_000);
    const c = criarControleAbaLider(SCOPE, {});
    c.iniciar();
    vi.advanceTimersByTime(JITTER);

    // No meio da sonda, a "outra aba" renova o registro — sinal de vida.
    vi.advanceTimersByTime(300);
    seedRegistro("LIDER_SEM_CANAL", 0);
    vi.advanceTimersByTime(SONDA);

    expect(c.estado().ehLider).toBe(false);
    expect(lerRegistro().tabId).toBe("LIDER_SEM_CANAL");
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
