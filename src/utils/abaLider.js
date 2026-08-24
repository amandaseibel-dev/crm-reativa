// Controle de aba única do ReATIVA.
//
// Objetivo: garantir que só uma aba operacional por usuário e navegador monte
// o CRM. As demais abas ficam bloqueadas, sem polling/realtime/heartbeat.
//
// Estratégia:
//  - eleição de líder coordenada por BroadcastChannel (quando disponível),
//    com fallback puro em localStorage (storage events);
//  - escopo por session.user.id: canal e chaves são namespaced pelo id do
//    usuário. NUNCA usamos nome, CPF, telefone ou e-mail;
//  - a líder mantém um heartbeat (~5s) apenas para renovar o registro; ela
//    revalida a posse ANTES de cada renovação (se perdeu a posse, recua na
//    hora, sem efeitos);
//  - liberação da liderança acontece de forma EXPLÍCITA (fechamento normal via
//    pagehide/beforeunload, que remove o registro) ou por transferência
//    ("Usar esta aba"). Uma secundária NÃO assume só porque o registro ficou
//    velho: navegadores congelam timers de abas ocultas e uma líder ainda viva
//    (apenas em segundo plano) não pode perder a liderança por expiração.
//
// Failover:
//  - fechamento normal da líder -> registro removido (null) -> a secundária
//    assume em ~1s (evento de storage / broadcast "lider-saiu");
//  - travamento abrupto (registro velho, mas presente) -> NENHUMA assunção
//    automática; a secundária apenas sinaliza que a outra aba PODE ter sido
//    encerrada e oferece o botão "Usar esta aba" (o clique revalida e
//    transfere a liderança).
//
// Nunca usamos visibilitychange para liberar ou transferir liderança.
//
// Este módulo é agnóstico de React. O provider (AbaLiderContext) o consome.

export const HEARTBEAT_MS = 5000; // heartbeat da líder (~5s)
export const EXPIRACAO_MS = 25000; // idade a partir da qual o registro "parece" expirado
const CLAIM_JITTER_MS = 120; // janela de desempate após um claim
const MONITOR_MS = 3000; // varredura local da secundária (sem rede)

// REGISTRO ÓRFÃO — o único caso em que a assunção automática é permitida.
//
// O problema real (19/08/2026): o Mac reiniciou e o Chrome morreu sem rodar
// `pagehide`/`beforeunload`. O registro da líder ficou no localStorage sem dono.
// Como a regra acima proíbe assumir por expiração, TODA aba nova ficava
// bloqueada para sempre — o CRM inteiro deixou de montar, e de fora parecia
// "a Central não carrega as mensagens".
//
// A saída não pode ser afrouxar a expiração de 25s: ela existe justamente para
// não roubar a liderança de uma aba viva com timers congelados em segundo plano.
// Então usamos um limite MUITO maior e, antes de assumir, PERGUNTAMOS.
//
// 5 minutos é folgado de propósito: a líder renova a cada 5s, então um registro
// com 60x essa idade só sobrevive se ninguém o estiver renovando. E mesmo assim
// a assunção só acontece depois de a sonda não achar ninguém vivo.
export const ORFAO_MS = 300000; // 5 min sem renovação = candidato a órfão
const SONDA_MS = 700; // janela de resposta da sonda "quem-e-lider"

function agora() {
  return Date.now();
}

