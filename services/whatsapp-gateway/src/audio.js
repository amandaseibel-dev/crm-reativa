// Áudio de SAÍDA: o que o operador grava na Central e sai como mensagem de voz.
//
// POR QUE EXISTE CONVERSÃO: o Chrome grava em WebM/Opus e o Firefox em
// OGG/Opus. O WhatsApp só mostra como MENSAGEM DE VOZ (a bolinha com o
// microfone) o que chega em OGG/Opus mono. WebM mandado direto vira um arquivo
// que o celular do aluno não toca. Um caminho só para os dois navegadores: tudo
// passa pelo ffmpeg e sai no mesmo formato.
//
// POR QUE OS BYTES VÊM NO CORPO, e não por URL como o PDF: o bucket do CRM não
// aceita `audio/webm`, e o que precisa ficar guardado é o OGG que o aluno
// recebeu, não o rascunho do navegador. Um áudio de voz de 2 minutos tem
// algumas centenas de KB — cabe no mesmo teto de 1 MB que a API de controle já
// impõe a todo corpo.
import { spawn } from "node:child_process";

// Mesmo número do `lerCorpo` do servidor e do validador da Edge
// (supabase/functions/_shared/audio.ts). Repetido de propósito: são processos
// diferentes. O teste confere que não divergiu calado.
export const LIMITE_AUDIO_BYTES = 1_000_000;

// Corte duro de duração, feito pelo próprio ffmpeg. A tela para a gravação em
// 2 minutos; isto existe para o caso de alguém chegar aqui sem passar pela tela.
export const LIMITE_AUDIO_SEGUNDOS = 180;

export const MIME_VOZ = "audio/ogg; codecs=opus";

const ARGUMENTOS = [
  "-hide_banner", "-loglevel", "error",
  "-i", "pipe:0",
  "-vn", "-map_metadata", "-1",
  "-ac", "1", "-ar", "48000",
  "-c:a", "libopus", "-b:a", "32k", "-application", "voip",
  "-t", String(LIMITE_AUDIO_SEGUNDOS),
  "-f", "ogg", "pipe:1",
];

export function ehOgg(dados) {
  return dados.length >= 4
    && dados[0] === 0x4f && dados[1] === 0x67 && dados[2] === 0x67 && dados[3] === 0x53;
}

// EBML — o cabeçalho de todo WebM/Matroska.
export function ehWebm(dados) {
  return dados.length >= 4
    && dados[0] === 0x1a && dados[1] === 0x45 && dados[2] === 0xdf && dados[3] === 0xa3;
}

// O tipo é decidido pelos BYTES, como no PDF. Lista fechada: só o que o
// gravador do navegador produz.
export function formatoDoAudio(dados) {
  if (!dados || dados.length < 4) return null;
  if (ehOgg(dados)) return "ogg";
  if (ehWebm(dados)) return "webm";
  return null;
}

// Duração do OGG/Opus, lida da última página: a posição de grânulo conta
// amostras a 48 kHz. Serve para o WhatsApp mostrar "0:12" na mensagem de voz.
// Devolve null quando não dá para ler — a mensagem sai do mesmo jeito.
export function duracaoOggSegundos(dados) {
  const ultima = dados.lastIndexOf("OggS");
  if (ultima < 0 || dados.length < ultima + 14) return null;
  const granulo = dados.readBigUInt64LE(ultima + 6);
  // 0xFFFFFFFFFFFFFFFF = página sem pacote terminado.
  if (granulo === 0xffffffffffffffffn) return null;
  const segundos = Math.ceil(Number(granulo) / 48000);
  return segundos > 0 && segundos < 24 * 3600 ? segundos : null;
}

// Converte o que veio do navegador em OGG/Opus mono.
//
// `gerar` é a costura de teste: a máquina de quem desenvolve pode não ter
// ffmpeg, e o que importa provar aqui é o tratamento de falha — conversão que
// falha NÃO pode virar mensagem.
export function converterParaOggOpus(dados, { gerar = spawn, tempoLimiteMs = 20_000 } = {}) {
  return new Promise((resolver, rejeitar) => {
    let processo;
    try {
      processo = gerar("ffmpeg", ARGUMENTOS, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (erro) {
      rejeitar(new Error(`conversor de audio indisponivel: ${erro?.message || erro}`));
      return;
    }

    const saida = [];
    let queixa = "";
    let encerrado = false;
    const fim = (fn, valor) => {
      if (encerrado) return;
      encerrado = true;
      clearTimeout(relogio);
      fn(valor);
    };

    const relogio = setTimeout(() => {
      try { processo.kill("SIGKILL"); } catch { /* ja morreu */ }
      fim(rejeitar, new Error("conversao do audio demorou demais"));
    }, tempoLimiteMs);

    processo.stdout.on("data", (parte) => saida.push(parte));
    processo.stderr.on("data", (parte) => { queixa += String(parte).slice(0, 500); });
    processo.on("error", (erro) => {
      fim(rejeitar, new Error(`conversor de audio indisponivel: ${erro?.message || erro}`));
    });
    processo.on("close", (codigo) => {
      if (codigo !== 0) {
        fim(rejeitar, new Error(`nao foi possivel converter o audio (${queixa.trim() || `codigo ${codigo}`})`));
        return;
      }
      const ogg = Buffer.concat(saida);
      if (!ehOgg(ogg)) {
        fim(rejeitar, new Error("a conversao nao devolveu um audio valido"));
        return;
      }
      fim(resolver, ogg);
    });

    // Se o ffmpeg recusar a entrada e fechar cedo, a escrita devolve EPIPE. O
    // motivo de verdade já chega pelo `close`; este erro é só o eco.
    processo.stdin.on("error", () => {});
    processo.stdin.end(dados);
  });
}
