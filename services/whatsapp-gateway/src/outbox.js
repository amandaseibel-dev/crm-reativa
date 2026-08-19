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

// QUARENTENA — o conserto do incidente de 2026-08-19.
//
// A fila para no primeiro item que falha, de propósito: manter a ORDEM importa.
// Mas isso pressupõe que todo item, cedo ou tarde, passa. Um item que o CRM vai
// recusar PARA SEMPRE — telefone inválido, por exemplo — congelava tudo atrás
// dele, inclusive mensagem real de aluno e o fechamento da sincronização.
//
// Agora, item recusado pelo CRM repetidamente sai da frente e vai para cá. NÃO
// é apagado: fica em disco, com o motivo ao lado, para poder ser reprocessado
// depois de corrigida a causa. A fila volta a andar.
//
// O que NUNCA vai para a quarentena: falha de rede, timeout, CRM fora do ar.
// Nesses casos o item continua na fila, tentando — que é o comportamento que
// garante "não perder contato".
const QUARENTENA = join(config.dadosDir, "quarentena");
mkdirSync(QUARENTENA, { recursive: true });

let contador = 0;
let rodando = false;
let intervalo = config.backoffInicialMs;

// Quantas vezes seguidas o MESMO item pode ser recusado antes de sair da frente.
const falhasPorItem = new Map();

// Quem leva o evento ao CRM. Indireção existe para o teste poder substituir.
let entregar = chamar;

// Recusa do CRM (ele recebeu, entendeu e disse não) x falha de infraestrutura.
// Só a primeira justifica quarentena: a segunda melhora sozinha.
function recusaDoCrm(erro) {
  const m = String(erro?.message || erro);
  return /^HTTP \d{3}: /.test(m) && /"erro"\s*:/.test(m);
}

export function tamanhoDaQuarentena() {
  try {
    return readdirSync(QUARENTENA).filter((n) => n.endsWith(".json") && !n.endsWith(".motivo.json")).length;
  } catch {
    return 0;
  }
}

function quarentenar(nome, caminho, evento, erro) {
  const destino = join(QUARENTENA, nome);
  renameSync(caminho, destino);
  writeFileSync(destino.replace(/\.json$/, ".motivo.json"), JSON.stringify({
    quarentenadoEm: new Date().toISOString(),
    tentativas: config.tentativasAntesDeQuarentena,
    acao: evento?.acao ?? null,
    erro: String(erro?.message || erro).slice(0, 500),
  }, null, 2));
  falhasPorItem.delete(nome);
  log.error(
    { nome, acao: evento?.acao, erro: String(erro?.message || erro).slice(0, 200),
      quarentena: tamanhoDaQuarentena() },
    "item recusado pelo CRM foi para a quarentena - a fila segue (nada foi apagado)",
  );
}

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

// Exportados só para teste. O ciclo real é temporizado e fala com o CRM de
// verdade; um teste que dependesse de timer e de rede seria lento e instável —
// e esta fila é justamente a peça que não pode ter comportamento incerto.
export const _drenarParaTeste = () => drenar();
export function _usarEntregadorParaTeste(fn) {
  entregar = fn || chamar;
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
      await entregar(evento.acao, evento.dados, { tentativas: 2 });
      unlinkSync(caminho);
      falhasPorItem.delete(nome);
      intervalo = config.backoffInicialMs;
    } catch (erro) {
      // Recusa do CRM que se repete = item impossível. Sai da frente para a
      // quarentena e a fila continua, em vez de congelar tudo atrás dele.
      if (recusaDoCrm(erro)) {
        const n = (falhasPorItem.get(nome) || 0) + 1;
        falhasPorItem.set(nome, n);
        if (n >= config.tentativasAntesDeQuarentena) {
          quarentenar(nome, caminho, evento, erro);
          // Tirar o item da frente É progresso: a espera volta ao início. Sem
          // isto, cada item impossível herdava o backoff do anterior e a fila
          // levava dez minutos para andar um passo — justamente quando há
          // mensagem real esperando atrás.
          intervalo = config.backoffInicialMs;
          continue;
        }
      }

      // Falha de infraestrutura (ou recusa ainda dentro do limite): para aqui.
      // Manter a ORDEM importa mais do que adiantar os próximos, e insistir em
      // fila cheia só piora.
      intervalo = Math.min(intervalo * 2, config.backoffMaximoMs);
      log.warn(
        { pendentes: arquivos.length, proximaTentativaMs: intervalo,
          tentativasDesteItem: falhasPorItem.get(nome) || 0,
          erro: String(erro?.message || erro) },
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
