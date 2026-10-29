// Hook de notificações da Central WhatsApp.
//
// PRINCÍPIOS:
//
// 1. SÓ MENSAGENS DO OPERADOR OU DO RECEPTIVO. Notificar tudo seria ruído:
//    cada operador só precisa saber do que é seu ou do que está esperando
//    atendimento sem dono.
//
// 2. SEM DUPLICATA. Um Set de IDs vistos (sessionStorage) garante que a mesma
//    mensagem não toca duas vezes — nem ao recarregar, nem ao reabrir o canal
//    Realtime, nem em múltiplas abas (BroadcastChannel).
//
// 3. SEM ALERTAS DE SAÍDA. direcao !== "ENTRADA" é rejeitado logo na entrada.
//
// 4. NÃO DERRUBA A TELA. Todos os blocos de mídia e notificação ficam em
//    try/catch independentes.
//
// 5. PREFERÊNCIAS PERSISTEM por email, em localStorage, para cada operador
//    poder ter a sua combinação sem afetar os outros.
import { useCallback, useEffect, useRef, useState } from "react";

const BROADCAST_CANAL = "rv_wapp_notif";
// Prefixo + email para isolar preferências por operador.
function chavePrefs(email) {
  return `rv_wapp_prefs_${(email || "anon").replace(/[^a-z0-9]/gi, "_")}`;
}
function chaveSeen() {
  return "rv_wapp_seen";
}

function lerPrefs(email) {
  try {
    const raw = localStorage.getItem(chavePrefs(email));
    if (!raw) return { som: false, visual: true, browser: false };
    return { som: false, visual: true, browser: false, ...JSON.parse(raw) };
  } catch {
    return { som: false, visual: true, browser: false };
  }
}

function salvarPrefs(email, prefs) {
  try {
    localStorage.setItem(chavePrefs(email), JSON.stringify(prefs));
  } catch {}
}

function lerSeen() {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(chaveSeen()) || "[]"));
  } catch {
    return new Set();
  }
}

function gravarSeen(set) {
  try {
    // Limita a 1000 para não crescer sem fim.
    const arr = [...set].slice(-1000);
    sessionStorage.setItem(chaveSeen(), JSON.stringify(arr));
  } catch {}
}

// ---------------------------------------------------------------------------
// Hook principal
// ---------------------------------------------------------------------------

export default function useWhatsAppNotificacoes({ emailOperador, conversas }) {
  const [prefs, setPrefsState] = useState(() => lerPrefs(emailOperador));
  const [toasts, setToasts] = useState([]);

  // Mirrors para callbacks do Realtime (capturados uma vez)
  const prefsRef = useRef(prefs);
  const conversasRef = useRef(conversas);
  const emailRef = useRef(emailOperador);
  const ctxRef = useRef(null);
  const seenRef = useRef(lerSeen());
  const bcRef = useRef(null);

  useEffect(() => { prefsRef.current = prefs; }, [prefs]);
  useEffect(() => { conversasRef.current = conversas; }, [conversas]);
  useEffect(() => { emailRef.current = emailOperador; }, [emailOperador]);

  // Relê preferências ao trocar de operador (login compartilhado).
  useEffect(() => {
    setPrefsState(lerPrefs(emailOperador));
  }, [emailOperador]);

  // BroadcastChannel para deduplicação entre abas.
  useEffect(() => {
    try {
      const bc = new BroadcastChannel(BROADCAST_CANAL);
      // Ao receber um ID de outra aba, marca como visto localmente.
      bc.onmessage = (e) => {
        if (e.data?.msgId) seenRef.current.add(e.data.msgId);
      };
      bcRef.current = bc;
    } catch {}
    return () => {
      try { bcRef.current?.close(); } catch {}
      bcRef.current = null;
    };
  }, []);

  function setPrefs(patch) {
    setPrefsState((prev) => {
      const novo = { ...prev, ...patch };
      salvarPrefs(emailRef.current, novo);
      prefsRef.current = novo;
      return novo;
    });
  }

  // Solicita permissão do navegador para notificações nativas.
  async function pedirPermissaoBrowser() {
    if (!("Notification" in window) || !window.Notification) return "not-supported";
    if (window.Notification.permission === "granted") return "granted";
    try {
      const resultado = await Notification.requestPermission();
      return resultado;
    } catch {
      return "denied";
    }
  }

  function fecharToast(id) {
    setToasts((ts) => ts.filter((t) => t.id !== id));
  }

  function tocarSom() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = ctxRef.current || (ctxRef.current = new Ctx());
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
      const osc = ctx.createOscillator();
      const ganho = ctx.createGain();
      osc.frequency.value = 880;
      ganho.gain.setValueAtTime(0.06, ctx.currentTime);
      ganho.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
      osc.connect(ganho);
      ganho.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.25);
    } catch {}
  }

  // Chamada pelo handler do Realtime sempre que chega uma mensagem nova.
  const aoReceberMensagem = useCallback((mensagem) => {
    // Só ENTRADA, só TEMPO_REAL.
    if (mensagem?.direcao !== "ENTRADA") return;
    if (mensagem?.origem !== "TEMPO_REAL") return;

    // Deduplicação.
    if (seenRef.current.has(mensagem.id)) return;
    seenRef.current.add(mensagem.id);
    gravarSeen(seenRef.current);

    // Publica para outras abas antes de qualquer verificação de responsável,
    // para que elas também marquem como visto e não toquem duas vezes.
    try { bcRef.current?.postMessage?.({ msgId: mensagem.id }); } catch {}

    // Filtro de responsabilidade.
    const email = emailRef.current;
    const convs = conversasRef.current;
    const conversa = convs?.find?.((c) => c.id === mensagem.conversa_id) ?? null;

    if (conversa) {
      const ehMinhas = conversa.responsavel_email === email;
      const ehReceptivo = !conversa.responsavel_email && conversa.status !== "ENCERRADO";
      if (!ehMinhas && !ehReceptivo) return;
    }
    // Se a conversa não está na lista local (filtro ativo, etc.), deixa passar:
    // é melhor notificar demais do que deixar mensagem sem resposta.

    const p = prefsRef.current;
    const nomeAluno =
      conversa?.aluno_nome ||
      conversa?.nome_perfil ||
      conversa?.telefone_e164 ||
      "Aluno";
    const previa = mensagem.texto || "[mídia]";

    // Som.
    if (p.som) tocarSom();

    // Toast visual dentro do CRM.
    if (p.visual) {
      const id = `${mensagem.id}-${Date.now()}`;
      setToasts((ts) => [
        // No máximo 3 toasts simultâneos; descarta o mais velho.
        ...(ts.length >= 3 ? ts.slice(1) : ts),
        { id, nomeAluno, previa, conversaId: conversa?.id },
      ]);
      // Auto-fecha em 8 segundos.
      setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 8000);
    }

    // Notificação nativa do navegador.
    if (p.browser && "Notification" in window && Notification.permission === "granted") {
      try {
        new Notification(`WhatsApp: ${nomeAluno}`, {
          body: previa,
          icon: "/favicon.ico",
          // `tag` deduplicado pelo próprio navegador entre abas.
          tag: `rv-wapp-${mensagem.id}`,
        });
      } catch {}
    }
  }, []);

  return {
    prefs,
    setPrefs,
    pedirPermissaoBrowser,
    toasts,
    fecharToast,
    // Exposto para "testar som" ao ligar o botão.
    tocarSom,
    aoReceberMensagem,
  };
}
