import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../services/supabase";
import { podeVerTudo } from "../utils/operadores";

// Avisa Fernanda (supervisão) e Amanda ADM/gestora, com um aviso dentro do
// próprio app, quando entra uma solicitação nova pra elas resolverem:
// termo aguardando aprovação, pagamento aguardando confirmação, link
// aguardando resposta, ou envio ao financeiro. Roda em segundo plano em
// qualquer tela (montado uma vez no App.jsx), não renderiza nada pra quem
// não é supervisão/ADM.
const INTERVALO_MS = 60000; // contenção: 45s -> 60s (já pausa em aba oculta)

const CONSULTAS = [
  {
    tipo: "termo",
    rotulo: "📄 Termo aguardando aprovação",
    rota: "/termos-adm",
    tabela: "termos_acordo",
    filtro: (q) => q.eq("status", "TERMO_ENVIADO_ADM"),
  },
  {
    tipo: "pagamento",
    rotulo: "✅ Pagamento aguardando confirmação",
    rota: "/fila-confirmacao-pagamento",
    tabela: "solicitacoes_confirmacao_pagamento",
    // inclui "recebido, aguardando vínculo" (também não finalizado)
    filtro: (q) => q.in("status", ["AGUARDANDO_CONFIRMACAO", "PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO"]),
  },
  {
    tipo: "link",
    rotulo: "🔗 Link aguardando resposta",
    rota: "/painel-adm",
    tabela: "links_pagamento",
    filtro: (q) => q.in("status", ["SOLICITADO_LINK", "LINK_EM_ATENDIMENTO"]),
  },
  {
    tipo: "financeiro",
    rotulo: "💰 Envio ao financeiro",
    rota: "/painel-adm",
    tabela: "solicitacoes_financeiro",
    filtro: (q) => q.eq("status", "AGUARDANDO_ENVIO_FINANCEIRO"),
  },
];

// Som de notificação (2 bips via WebAudio, sem arquivo). Respeita o mudo.
let _audioCtx = null;
function tocarSomNotificacao() {
  try {
    if (localStorage.getItem("rv_som_notif") === "0") return; // mudo
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    _audioCtx = _audioCtx || new AC();
    if (_audioCtx.state === "suspended") _audioCtx.resume();
    const bip = (t, freq) => {
      const o = _audioCtx.createOscillator();
      const g = _audioCtx.createGain();
      o.type = "sine";
      o.frequency.value = freq;
      o.connect(g);
      g.connect(_audioCtx.destination);
      const now = _audioCtx.currentTime + t;
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(0.35, now + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);
      o.start(now);
      o.stop(now + 0.32);
    };
    bip(0, 880);
    bip(0.18, 1175);
  } catch (e) {
    /* silencioso */
  }
}

