// Gravador de áudio da Central WhatsApp.
//
// TRÊS ESTADOS, e nenhum envia sozinho:
//   PARADO   → botão "🎤 Áudio"
//   GRAVANDO → relógio correndo, "Parar" e "Cancelar"
//   PRONTO   → o operador OUVE o que gravou e decide: "Enviar áudio" ou
//              "Descartar"
//
// POR QUE OUVIR ANTES: áudio enviado não se corrige. Mensagem de texto o
// operador relê antes do Enter; o equivalente aqui é o player.
//
// O MICROFONE É SOLTO SEMPRE — ao parar, ao cancelar, ao descartar e ao
// desmontar. Aba com o indicador de gravação aceso depois do atendimento é o
// tipo de coisa que faz a operação desconfiar da ferramenta, com razão.
//
// Este componente não sabe para quem o áudio vai. Ele entrega a gravação para
// `onEnviar`; canal, dono e cadência são decididos no servidor.
import { useCallback, useEffect, useRef, useState } from "react";

// 2 minutos. A gravação para sozinha e fica pronta para ouvir — não é
// descartada. A 32 kbps isso dá cerca de 480 KB, abaixo do teto de 1 MB.
const LIMITE_SEGUNDOS = 120;

const BITS_POR_SEGUNDO = 32_000;

// OGG primeiro: é o formato final, e o Firefox grava nele direto. O Chrome só
// oferece WebM; o servidor converte.
const FORMATOS = ["audio/ogg;codecs=opus", "audio/webm;codecs=opus", "audio/webm"];

function formatoSuportado(Gravador = globalThis.MediaRecorder) {
  if (!Gravador || typeof Gravador.isTypeSupported !== "function") return null;
  return FORMATOS.find((f) => Gravador.isTypeSupported(f)) || null;
}