// Gera um id de aba estável para a vida desta aba. Não identifica o usuário.
function gerarTabId() {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }
  } catch (e) {
    /* ignore */
  }
  return `${agora().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

// Verifica se o localStorage está realmente disponível (modo privado do Safari,
// storage desabilitado, cota zero, etc. podem lançar).
function localStorageDisponivel() {
  try {
    const k = "__reativa_abalider_probe__";
    window.localStorage.setItem(k, "1");
    window.localStorage.removeItem(k);
    return true;
  } catch (e) {
    return false;
  }
}

// Controlador de eleição para um dado escopo (userId). Uma instância por aba.
export function criarControleAbaLider(scopeId, opcoes = {}) {
  const onMudanca = typeof opcoes.onMudanca === "function" ? opcoes.onMudanca : () => {};

  const tabId = gerarTabId();
  const temStorage = localStorageDisponivel();

  // Sem storage: modo degradado. Não conseguimos coordenar entre abas, então
  // NÃO bloqueamos ninguém — esta aba é tratada como líder.
  const chaveLider = `reativa_aba_lider__${scopeId}`;
  const nomeCanal = `reativa_aba_lider__${scopeId}`;

  let ehLider = false;
  let destruido = false;
  // Sinaliza que o registro de outra aba está velho o bastante para PARECER
  // encerrada (travamento). Nunca dispara assunção automática — só habilita a
  // mensagem/CTA "Usar esta aba" na secundária.
  let pareceExpirada = false;
  let heartbeatTimer = null;
  let monitorTimer = null;
  let bc = null;
  // Sonda de órfão em andamento (evita empilhar sondas a cada varredura) e
  // sinal de que ALGUÉM vivo respondeu enquanto ela corria.
  let sondando = false;
  let respostaViva = false;
  let sondaTimer = null;

  function estado() {
    return {
      ehLider,
      degradado: !temStorage,
      pareceExpirada: !ehLider && pareceExpirada,
      tabId,
    };
  }

  function notificar() {
    if (destruido) return;
    onMudanca(estado());
  }

  function lerRegistro() {
    if (!temStorage) return null;
    try {
      const bruto = window.localStorage.getItem(chaveLider);
      if (!bruto) return null;
      const obj = JSON.parse(bruto);
      if (!obj || typeof obj !== "object") return null;
      return obj;
    } catch (e) {
      return null;
    }
  }

  function gravarRegistro(reg) {
    if (!temStorage) return;
    try {
      window.localStorage.setItem(chaveLider, JSON.stringify(reg));
    } catch (e) {
      /* ignore */
    }
  }

  function registroExpirado(reg) {
    if (!reg || typeof reg.ts !== "number") return true;
    return agora() - reg.ts > EXPIRACAO_MS;
  }

  function souDonoDoRegistro(reg) {
    return reg && reg.tabId === tabId;
  }

  function registroOrfao(reg) {
    if (!reg || typeof reg.ts !== "number") return false;
    return agora() - reg.ts > ORFAO_MS;
  }

  // Pergunta "tem alguém vivo aí?" antes de assumir um registro que parece
  // abandonado. Só assume se NINGUÉM responder e o registro continuar
  // exatamente como estava — duas evidências independentes de que não há líder:
  //
  //   1. ninguém respondeu à sonda pelo BroadcastChannel;
  //   2. o registro não foi tocado durante a janela — uma líder viva o renova a
  //      cada 5s, então mexer nele é prova de vida mesmo sem BroadcastChannel.
  //
  // A segunda condição é o que mantém a proteção quando o BroadcastChannel não
  // existe (navegador antigo, contexto restrito): sem ela, "ninguém respondeu"
  // seria trivialmente verdade e a sonda viraria um takeover cego.
  function sondarSeOrfao(reg) {
    if (destruido || ehLider || sondando || !temStorage) return;
    if (!reg || souDonoDoRegistro(reg) || !registroOrfao(reg)) return;

    sondando = true;
    respostaViva = false;
    const donoAntes = reg.tabId;
    const tsAntes = reg.ts;

    postar("quem-e-lider");

    sondaTimer = setTimeout(() => {
      sondaTimer = null;
      sondando = false;
      if (destruido || ehLider) return;

      // Alguém vivo se manifestou: não há órfão nenhum.
      if (respostaViva) return;

      const atual = lerRegistro();
      // Registro liberado no meio da sonda: é o failover normal, sem forçar.
      if (!atual) {
        tentarAssumir();
        return;
      }
      // Mexeram no registro: há líder viva renovando. Recua.
      if (atual.tabId !== donoAntes || atual.ts !== tsAntes) return;
      // Envelheceu ainda mais e ninguém apareceu: assume.
      if (!registroOrfao(atual)) return;
      tentarAssumir(true);
    }, SONDA_MS);
  }

  function postar(tipo) {
    if (!bc) return;
    try {
      bc.postMessage({ tipo, tabId, ts: agora() });
    } catch (e) {
      /* ignore */
    }
  }

  function setPareceExpirada(valor) {
    const v = Boolean(valor);
    if (pareceExpirada !== v) {
      pareceExpirada = v;
      notificar();
    }
  }

  function recuarParaSecundaria() {
    if (!ehLider) return;
    ehLider = false;
    pararHeartbeat();
    notificar();
  }

  // Tenta assumir a liderança. IMPORTANTE: a assunção só é permitida quando o
  // registro está livre (null), quando já é meu, ou quando forçada pelo botão
  // "Usar esta aba". A simples expiração (registro velho, mas presente) NÃO
  // autoriza assumir — isso é o que impede uma líder viva em segundo plano de
  // perder a liderança por congelamento de timers.
  function tentarAssumir(forcar = false) {
    if (destruido) return;
    if (!temStorage) {
      // Modo degradado: sempre líder.
      if (!ehLider) {
        ehLider = true;
        notificar();
      }
      return;
    }

    const atual = lerRegistro();
    const podeAssumir = forcar || !atual || souDonoDoRegistro(atual);

    if (!podeAssumir) {
      if (ehLider) recuarParaSecundaria();
      return;
    }

    // Claim: grava minha marca.
    const marca = { tabId, ts: agora(), claim: true };
    gravarRegistro(marca);

    // Desempate: espera uma janela curta e relê. Se outra aba gravou depois
    // (ts maior, ou ts igual e tabId "vence"), eu recuo.
    setTimeout(() => {
      if (destruido) return;
      const reconf = lerRegistro();
      if (!reconf) {
        // Ninguém — grava de novo e assume.
        virarLider();
        return;
      }
      const souEu = reconf.tabId === tabId;
      if (souEu) {
        virarLider();
        return;
      }
      // Outra aba está no registro. Desempate determinístico: menor tabId vence
      // quando os timestamps empatam; caso contrário, o mais recente vence.
      const meuTs = marca.ts;
      const outroTs = typeof reconf.ts === "number" ? reconf.ts : 0;
      let euVenco;
      if (outroTs === meuTs) {
        euVenco = tabId < reconf.tabId;
      } else {
        euVenco = meuTs > outroTs;
      }
      // Só desempato contra um claim concorrente (corrida de assunção). Se há
      // uma líder estabelecida que não é minha, eu recuo — nunca a substituo por
      // expiração aqui.
      if (euVenco && reconf.claim) {
        virarLider();
      } else if (forcar && euVenco) {
        virarLider();
      } else {
        if (ehLider) recuarParaSecundaria();
      }
    }, CLAIM_JITTER_MS);
  }

  function virarLider() {
    if (destruido) return;
    const jaEra = ehLider;
    ehLider = true;
    pareceExpirada = false;
    gravarRegistro({ tabId, ts: agora() });
    iniciarHeartbeat();
    postar("lider-assumiu");
    if (!jaEra) notificar();
  }

  function iniciarHeartbeat() {
    pararHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (destruido || !ehLider) return;
      // Revalida a posse ANTES de renovar. Se uma antiga líder volta de um
      // congelamento e o registro já pertence a outra aba (ex.: transferência
      // por "Usar esta aba"), ela recua imediatamente, sem sobrescrever nada e
      // sem executar nenhum efeito.
      const reg = lerRegistro();
      if (reg && !souDonoDoRegistro(reg)) {
        recuarParaSecundaria();
        return;
      }
      gravarRegistro({ tabId, ts: agora() });
      postar("heartbeat");
    }, HEARTBEAT_MS);
  }

  function pararHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  // Monitor local da secundária: SEM rede. Só lê o localStorage para:
  //  - assumir rapidamente quando a líder liberou o registro (null) — failover
  //    de fechamento normal, caso o evento de storage não chegue;
  //  - sinalizar "pareceExpirada" quando o registro de outra aba ficou velho
  //    (possível travamento), habilitando a mensagem/CTA — SEM assumir.
  function iniciarMonitor() {
    if (!temStorage) return;
    monitorTimer = setInterval(() => {
      if (destruido || ehLider) return;
      const reg = lerRegistro();
      if (!reg) {
        // Registro liberado explicitamente (fechamento normal): failover.
        setPareceExpirada(false);
        tentarAssumir();
        return;
      }
      if (!souDonoDoRegistro(reg) && registroExpirado(reg)) {
        setPareceExpirada(true); // pode ter travado — oferece "Usar esta aba"
        // Muito além de qualquer congelamento plausível: checa se sobrou órfão
        // de um crash/reboot e, se ninguém responder, destrava sozinha.
        sondarSeOrfao(reg);
      } else {
        setPareceExpirada(false); // líder viva/recente
      }
    }, MONITOR_MS);
  }

  function pararMonitor() {
    if (monitorTimer) {
      clearInterval(monitorTimer);
      monitorTimer = null;
    }
  }

  function aoReceberMensagem(ev) {
    if (destruido) return;
    const msg = ev && ev.data;
    if (!msg || msg.tabId === tabId) return;
    if (msg.tipo === "quem-e-lider") {
      if (ehLider) {
        gravarRegistro({ tabId, ts: agora() });
        postar("lider-assumiu");
      }
      return;
    }
    if (msg.tipo === "lider-assumiu" || msg.tipo === "heartbeat") {
      // Outra aba é líder e está viva. Se eu achava que era, recuo (a menos que
      // o registro ainda seja meu). Limpa qualquer aviso de expiração.
      // Também é a RESPOSTA da sonda de órfão: prova de vida, cancela o
      // takeover automático.
      respostaViva = true;
      setPareceExpirada(false);
      if (ehLider) {
        const reg = lerRegistro();
        if (!souDonoDoRegistro(reg)) recuarParaSecundaria();
      }
      return;
    }
    if (msg.tipo === "lider-saiu") {
      // A líder fechou normalmente. Uma secundária assume (failover ~1s).
      if (!ehLider) {
        setPareceExpirada(false);
        tentarAssumir();
      }
      return;
    }
    if (msg.tipo === "assumir-forcado") {
      // Outra aba pediu para assumir (botão "Usar esta aba"). Eu abro mão.
      if (ehLider) recuarParaSecundaria();
      return;
    }
  }

  function aoMudarStorage(ev) {
    if (destruido || !temStorage) return;
    if (ev.key !== chaveLider) return;
    const reg = lerRegistro();

    if (ehLider) {
      // Perdi a posse para outra aba (transferência forçada). Recuo.
      if (reg && !souDonoDoRegistro(reg)) recuarParaSecundaria();
      return;
    }

    if (!reg) {
      // Registro removido: fechamento normal da líder -> failover ~1s.
      setPareceExpirada(false);
      tentarAssumir();
      return;
    }
    if (!souDonoDoRegistro(reg)) {
      // Registro presente de outra aba: NÃO assumo por expiração. Apenas
      // atualizo o aviso de "parece encerrada" conforme a idade.
      setPareceExpirada(registroExpirado(reg));
    }
  }

  // Transfere a liderança para ESTA aba (botão "Usar esta aba"). Revalida e
  // sobrescreve o registro; a anterior recua ao ver a mudança (storage/broadcast
  // ou na próxima batida de heartbeat, ao voltar de um congelamento).
  function assumirForcado() {
    if (destruido) return;
    setPareceExpirada(false);
    postar("assumir-forcado");
    tentarAssumir(true);
  }

  function iniciar() {
    if (!temStorage) {
      // Degradado: assume e pronto.
      ehLider = true;
      notificar();
      return;
    }
    if (typeof BroadcastChannel !== "undefined") {
      try {
        bc = new BroadcastChannel(nomeCanal);
        bc.onmessage = aoReceberMensagem;
      } catch (e) {
        bc = null;
      }
    }
    window.addEventListener("storage", aoMudarStorage);

    // Failover rápido ao fechar a aba: pagehide dispara a mesma liberação já
    // existente em destruir() (removeItem + broadcast "lider-saiu"), sem esperar
    // nada. Só a líder efetivamente remove o registro (garantido dentro de
    // destruir). NÃO usamos visibilitychange — trocar de aba/minimizar não pode
    // liberar a liderança.
    window.addEventListener("pagehide", aoSairDaPagina);
    // beforeunload apenas como fallback (alguns cenários em que pagehide não
    // dispara). destruir() é idempotente, então o disparo duplo é inofensivo.
    window.addEventListener("beforeunload", aoSairDaPagina);

    // Pergunta se já há líder viva; se ninguém responder e o registro estiver
    // livre, assume. Registro de outra aba (mesmo velho) mantém esta aba
    // bloqueada — a mensagem "Usar esta aba" aparece via monitor se estiver
    // velho.
    postar("quem-e-lider");
    tentarAssumir();
    // Estado inicial de "parece expirada" para uma secundária que sobe com um
    // registro já velho (ex.: após um crash anterior do navegador).
    const inicial = lerRegistro();
    if (!ehLider && inicial && !souDonoDoRegistro(inicial) && registroExpirado(inicial)) {
      setPareceExpirada(true);
      // Caso do reboot/crash: a aba sobe já encontrando um registro sem dono.
      // Sonda agora, para não esperar a primeira varredura do monitor.
      sondarSeOrfao(inicial);
    }
    iniciarMonitor();
  }

  // Handler nomeado (mesma referência no add e no remove) para o fechamento.
  function aoSairDaPagina() {
    destruir();
  }

  function destruir() {
    if (destruido) return;
    destruido = true;
    pararHeartbeat();
    pararMonitor();
    if (sondaTimer) {
      clearTimeout(sondaTimer);
      sondaTimer = null;
    }
    sondando = false;
    // Ao fechar/desmontar a líder, libera o registro para uma secundária
    // assumir imediatamente (failover ~1s, sem esperar nada).
    if (temStorage) {
      // Libera o registro se for meu — inclusive um CLAIM ainda pendente (a aba
      // desistiu da disputa antes de concluir); senão a vaga ficaria "presa".
      const reg = lerRegistro();
      if (souDonoDoRegistro(reg)) {
        try {
          window.localStorage.removeItem(chaveLider);
        } catch (e) {
          /* ignore */
        }
        if (!ehLider) postar("lider-saiu");
      }
      if (ehLider) postar("lider-saiu");
    }
    if (bc) {
      try {
        bc.close();
      } catch (e) {
        /* ignore */
      }
      bc = null;
    }
    window.removeEventListener("storage", aoMudarStorage);
    window.removeEventListener("pagehide", aoSairDaPagina);
    window.removeEventListener("beforeunload", aoSairDaPagina);
  }

  return {
    tabId,
    iniciar,
    destruir,
    assumirForcado,
    estado,
    _temStorage: temStorage,
  };
}

// ---------------------------------------------------------------------------
// Várias abas por pessoa (vagas).
//
// A operação pediu mais de uma aba por usuário (uma só limitava os
// atendimentos). Em vez de mexer na eleição, compomos N eleições
// independentes — uma por VAGA (`${scopeId}__v1`, `${scopeId}__v2`, ...).
// A aba é "líder" se detém QUALQUER vaga; ao conquistar uma, abre mão das
// outras (destrói os controles restantes), para nunca ocupar duas vagas e
// deixar a colega de fora. Ao perder a vaga, volta a disputar todas.
// ---------------------------------------------------------------------------
export const VAGAS_POR_USUARIO = 2;

export function criarControleAbasPorVagas(scopeId, opcoes = {}) {
  const onMudanca = typeof opcoes.onMudanca === "function" ? opcoes.onMudanca : () => {};
  const vagas = Math.max(1, Number(opcoes.vagas) || VAGAS_POR_USUARIO);

  let controles = new Map(); // vaga -> controle
  let vagaMinha = null;
  let destruido = false;
  let ultimo = null;

  function estado() {
    let pareceExpirada = false;
    let degradado = false;
    for (const c of controles.values()) {
      const e = c.estado();
      if (e.pareceExpirada) pareceExpirada = true;
      if (e.degradado) degradado = true;
    }
    const ehLider = vagaMinha !== null;
    return {
      ehLider,
      degradado,
      // Só faz sentido avisar "pode ter encerrado" se TODAS as vagas estão
      // ocupadas por outras abas e alguma parece morta.
      pareceExpirada: !ehLider && pareceExpirada,
      vaga: vagaMinha,
      tabId: controles.size ? controles.values().next().value.tabId : null,
    };
  }

  function notificar() {
    if (destruido) return;
    const e = estado();
    const chave = `${e.ehLider}|${e.degradado}|${e.pareceExpirada}|${e.vaga}`;
    if (chave === ultimo) return;
    ultimo = chave;
    onMudanca(e);
  }

  function aoMudarVaga(vaga) {
    if (destruido) return;
    const c = controles.get(vaga);
    if (!c) return;
    const e = c.estado();
    if (e.ehLider) {
      if (vagaMinha === null) {
        vagaMinha = vaga;
        // Conquistei uma vaga: solto as demais.
        for (const [v, outro] of Array.from(controles.entries())) {
          if (v !== vaga) {
            controles.delete(v);
            outro.destruir();
          }
        }
      } else if (vagaMinha !== vaga) {
        // Corrida: já tenho outra vaga. Devolvo esta.
        controles.delete(vaga);
        c.destruir();
      }
    } else if (vagaMinha === vaga) {
      // Perdi minha vaga (transferência "Usar esta aba" em outra aba).
      vagaMinha = null;
      abrirTodas();
    }
    notificar();
  }

  function abrirTodas() {
    for (let v = 1; v <= vagas; v += 1) {
      if (controles.has(v)) continue;
      const c = criarControleAbaLider(`${scopeId}__v${v}`, {
        onMudanca: () => aoMudarVaga(v),
      });
      controles.set(v, c);
    }
    // Inicia em ordem (vaga 1 primeiro). Estado inicial não dispara onMudanca.
    for (let v = 1; v <= vagas; v += 1) {
      const c = controles.get(v);
      if (c && !c._iniciado) {
        c._iniciado = true;
        c.iniciar();
        aoMudarVaga(v);
        if (vagaMinha !== null) break;
      }
    }
  }

  function iniciar() {
    if (destruido) return;
    abrirTodas();
    notificar();
  }

  // "Usar esta aba": toma a vaga que parece encerrada (ou a 1ª) à força.
  function assumirForcado() {
    if (destruido || vagaMinha !== null) return;
    let alvo = null;
    for (const [v, c] of controles.entries()) {
      if (c.estado().pareceExpirada) {
        alvo = v;
        break;
      }
    }
    if (alvo === null) alvo = controles.keys().next().value;
    const c = alvo != null ? controles.get(alvo) : null;
    if (c) c.assumirForcado();
  }

  function destruir() {
    if (destruido) return;
    destruido = true;
    for (const c of controles.values()) c.destruir();
    controles = new Map();
    vagaMinha = null;
  }

  return {
    get tabId() {
      return estado().tabId;
    },
    iniciar,
    destruir,
    assumirForcado,
    estado,
    vagas,
  };
}
