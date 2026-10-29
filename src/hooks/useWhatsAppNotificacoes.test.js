// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import useWhatsAppNotificacoes from "./useWhatsAppNotificacoes";

// ---------------------------------------------------------------------------
// Mocks de APIs do navegador
// ---------------------------------------------------------------------------

function fakeBroadcastChannel() {
  const listeners = [];
  return {
    postMessage: vi.fn((msg) => {
      // Simula o recebimento em outra "aba".
      listeners.forEach((fn) => fn({ data: msg }));
    }),
    set onmessage(fn) { listeners.push(fn); },
    close: vi.fn(),
  };
}

beforeEach(() => {
  vi.stubGlobal("BroadcastChannel", vi.fn(() => fakeBroadcastChannel()));
  vi.stubGlobal("AudioContext", vi.fn(() => ({
    state: "running",
    currentTime: 0,
    resume: vi.fn(() => Promise.resolve()),
    createOscillator: vi.fn(() => ({
      frequency: { value: 0 },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    })),
    createGain: vi.fn(() => ({
      gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
    })),
    destination: {},
  })));

  // Notification API padrão: não concedida.
  vi.stubGlobal("Notification", Object.assign(
    vi.fn(),
    { permission: "default", requestPermission: vi.fn(() => Promise.resolve("granted")) }
  ));

  sessionStorage.clear();
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Mensagem de entrada padrão para testes.
// ---------------------------------------------------------------------------
const msgEntrada = (extra = {}) => ({
  id: "msg-1",
  direcao: "ENTRADA",
  origem: "TEMPO_REAL",
  conversa_id: "conv-1",
  texto: "Olá!",
  ...extra,
});

const conversa = (extra = {}) => ({
  id: "conv-1",
  responsavel_email: "op@test.com",
  status: "EM_ATENDIMENTO",
  aluno_nome: "João Silva",
  ...extra,
});

// ---------------------------------------------------------------------------
// Testes
// ---------------------------------------------------------------------------

describe("useWhatsAppNotificacoes", () => {
  describe("filtro de direção", () => {
    it("não notifica mensagem de SAIDA", () => {
      const { result } = renderHook(() =>
        useWhatsAppNotificacoes({ emailOperador: "op@test.com", conversas: [conversa()] })
      );
      act(() => result.current.setPrefs({ visual: true }));
      act(() => result.current.aoReceberMensagem(msgEntrada({ direcao: "SAIDA" })));
      expect(result.current.toasts).toHaveLength(0);
    });

    it("não notifica mensagem com origem diferente de TEMPO_REAL", () => {
      const { result } = renderHook(() =>
        useWhatsAppNotificacoes({ emailOperador: "op@test.com", conversas: [conversa()] })
      );
      act(() => result.current.setPrefs({ visual: true }));
      act(() => result.current.aoReceberMensagem(msgEntrada({ origem: "SYNC_INICIAL" })));
      expect(result.current.toasts).toHaveLength(0);
    });
  });

  describe("filtro de responsabilidade", () => {
    it("notifica conversa atribuída ao operador logado", () => {
      const { result } = renderHook(() =>
        useWhatsAppNotificacoes({
          emailOperador: "op@test.com",
          conversas: [conversa({ responsavel_email: "op@test.com" })],
        })
      );
      act(() => result.current.setPrefs({ visual: true }));
      act(() => result.current.aoReceberMensagem(msgEntrada()));
      expect(result.current.toasts).toHaveLength(1);
    });

    it("notifica conversa sem responsável (receptivo)", () => {
      const { result } = renderHook(() =>
        useWhatsAppNotificacoes({
          emailOperador: "op@test.com",
          conversas: [conversa({ responsavel_email: null, status: "NOVO" })],
        })
      );
      act(() => result.current.setPrefs({ visual: true }));
      act(() => result.current.aoReceberMensagem(msgEntrada()));
      expect(result.current.toasts).toHaveLength(1);
    });

    it("não notifica conversa de outro operador", () => {
      const { result } = renderHook(() =>
        useWhatsAppNotificacoes({
          emailOperador: "op@test.com",
          conversas: [conversa({ responsavel_email: "outro@test.com" })],
        })
      );
      act(() => result.current.setPrefs({ visual: true }));
      act(() => result.current.aoReceberMensagem(msgEntrada()));
      expect(result.current.toasts).toHaveLength(0);
    });

    it("não notifica receptivo com status ENCERRADO", () => {
      const { result } = renderHook(() =>
        useWhatsAppNotificacoes({
          emailOperador: "op@test.com",
          conversas: [conversa({ responsavel_email: null, status: "ENCERRADO" })],
        })
      );
      act(() => result.current.setPrefs({ visual: true }));
      act(() => result.current.aoReceberMensagem(msgEntrada()));
      expect(result.current.toasts).toHaveLength(0);
    });
  });

  describe("deduplicação", () => {
    it("não exibe o mesmo id de mensagem duas vezes", () => {
      const { result } = renderHook(() =>
        useWhatsAppNotificacoes({ emailOperador: "op@test.com", conversas: [conversa()] })
      );
      act(() => result.current.setPrefs({ visual: true }));
      act(() => result.current.aoReceberMensagem(msgEntrada({ id: "msg-dup" })));
      act(() => result.current.aoReceberMensagem(msgEntrada({ id: "msg-dup" })));
      // Só 1 toast mesmo com 2 chamadas idênticas.
      expect(result.current.toasts).toHaveLength(1);
    });

    it("marca o id como visto no sessionStorage para sobreviver a reload", () => {
      const { result } = renderHook(() =>
        useWhatsAppNotificacoes({ emailOperador: "op@test.com", conversas: [conversa()] })
      );
      act(() => result.current.setPrefs({ visual: true }));
      act(() => result.current.aoReceberMensagem(msgEntrada({ id: "msg-persist" })));
      const raw = sessionStorage.getItem("rv_wapp_seen");
      expect(raw).toContain("msg-persist");
    });
  });

  describe("preferências", () => {
    it("som desligado por padrão", () => {
      const { result } = renderHook(() =>
        useWhatsAppNotificacoes({ emailOperador: "op@test.com", conversas: [] })
      );
      expect(result.current.prefs.som).toBe(false);
    });

    it("visual ligado por padrão", () => {
      const { result } = renderHook(() =>
        useWhatsAppNotificacoes({ emailOperador: "op@test.com", conversas: [] })
      );
      expect(result.current.prefs.visual).toBe(true);
    });

    it("setPrefs persiste em localStorage por email do operador", () => {
      const { result } = renderHook(() =>
        useWhatsAppNotificacoes({ emailOperador: "alice@test.com", conversas: [] })
      );
      act(() => result.current.setPrefs({ som: true }));
      const chave = "rv_wapp_prefs_alice_test_com";
      const salvo = JSON.parse(localStorage.getItem(chave) || "{}");
      expect(salvo.som).toBe(true);
    });

    it("sem toast quando visual está desligado", () => {
      const { result } = renderHook(() =>
        useWhatsAppNotificacoes({
          emailOperador: "op@test.com",
          conversas: [conversa()],
        })
      );
      act(() => result.current.setPrefs({ visual: false }));
      act(() => result.current.aoReceberMensagem(msgEntrada({ id: "msg-novisual" })));
      expect(result.current.toasts).toHaveLength(0);
    });
  });

  describe("fecharToast", () => {
    it("remove o toast pelo id", () => {
      const { result } = renderHook(() =>
        useWhatsAppNotificacoes({ emailOperador: "op@test.com", conversas: [conversa()] })
      );
      act(() => result.current.setPrefs({ visual: true }));
      act(() => result.current.aoReceberMensagem(msgEntrada({ id: "msg-close" })));
      expect(result.current.toasts).toHaveLength(1);
      const id = result.current.toasts[0].id;
      act(() => result.current.fecharToast(id));
      expect(result.current.toasts).toHaveLength(0);
    });
  });

  describe("pedirPermissaoBrowser", () => {
    it("retorna 'granted' quando o navegador concede", async () => {
      Notification.requestPermission = vi.fn(() => Promise.resolve("granted"));
      const { result } = renderHook(() =>
        useWhatsAppNotificacoes({ emailOperador: "op@test.com", conversas: [] })
      );
      let r;
      await act(async () => { r = await result.current.pedirPermissaoBrowser(); });
      expect(r).toBe("granted");
    });

    it("retorna 'not-supported' quando Notification não existe", async () => {
      vi.stubGlobal("Notification", undefined);
      const { result } = renderHook(() =>
        useWhatsAppNotificacoes({ emailOperador: "op@test.com", conversas: [] })
      );
      let r;
      await act(async () => { r = await result.current.pedirPermissaoBrowser(); });
      expect(r).toBe("not-supported");
    });
  });

  describe("conversa ausente na lista local", () => {
    it("notifica mesmo quando a conversa não está no estado local (filtro ativo)", () => {
      // Operador com lista vazia (filtro aplicado — a conversa sumiu da view).
      const { result } = renderHook(() =>
        useWhatsAppNotificacoes({ emailOperador: "op@test.com", conversas: [] })
      );
      act(() => result.current.setPrefs({ visual: true }));
      act(() => result.current.aoReceberMensagem(msgEntrada({ id: "msg-ausente" })));
      // Safety net: melhor notificar demais do que silenciar.
      expect(result.current.toasts).toHaveLength(1);
    });
  });
});
