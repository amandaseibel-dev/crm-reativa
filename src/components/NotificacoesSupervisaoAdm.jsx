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
const INTERVALO_MS = 25000;

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
    filtro: (q) => q.eq("status", "AGUARDANDO_CONFIRMACAO"),
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

export default function NotificacoesSupervisaoAdm({ usuario }) {
  const navigate = useNavigate();
  const email = usuario?.perfil?.email || usuario?.auth?.email || "";
  const habilitado = podeVerTudo(email);

  const [avisos, setAvisos] = useState([]);
  const vistosRef = useRef(null);

  function dispensar(id) {
    setAvisos((atual) => atual.filter((a) => a.id !== id));
  }

  useEffect(() => {
    if (!habilitado) return;

    let cancelado = false;

    async function verificar() {
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
          setTimeout(() => dispensar(idUnico), 15000);
        });
      } catch (e) {
        console.error("Erro ao verificar notificações de supervisão/ADM:", e);
      }
    }

    verificar();
    const intervalo = setInterval(verificar, INTERVALO_MS);

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

  if (!habilitado || avisos.length === 0) return null;

  return (
    <div style={estilos.container}>
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
  toast: {
    background: "#111827",
    border: "1px solid #374151",
    borderLeft: "4px solid #22c55e",
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