export default function NotificacoesSupervisaoAdm({ usuario }) {
  const navigate = useNavigate();
  const email = usuario?.perfil?.email || usuario?.auth?.email || "";
  const habilitado = podeVerTudo(email);

  const [avisos, setAvisos] = useState([]);
  const [mudo, setMudo] = useState(() => localStorage.getItem("rv_som_notif") === "0");
  const vistosRef = useRef(null);

  function alternarMudo() {
    const novo = !mudo;
    setMudo(novo);
    localStorage.setItem("rv_som_notif", novo ? "0" : "1");
    if (!novo) tocarSomNotificacao(); // religou: toca 1x (e "desbloqueia" o áudio via clique)
  }

  function dispensar(id) {
    setAvisos((atual) => atual.filter((a) => a.id !== id));
  }

  useEffect(() => {
    if (!habilitado) return;

    let cancelado = false;

    let rodando = false;

    async function verificar() {
      if (rodando) return; // sem sobreposicao
      rodando = true;
      try {
        const resultados = await Promise.all(
          CONSULTAS.map(async (config) => {
            let query = supabase.from(config.tabela).select("id, aluno_nome, criado_em");
            query = config.filtro(query);
            const { data, error } = await query;

            if (error) {
              console.error(`Erro ao checar notificações (${config.tabela}):`, error);
              return [];
            }

            return (data || []).map((linha) => ({
              chave: `${config.tipo}:${linha.id}`,
              tipo: config.rotulo,
              nome: linha.aluno_nome || "Aluno sem nome",
              rota: config.rota,
            }));
          })
        );

        if (cancelado) return;

        const atuais = resultados.flat();

        if (vistosRef.current === null) {
          // Primeira checagem depois do login: só guarda o que já existia,
          // sem notificar -- senão toda vez que ela abre o sistema toma um
          // monte de aviso de coisas que já estavam pendentes há dias.
          vistosRef.current = new Set(atuais.map((a) => a.chave));
          return;
        }

        const novos = atuais.filter((a) => !vistosRef.current.has(a.chave));

        novos.forEach((n) => {
          vistosRef.current.add(n.chave);
          const idUnico = `${n.chave}:${Date.now()}`;
          setAvisos((atual) => [{ ...n, id: idUnico }, ...atual].slice(0, 6));
          setTimeout(() => dispensar(idUnico), 40000);
        });

        // Som de alerta quando chega algo novo (link/termo/pagamento) — urgentes.
        if (novos.length > 0) tocarSomNotificacao();
      } catch (e) {
        console.error("Erro ao verificar notificações de supervisão/ADM:", e);
      } finally {
        rodando = false;
      }
    }

    verificar();
    // Continua checando MESMO com a aba em segundo plano, pra tocar o som de
    // link/termo mesmo quando a gestão está em outra aba/tela. (O navegador
    // reduz a frequência em background ~1x/min, mas ainda detecta e alerta.)
    // aoVoltarFoco força uma checagem imediata ao voltar o foco.
    const intervalo = setInterval(() => { verificar(); }, INTERVALO_MS);

    // O navegador atrasa (throttle) o setInterval quando a aba fica em
    // segundo plano (pessoa em outra aba/janela) -- sem isso, quem tava
    // com o CRM aberto mas não em foco podia não ver o aviso por vários
    // minutos, dando a impressão de que a notificação simplesmente não
    // funcionou. Roda uma checagem na hora assim que a aba volta a ficar
    // visível/em foco, em vez de esperar o próximo tick atrasado.
    function aoVoltarFoco() {
      if (document.visibilityState === "visible") verificar();
    }
    document.addEventListener("visibilitychange", aoVoltarFoco);
    window.addEventListener("focus", aoVoltarFoco);

    return () => {
      cancelado = true;
      clearInterval(intervalo);
      document.removeEventListener("visibilitychange", aoVoltarFoco);
      window.removeEventListener("focus", aoVoltarFoco);
    };
  }, [habilitado, email]);

  if (!habilitado) return null;

  return (
    <div style={estilos.container}>
      <button
        type="button"
        onClick={alternarMudo}
        style={estilos.botaoSom}
        title={mudo ? "Som das notificações: DESLIGADO (clique para ligar)" : "Som das notificações: LIGADO (clique para mutar)"}
      >
        {mudo ? "🔕 Som off" : "🔔 Som on"}
      </button>
      {avisos.map((a) => (
        <div
          key={a.id}
          style={estilos.toast}
          onClick={() => {
            navigate(a.rota);
            dispensar(a.id);
          }}
        >
          <div style={estilos.conteudo}>
            <div style={estilos.tipo}>{a.tipo}</div>
            <div style={estilos.nome}>{a.nome}</div>
          </div>
          <button
            style={estilos.fechar}
            onClick={(e) => {
              e.stopPropagation();
              dispensar(a.id);
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

const estilos = {
  container: {
    position: "fixed",
    top: "16px",
    right: "16px",
    zIndex: 9999,
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    maxWidth: "320px",
  },
  botaoSom: {
    alignSelf: "flex-end",
    background: "#111827",
    border: "1px solid #374151",
    borderRadius: "999px",
    padding: "5px 12px",
    fontSize: "12px",
    fontWeight: 700,
    color: "#e5e7eb",
    cursor: "pointer",
    opacity: 0.85,
  },
  toast: {
    background: "#111827",
    border: "1px solid #374151",
    borderLeft: "4px solid #3b82f6",
    borderRadius: "10px",
    padding: "12px 14px",
    boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: "10px",
    cursor: "pointer",
  },
  conteudo: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
  },
  tipo: {
    fontSize: "12px",
    fontWeight: 700,
    color: "#e5e7eb",
  },
  nome: {
    fontSize: "13px",
    fontWeight: 700,
    color: "#fff",
  },
  fechar: {
    background: "none",
    border: "none",
    color: "#9ca3af",
    fontSize: "18px",
    lineHeight: 1,
    cursor: "pointer",
    padding: 0,
  },
};
