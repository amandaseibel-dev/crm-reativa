// @vitest-environment jsdom
// Gravador de áudio da Central.
//
// O QUE ESTA SUÍTE PROTEGE:
//   1. NADA É ENVIADO SEM O OPERADOR MANDAR. Parar a gravação leva ao player,
//      não ao envio.
//   2. CANCELAR E DESCARTAR NÃO ENTREGAM NADA.
//   3. O MICROFONE É SOLTO — ao parar, ao cancelar e ao desmontar.
//   4. ENVIO QUE FALHA MANTÉM A GRAVAÇÃO na tela, para tentar de novo.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent, act } from "@testing-library/react";
import GravadorAudioWhatsApp from "./GravadorAudioWhatsApp";

// O mesmo número da tela (2 minutos). Repetido de propósito: se o limite mudar
// sem ninguém decidir, este teste cai.
const LIMITE_SEGUNDOS = 120;

let faixas;
let gravadores;

class GravadorFalso {
  static isTypeSupported(tipo) { return tipo === "audio/webm;codecs=opus"; }
  constructor(fluxo, opcoes) {
    this.fluxo = fluxo;
    this.opcoes = opcoes;
    this.mimeType = opcoes.mimeType;
    this.state = "inactive";
    gravadores.push(this);
  }
  start() { this.state = "recording"; }
  stop() {
    if (this.state === "inactive") return;
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3])]) });
    this.onstop?.();
  }
}

function comMicrofone(getUserMedia) {
  faixas = [{ stop: vi.fn() }];
  const padrao = vi.fn(async () => ({ getTracks: () => faixas }));
  vi.stubGlobal("MediaRecorder", GravadorFalso);
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: getUserMedia || padrao },
  });
  return getUserMedia || padrao;
}

beforeEach(() => {
  gravadores = [];
  URL.createObjectURL = vi.fn(() => "blob:gravacao");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete globalThis.navigator.mediaDevices;
});

async function gravarEParar() {
  fireEvent.click(screen.getByRole("button", { name: /Áudio/ }));
  await screen.findByTestId("gravador-gravando");
  fireEvent.click(screen.getByRole("button", { name: "Parar" }));
  await screen.findByTestId("gravador-pronto");
}

