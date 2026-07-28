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
    // Ao fechar/desmontar a líder, libera o registro para uma secundária
    // assumir imediatamente (failover ~1s, sem esperar nada).
    if (ehLider && temStorage) {
      const reg = lerRegistro();
      if (souDonoDoRegistro(reg)) {
        try {
          window.localStorage.removeItem(chaveLider);
        } catch (e) {
          /* ignore */
        }
      }
      postar("lider-saiu");
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
