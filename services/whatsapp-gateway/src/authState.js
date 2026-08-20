// Persistência das credenciais da sessão — em Postgres, não em arquivo solto.
//
// POR QUE NÃO `useMultiFileAuthState`: ele é exemplo de documentação. Guarda a
// sessão em arquivos no disco local, some quando o container é recriado sem
// volume, não sobrevive a troca de máquina e não tem cópia. E perder a
// credencial não é só "escanear de novo": reparear consome a ÚNICA chance de
// sincronização inicial daquele número, porque o WhatsApp entrega histórico uma
// vez só, no pareamento.
//
// COMO FUNCIONA AQUI, e por que nesta ordem:
//   1. O disco do container é a cópia quente (rápida, sempre disponível).
//   2. O Postgres é a cópia fria, para VPS nova ou volume perdido.
//   Grava-se SEMPRE no disco primeiro e no banco depois. Isso cria uma
//   invariante simples: o disco nunca está mais velho que o banco. Por isso a
//   leitura de partida prefere o disco e só cai no banco quando não há disco —
//   se fosse o contrário, uma gravação falha no banco faria o serviço subir com
//   credencial velha e derrubar a sessão.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { BufferJSON, initAuthCreds, proto } from "baileys";
import { config } from "./config.js";
import { chamar } from "./crm.js";
import { logSessao } from "./log.js";

// A credencial É a sessão do WhatsApp. Quem lê este arquivo clona o número:
// manda mensagem como a empresa e lê tudo que chega. Não é "config sensível",
// é a chave da conta.
//
// POR QUE MODO EXPLÍCITO E NÃO `chmod` MANUAL: o arquivo é reescrito a cada
// atualização de chave — centenas de vezes por minuto durante um sync. Um
// `chmod` de uma vez é desfeito na gravação seguinte, porque o arquivo novo
// nasce com o modo padrão do processo (0666 & ~umask = 0644 no launchd).
// Então o modo entra em TODA criação, e é reforçado após o rename.
const MODO_ARQUIVO = 0o600;
const MODO_DIR = 0o700;

const DIR = join(config.dadosDir, "sessoes");
mkdirSync(DIR, { recursive: true, mode: MODO_DIR });
// `mkdirSync` não altera diretório que já existe: garante o modo de qualquer jeito.
try {
  chmodSync(DIR, MODO_DIR);
} catch {
  /* sem permissão para ajustar: melhor seguir do que não subir */
}

const arquivoDe = (chave) => join(DIR, `${chave}.json`);

function gravarDisco(chave, estado) {
  const destino = arquivoDe(chave);
  const temporario = destino + ".tmp";
  // `mode` vale só na CRIAÇÃO — por isso o temporário é sempre novo, e por
  // isso o `chmod` depois do rename fecha o caso do arquivo que já existia
  // com modo frouxo (é o estado em que os dois canais estavam em 20/08).
  writeFileSync(temporario, JSON.stringify(estado, BufferJSON.replacer), { mode: MODO_ARQUIVO });
  renameSync(temporario, destino); // atômico: nunca fica um estado pela metade
  try {
    chmodSync(destino, MODO_ARQUIVO);
  } catch {
    /* o conteúdo já está salvo; permissão é reforço */
  }
}

function lerDisco(chave) {
  const caminho = arquivoDe(chave);
  if (!existsSync(caminho)) return null;
  try {
    return JSON.parse(readFileSync(caminho, "utf8"), BufferJSON.reviver);
  } catch {
    return null;
  }
}

async function lerBanco(chave) {
  const r = await chamar("estado.ler", { sessao: chave });
  if (!r?.estado) return null;
  try {
    return JSON.parse(r.estado, BufferJSON.reviver);
  } catch {
    return null;
  }
}

