// Fila em disco — a rede de segurança do requisito "não perder contato".
//
// POR QUE EXISTE: se o Supabase piscar, se a internet da VPS cair por um
// minuto, se a Edge Function der 500 — a mensagem que o aluno acabou de mandar
// NÃO PODE evaporar. Ela é gravada em disco antes de qualquer tentativa de
// envio, e só é apagada depois que o CRM confirma que gravou.
//
// Um arquivo por evento, nome ordenável por tempo. É o mecanismo mais simples
// que sobrevive a `docker restart` no meio do caminho — e simples, aqui, vale
// mais do que rápido.
//
// NÃO é armazenamento de histórico: o arquivo vive segundos e é apagado assim
// que o CRM confirma. O espelho continua sem guardar conversa.
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { chamar } from "./crm.js";
import { log } from "./log.js";

const DIR = join(config.dadosDir, "fila");
mkdirSync(DIR, { recursive: true });

let contador = 0;
let rodando = false;
let intervalo = config.backoffInicialMs;

export function enfileirar(acao, dados) {
  const nome = `${Date.now().toString().padStart(14, "0")}-${String(++contador).padStart(6, "0")}.json`;
  const destino = join(DIR, nome);
  const temporario = destino + ".tmp";
  // Escreve e renomeia: renomear é atômico, então nunca existe na fila um
  // arquivo pela metade que o worker tentaria enviar.
  writeFileSync(temporario, JSON.stringify({ acao, dados }));
  renameSync(temporario, destino);
  return nome;
}

export function tamanhoDaFila() {
  try {
    return readdirSync(DIR).filter((n) => n.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

async function drenar() {
  const arquivos = readdirSync(DIR).filter((n) => n.endsWith(".json")).sort();
  if (arquivos.length === 0) {
    intervalo = config.backoffInicialMs;
    return;
  }

  for (const nome of arquivos) {
    const caminho = join(DIR, nome);
    let evento;
    try {
      evento = JSON.parse(readFileSync(caminho, "utf8"));
    } catch {
      // Arquivo corrompido não pode travar a fila para sempre.
      log.error({ nome }, "evento ilegivel na fila - descartado");
      unlinkSync(caminho);
      continue;
    }

    try {
      await chamar(evento.acao, evento.dados, { tentativas: 2 });
      unlinkSync(caminho);
      intervalo = config.backoffInicialMs;
    } catch (erro) {
      // Para no primeiro que falhar: manter a ORDEM importa mais do que
      // adiantar os próximos, e insistir em fila cheia só piora.
      intervalo = Math.min(intervalo * 2, config.backoffMaximoMs);
      log.warn(
        { pendentes: arquivos.length, proximaTentativaMs: intervalo, erro: String(erro?.message || erro) },
        "fila represada - o CRM nao esta aceitando",
      );
      return;
    }
  }
}

export function iniciarFila() {
  if (rodando) return;
  rodando = true;

  const ciclo = async () => {
    try {
      await drenar();
    } catch (erro) {
      log.error({ erro: String(erro?.message || erro) }, "erro inesperado drenando a fila");
    }
    setTimeout(ciclo, intervalo);
  };

  ciclo();
  log.info({ pendentes: tamanhoDaFila() }, "fila de reenvio iniciada");
}