function relogio(segundos) {
  const s = Math.max(0, Math.floor(segundos || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// A mensagem diz o que o operador pode FAZER, não o nome do erro do navegador.
function motivoDoMicrofone(erro) {
  const nome = erro?.name || "";
  if (nome === "NotAllowedError" || nome === "SecurityError") {
    return "o navegador bloqueou o microfone — libere o acesso no cadeado ao lado do endereço e tente de novo";
  }
  if (nome === "NotFoundError" || nome === "OverconstrainedError") {
    return "nenhum microfone encontrado neste computador";
  }
  if (nome === "NotReadableError") {
    return "o microfone está em uso por outro programa";
  }
  return "não foi possível usar o microfone";
}

export default function GravadorAudioWhatsApp({
  desabilitado = false,
  onEnviar,
  onOcupado,
  estilos = {},
}) {
  const [estado, setEstado] = useState("PARADO");
  const [segundos, setSegundos] = useState(0);
  const [gravacao, setGravacao] = useState(null); // { blob, url }
  const [erro, setErro] = useState("");
  const [enviando, setEnviando] = useState(false);

  const gravadorRef = useRef(null);
  const fluxoRef = useRef(null);
  const pedacosRef = useRef([]);
  const relogioRef = useRef(null);
  const canceladoRef = useRef(false);
  const urlRef = useRef(null);
  const vivoRef = useRef(true);

  const suportado = Boolean(
    globalThis.navigator?.mediaDevices?.getUserMedia && formatoSuportado(),
  );

  const soltarMicrofone = useCallback(() => {
    if (relogioRef.current) clearInterval(relogioRef.current);
    relogioRef.current = null;
    fluxoRef.current?.getTracks?.().forEach((faixa) => faixa.stop());
    fluxoRef.current = null;
  }, []);

  const soltarUrl = useCallback(() => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
  }, []);

  // Quem está em volta precisa saber se há gravação na mesa.
  useEffect(() => {
    onOcupado?.(estado !== "PARADO");
  }, [estado, onOcupado]);

  // Desmontou (trocou de conversa, fechou a tela): para tudo e não entrega nada.
  useEffect(() => {
    vivoRef.current = true;
    return () => {
      vivoRef.current = false;
      canceladoRef.current = true;
      try { gravadorRef.current?.stop?.(); } catch { /* ja estava parado */ }
      soltarMicrofone();
      soltarUrl();
    };
  }, [soltarMicrofone, soltarUrl]);

  function parar() {
    try {
      if (gravadorRef.current?.state !== "inactive") gravadorRef.current?.stop();
    } catch { /* ja estava parado */ }
  }

  async function iniciar() {
    if (desabilitado || estado !== "PARADO") return;
    setErro("");
    canceladoRef.current = false;
    pedacosRef.current = [];

    let fluxo;
    try {
      fluxo = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      setErro(motivoDoMicrofone(e));
      return;
    }
    // A permissão pode chegar depois de o operador já ter trocado de conversa.
    if (!vivoRef.current) {
      fluxo.getTracks?.().forEach((faixa) => faixa.stop());
      return;
    }
    fluxoRef.current = fluxo;

    try {
      const formato = formatoSuportado();
      const gravador = new MediaRecorder(fluxo, {
        mimeType: formato,
        audioBitsPerSecond: BITS_POR_SEGUNDO,
      });
      gravador.ondataavailable = (evento) => {
        if (evento.data?.size) pedacosRef.current.push(evento.data);
      };
      gravador.onstop = () => {
        soltarMicrofone();
        gravadorRef.current = null;
        if (!vivoRef.current) return;
        if (canceladoRef.current) {
          setEstado("PARADO");
          return;
        }
        const blob = new Blob(pedacosRef.current, { type: gravador.mimeType || formato });
        pedacosRef.current = [];
        if (!blob.size) {
          setErro("nada foi gravado — tente de novo");
          setEstado("PARADO");
          return;
        }
        soltarUrl();
        urlRef.current = URL.createObjectURL(blob);
        setGravacao({ blob, url: urlRef.current });
        setEstado("PRONTO");
      };
      gravador.onerror = () => {
        canceladoRef.current = true;
        setErro("a gravação foi interrompida — tente de novo");
        parar();
      };

      gravadorRef.current = gravador;
      gravador.start();
      const inicio = Date.now();
      setSegundos(0);
      setEstado("GRAVANDO");
      relogioRef.current = setInterval(() => {
        const passados = Math.floor((Date.now() - inicio) / 1000);
        setSegundos(passados);
        if (passados >= LIMITE_SEGUNDOS) parar();
      }, 250);
    } catch {
      soltarMicrofone();
      gravadorRef.current = null;
      setErro("não foi possível iniciar a gravação");
      setEstado("PARADO");
    }
  }

  function cancelar() {
    canceladoRef.current = true;
    parar();
  }

  function descartar() {
    soltarUrl();
    setGravacao(null);
    setErro("");
    setEstado("PARADO");
  }

  async function enviar() {
    if (!gravacao || enviando || desabilitado) return;
    setEnviando(true);
    setErro("");
    try {
      await onEnviar?.(gravacao.blob);
      if (vivoRef.current) descartar();
    } catch {
      // O motivo já está na tela, no aviso de envio da conversa. A gravação
      // FICA: o operador tenta de novo sem regravar.
    } finally {
      if (vivoRef.current) setEnviando(false);
    }
  }

  const botaoSec = estilos.botaoSec || {};
  const botaoOff = estilos.botaoOff || botaoSec;
  const botao = estilos.botao || botaoSec;

  if (estado === "GRAVANDO") {
    return (
      <div style={S.faixa} data-testid="gravador-gravando">
        <span style={S.ponto} aria-hidden="true">●</span>
        <span style={S.tempo} role="timer" aria-label="tempo de gravação">
          {relogio(segundos)} / {relogio(LIMITE_SEGUNDOS)}
        </span>
        <button type="button" style={botao} onClick={parar}>Parar</button>
        <button type="button" style={botaoSec} onClick={cancelar}>Cancelar</button>
      </div>
    );
  }

  if (estado === "PRONTO" && gravacao) {
    const travado = enviando || desabilitado;
    return (
      <div style={S.faixa} data-testid="gravador-pronto">
        <audio controls src={gravacao.url} style={S.player} />
        <button type="button" style={travado ? botaoOff : botao} disabled={travado} onClick={enviar}>
          {enviando ? "Enviando…" : "Enviar áudio"}
        </button>
        <button type="button" style={enviando ? botaoOff : botaoSec} disabled={enviando} onClick={descartar}>
          Descartar
        </button>
      </div>
    );
  }

  const indisponivel = !suportado;
  return (
    <>
      <button
        type="button"
        style={desabilitado || indisponivel ? botaoOff : botaoSec}
        disabled={desabilitado || indisponivel}
        title={
          indisponivel
            ? "Este navegador não grava áudio — use o Chrome ou o Edge atualizado"
            : `Gravar áudio (até ${LIMITE_SEGUNDOS / 60} minutos)`
        }
        onClick={iniciar}
      >
        🎤 Áudio
      </button>
      {erro ? <span style={S.erro} role="alert">{erro}</span> : null}
    </>
  );
}

const S = {
  faixa: { display: "flex", gap: 8, alignItems: "center", flex: 1, flexWrap: "wrap" },
  ponto: { color: "var(--rv-vermelho-texto)", fontSize: 14 },
  tempo: { fontVariantNumeric: "tabular-nums", fontSize: 13.5, minWidth: 92 },
  player: { height: 36, flex: 1, minWidth: 200, maxWidth: 360 },
  erro: { fontSize: 12.5, color: "var(--rv-vermelho-texto)", maxWidth: 260 },
};