export async function usarAuthStatePostgres(chave) {
  const log = logSessao(chave);

  let estado = lerDisco(chave);
  if (estado) {
    log.info("credencial recuperada do disco do container");
  } else {
    try {
      estado = await lerBanco(chave);
      if (estado) log.info("credencial recuperada do banco (disco vazio)");
    } catch {
      log.error("nao foi possivel consultar a credencial no banco");
    }
  }

  if (!estado) {
    estado = { creds: initAuthCreds(), chaves: {} };
    log.warn("sem credencial: esta sessao vai precisar de QR Code");
  }
  if (!estado.chaves) estado.chaves = {};

  let pendente = null;
  let gravandoBanco = false;
  let precisaRegravar = false;

  async function sincronizarBanco() {
    if (gravandoBanco) {
      precisaRegravar = true;
      return;
    }
    gravandoBanco = true;
    try {
      await chamar("estado.gravar", {
        sessao: chave,
        estado: JSON.stringify(estado, BufferJSON.replacer),
      });
    } catch (erro) {
      // Não é fatal: o disco já tem. Mas precisa gritar, porque significa que
      // uma VPS nova não conseguiria restaurar esta sessão.
      log.error({ erro: String(erro?.message || erro) }, "credencial NAO foi copiada para o banco");
    } finally {
      gravandoBanco = false;
      if (precisaRegravar) {
        precisaRegravar = false;
        sincronizarBanco();
      }
    }
  }

  // Agrupa as gravações: durante a sincronização inicial as chaves mudam
  // centenas de vezes por segundo, e uma escrita por mudança derrubaria o
  // serviço de I/O sem nenhum ganho.
  function agendarGravacao({ imediato = false } = {}) {
    gravarDisco(chave, estado);
    if (pendente) clearTimeout(pendente);
    if (imediato) {
      sincronizarBanco();
      return;
    }
    pendente = setTimeout(() => {
      pendente = null;
      sincronizarBanco();
    }, 1500);
  }

  const state = {
    creds: estado.creds,
    keys: {
      get: async (tipo, ids) => {
        const balde = estado.chaves[tipo] || {};
        const saida = {};
        for (const id of ids) {
          let valor = balde[id];
          // A chave de app-state precisa voltar como objeto do protocolo, não
          // como JSON cru, senão a sincronização de histórico falha calada.
          if (tipo === "app-state-sync-key" && valor) {
            valor = proto.Message.AppStateSyncKeyData.fromObject(valor);
          }
          if (valor !== undefined) saida[id] = valor;
        }
        return saida;
      },
      set: async (dados) => {
        for (const tipo of Object.keys(dados)) {
          estado.chaves[tipo] = estado.chaves[tipo] || {};
          for (const id of Object.keys(dados[tipo])) {
            const valor = dados[tipo][id];
            if (valor === null || valor === undefined) delete estado.chaves[tipo][id];
            else estado.chaves[tipo][id] = valor;
          }
        }
        agendarGravacao();
      },
    },
  };

  return {
    state,
    // O store de chaves cru, para quem precisa LER o que a Baileys persistiu —
    // hoje, o `lid-mapping` do Baileys 7, que é onde mora o vínculo
    // LID<->telefone autoritativo. A interface `state.keys.get` exige saber os
    // ids de antemão; aqui o interesse é justamente varrer o balde inteiro.
    chavesBrutas: () => estado.chaves,
    // Credencial é o dado que não pode atrasar: vai para o banco na hora.
    salvarCredenciais: () => agendarGravacao({ imediato: true }),
    // Chamado no encerramento: garante que nada fique preso no agrupamento.
    descarregar: async () => {
      if (pendente) clearTimeout(pendente);
      gravarDisco(chave, estado);
      await sincronizarBanco();
    },
    // Logout de verdade: a credencial morreu, apagar dos dois lados. Deixar
    // sobra faria o serviço tentar reconectar para sempre com uma sessão que o
    // WhatsApp já derrubou.
    apagar: async () => {
      if (pendente) clearTimeout(pendente);
      estado = { creds: initAuthCreds(), chaves: {} };
      try {
        unlinkSync(arquivoDe(chave));
      } catch {
        /* nao existia */
      }
      try {
        await chamar("estado.apagar", { sessao: chave });
      } catch (erro) {
        log.error({ erro: String(erro?.message || erro) }, "falha ao apagar credencial no banco");
      }
    },
  };
}
