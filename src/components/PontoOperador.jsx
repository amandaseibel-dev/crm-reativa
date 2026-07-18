import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import { registrarEventoPonto } from "../utils/ponto";

const PAUSAS = [{ chave: "PAUSA", label: "Pausa" }];

function inicioDoDia() {
  const agora = new Date();
  agora.setHours(0, 0, 0, 0);
  return agora.toISOString();
}

function formatarHora(data) {
  if (!data) return "";
  return new Date(data).toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function PontoOperador({ usuarioLogado }) {
  const [eventosHoje, setEventosHoje] = useState([]);
  const [processando, setProcessando] = useState(null);

  const email = usuarioLogado?.email || "";
  const nome = usuarioLogado?.nome || email;

  async function buscarEventosHoje() {
    if (!email) return;

    const { data } = await supabase
      .from("ponto_operadores")
      .select("tipo, criado_em")
      .eq("email", email)
      .gte("criado_em", inicioDoDia())
      .order("criado_em", { ascending: true });

    setEventosHoje(data || []);
  }

  useEffect(() => {
    buscarEventosHoje();
  }, [email]);

  function estadoDaPausa(chave) {
    const inicio = eventosHoje.find((e) => e.tipo === `${chave}_INICIO`);
    const fim = eventosHoje.find((e) => e.tipo === `${chave}_FIM`);

    if (inicio && fim) return { status: "concluida", inicio, fim };
    if (inicio && !fim) return { status: "em_andamento", inicio };
    return { status: "nao_iniciada" };
  }

  async function alternarPausa(chave) {
    const estado = estadoDaPausa(chave);
    if (estado.status === "concluida" || processando) return;

    setProcessando(chave);
    try {
      const tipo = estado.status === "em_andamento" ? `${chave}_FIM` : `${chave}_INICIO`;
      await registrarEventoPonto(email, nome, tipo);
      await buscarEventosHoje();
    } finally {
      setProcessando(null);
    }
  }

  if (!email) return null;

  return (
    <div style={estilos.caixa}>
      {PAUSAS.map(({ chave, label }) => {
        const estado = estadoDaPausa(chave);
        return (
          <button
            key={chave}
            type="button"
            onClick={() => alternarPausa(chave)}
            disabled={estado.status === "concluida" || processando === chave}
            style={estilos.botao(estado.status)}
            title={
              estado.status === "concluida"
                ? `${formatarHora(estado.inicio.criado_em)} – ${formatarHora(estado.fim.criado_em)}`
                : estado.status === "em_andamento"
                ? `Iniciada às ${formatarHora(estado.inicio.criado_em)}`
                : "Ainda não iniciada hoje"
            }
          >
            {estado.status === "concluida" &&
              `✅ ${label} (${formatarHora(estado.inicio.criado_em)}–${formatarHora(estado.fim.criado_em)})`}
            {estado.status === "em_andamento" && `⏸ Encerrar ${label.toLowerCase()}`}
            {estado.status === "nao_iniciada" && `▶ Iniciar ${label.toLowerCase()}`}
          </button>
        );
      })}
    </div>
  );
}

const estilos = {
  caixa: {
    display: "flex",
    gap: 8,
    flexWrap: "wrap",
    marginBottom: 14,
  },
  botao: (status) => ({
    padding: "6px 12px",
    borderRadius: 8,
    fontSize: 12,
    fontWeight: 600,
    cursor: status === "concluida" ? "default" : "pointer",
    border:
      status === "em_andamento"
        ? "1px solid rgba(249, 115, 22, 0.6)"
        : status === "concluida"
        ? "1px solid rgba(34, 197, 94, 0.4)"
        : "1px solid rgba(148, 163, 184, 0.4)",
    background:
      status === "em_andamento"
        ? "rgba(249, 115, 22, 0.16)"
        : status === "concluida"
        ? "rgba(34, 197, 94, 0.1)"
        : "rgba(148, 163, 184, 0.1)",
    color:
      status === "em_andamento"
        ? "#fdba74"
        : status === "concluida"
        ? "#93c5fd"
        : "inherit",
    opacity: status === "concluida" ? 0.8 : 1,
  }),
};
