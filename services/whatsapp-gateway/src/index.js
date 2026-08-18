// Ponto de entrada. Sobe as sessões, o batimento e o vigia.
//
// PREMISSA DO SERVIÇO: websocket aberto NÃO é garantia de sessão viva. A
// conexão pode ficar de pé e parar de entregar; o processo pode travar sem
// morrer. Por isso existe vigia, e por isso o CRM só acredita em "conectado"
// enquanto o batimento chega.
import { config } from "./config.js";
import { log } from "./log.js";
import { iniciarFila, tamanhoDaFila } from "./outbox.js";
import { criarSessao } from "./sessao.js";
import { iniciarServidor } from "./servidor.js";

// Tempo fora do ar que dispara reinício forçado da sessão. Não vale para quem
// está esperando QR: ali o problema é humano, e reiniciar só troca o código na
// tela de quem foi ler.
const LIMITE_FORA_DO_AR_MS = 10 * 60_000;

const sessoes = config.sessoes.map(({ chave }) => criarSessao({ chave }));
const foraDoArDesde = new Map();

async function principal() {
  log.info(
    { sessoes: config.sessoes.map((s) => s.chave), filaPendente: tamanhoDaFila() },
    "subindo o espelho do WhatsApp",
  );

  iniciarFila();
  const servidor = iniciarServidor(sessoes);

  for (const sessao of sessoes) {
    sessao.iniciar().catch((erro) => {
      log.error({ sessao: sessao.chave, erro: String(erro?.message || erro) }, "falha ao iniciar sessao");
    });
  }

  const batimento = setInterval(() => {
    for (const sessao of sessoes) {
      sessao.baterCoracao();

      const st = sessao.estado();
      const esperandoHumano = st.status === "AGUARDANDO_QR" || st.status === "PAREAMENTO_NECESSARIO";

      if (st.conectado || esperandoHumano) {
        foraDoArDesde.delete(sessao.chave);
        continue;
      }

      const desde = foraDoArDesde.get(sessao.chave);
      if (!desde) {
        foraDoArDesde.set(sessao.chave, Date.now());
        continue;
      }

      if (Date.now() - desde > LIMITE_FORA_DO_AR_MS) {
        log.error({ sessao: sessao.chave, status: st.status }, "vigia: fora do ar demais - reiniciando a sessao");
        foraDoArDesde.set(sessao.chave, Date.now());
        sessao.reconectar().catch((erro) =>
          log.error({ sessao: sessao.chave, erro: String(erro?.message || erro) }, "vigia: reinicio falhou"),
        );
      }
    }
  }, config.heartbeatSeg * 1000);

  // Encerramento limpo: descarrega credencial pendente antes de morrer. Sem
  // isto, um `docker restart` no momento errado deixa a sessão com credencial
  // desatualizada — e credencial desatualizada é QR novo.
  const encerrar = async (sinal) => {
    log.info({ sinal }, "encerrando");
    clearInterval(batimento);
    servidor.close();
    await Promise.allSettled(sessoes.map((s) => s.encerrar()));
    process.exit(0);
  };

  process.on("SIGTERM", () => encerrar("SIGTERM"));
  process.on("SIGINT", () => encerrar("SIGINT"));

  // Erro não tratado não pode matar o processo em silêncio: o container
  // reiniciaria sem ninguém entender o motivo.
  process.on("unhandledRejection", (erro) => {
    log.error({ erro: String(erro?.message || erro) }, "promessa rejeitada sem tratamento");
  });
  process.on("uncaughtException", (erro) => {
    log.error({ erro: String(erro?.message || erro), pilha: erro?.stack }, "excecao nao capturada");
  });
}

principal().catch((erro) => {
  log.fatal({ erro: String(erro?.message || erro) }, "nao foi possivel subir o servico");
  process.exit(1);
});