describe("GravadorAudioWhatsApp", () => {
  it("navegador sem gravação: botão desligado, com o motivo", () => {
    render(<GravadorAudioWhatsApp onEnviar={vi.fn()} />);
    const botao = screen.getByRole("button", { name: /Áudio/ });
    expect(botao.disabled).toBe(true);
    expect(botao.title).toMatch(/não grava áudio/);
  });

  it("parar NÃO envia: mostra o player e espera o operador", async () => {
    comMicrofone();
    const onEnviar = vi.fn(async () => {});
    const onOcupado = vi.fn();
    render(<GravadorAudioWhatsApp onEnviar={onEnviar} onOcupado={onOcupado} />);

    fireEvent.click(screen.getByRole("button", { name: /Áudio/ }));
    await screen.findByTestId("gravador-gravando");
    expect(screen.getByRole("timer").textContent).toBe("0:00 / 2:00");
    fireEvent.click(screen.getByRole("button", { name: "Parar" }));
    await screen.findByTestId("gravador-pronto");

    expect(onEnviar).not.toHaveBeenCalled();
    expect(faixas[0].stop).toHaveBeenCalled(); // microfone solto ao parar
    expect(onOcupado).toHaveBeenLastCalledWith(true);
    expect(gravadores[0].opcoes.audioBitsPerSecond).toBe(32000);
  });

  it("enviar entrega a gravação e volta ao início", async () => {
    comMicrofone();
    const onEnviar = vi.fn(async () => {});
    const onOcupado = vi.fn();
    render(<GravadorAudioWhatsApp onEnviar={onEnviar} onOcupado={onOcupado} />);
    await gravarEParar();

    fireEvent.click(screen.getByRole("button", { name: "Enviar áudio" }));

    await waitFor(() => expect(screen.queryByTestId("gravador-pronto")).toBeNull());
    expect(onEnviar).toHaveBeenCalledTimes(1);
    const blob = onEnviar.mock.calls[0][0];
    expect(blob.size).toBe(7);
    expect(blob.type).toBe("audio/webm;codecs=opus");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:gravacao");
    expect(onOcupado).toHaveBeenLastCalledWith(false);
  });

  it("envio que falha mantém a gravação para tentar de novo", async () => {
    comMicrofone();
    const onEnviar = vi.fn(async () => { throw new Error("canal em somente respostas"); });
    render(<GravadorAudioWhatsApp onEnviar={onEnviar} />);
    await gravarEParar();

    fireEvent.click(screen.getByRole("button", { name: "Enviar áudio" }));

    await waitFor(() => expect(onEnviar).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Enviar áudio" }).disabled).toBe(false));
    expect(screen.getByTestId("gravador-pronto")).toBeTruthy();
  });

  it("cancelar no meio não entrega nada e solta o microfone", async () => {
    comMicrofone();
    const onEnviar = vi.fn();
    render(<GravadorAudioWhatsApp onEnviar={onEnviar} />);
    fireEvent.click(screen.getByRole("button", { name: /Áudio/ }));
    await screen.findByTestId("gravador-gravando");

    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));

    await waitFor(() => expect(screen.queryByTestId("gravador-gravando")).toBeNull());
    expect(screen.queryByTestId("gravador-pronto")).toBeNull();
    expect(onEnviar).not.toHaveBeenCalled();
    expect(faixas[0].stop).toHaveBeenCalled();
  });

  it("descartar joga a gravação fora", async () => {
    comMicrofone();
    const onEnviar = vi.fn();
    render(<GravadorAudioWhatsApp onEnviar={onEnviar} />);
    await gravarEParar();

    fireEvent.click(screen.getByRole("button", { name: "Descartar" }));

    expect(screen.queryByTestId("gravador-pronto")).toBeNull();
    expect(onEnviar).not.toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:gravacao");
  });

  it("microfone negado: fica parado e diz o que fazer", async () => {
    comMicrofone(vi.fn(async () => { throw Object.assign(new Error("x"), { name: "NotAllowedError" }); }));
    render(<GravadorAudioWhatsApp onEnviar={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /Áudio/ }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/libere o acesso/);
    expect(screen.queryByTestId("gravador-gravando")).toBeNull();
  });

  it("desmontar no meio da gravação solta o microfone e não entrega nada", async () => {
    comMicrofone();
    const onEnviar = vi.fn();
    const { unmount } = render(<GravadorAudioWhatsApp onEnviar={onEnviar} />);
    fireEvent.click(screen.getByRole("button", { name: /Áudio/ }));
    await screen.findByTestId("gravador-gravando");

    unmount();

    expect(faixas[0].stop).toHaveBeenCalled();
    expect(gravadores[0].state).toBe("inactive");
    expect(onEnviar).not.toHaveBeenCalled();
  });

  it("para sozinho no limite e deixa a gravação pronta para ouvir", async () => {
    comMicrofone();
    render(<GravadorAudioWhatsApp onEnviar={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Áudio/ }));
    await screen.findByTestId("gravador-gravando");

    const agora = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(agora + (LIMITE_SEGUNDOS + 1) * 1000);
    await act(async () => { await new Promise((r) => setTimeout(r, 300)); });

    expect(await screen.findByTestId("gravador-pronto")).toBeTruthy();
    vi.restoreAllMocks();
  });

  it("desabilitado não abre o microfone", () => {
    const pedir = comMicrofone();
    render(<GravadorAudioWhatsApp desabilitado onEnviar={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Áudio/ }));
    expect(pedir).not.toHaveBeenCalled();
  });
});
