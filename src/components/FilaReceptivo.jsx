import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { nomeOperadorPorEmail } from "../utils/operadores";

const OPERADORES_RECEPTIVO = [
  "cobranca03@aelbra.com.br",
  "cobranca05@aelbra.com.br",
  "cobranca06@aelbra.com.br",
  "cobranca08@aelbra.com.br",
  "cobranca10@aelbra.com.br",
  "cobranca11@aelbra.com.br",
  "cobranca12@aelbra.com.br",
  "cobranca13@aelbra.com.br",
];

const LIMITE_ONLINE_MS = 90 * 1000;

function primeiroNome(nome) {
  return String(nome || "").split(" ")[0];
}

export default function FilaReceptivo({ usuarioLogado }) {
  const [linhas, setLinhas] = useState([]);
  const [marcando, setMarcando] = useState(false);

  const email = usuarioLogado?.email || "";
  const ehParticipante = OPERADORES_RECEPTIVO.includes(email);

  async function buscarFila() {
    const { data } = await supabase
      .from("fila_receptivo")
      .select("email, nome, atendimentos_hoje, ultimo_atendimento, online_em");
    setLinhas(data || []);
  }

  useEffect(() => {
    buscarFila();
    const intervaloBusca = setInterval(buscarFila, 8000);
    return () => clearInterval(intervaloBusca);
  }, []);

  useEffect(() => {
    if (!ehParticipante) return;

    async function bater() {
      await supabase.rpc("fila_receptivo_heartbeat", {
        p_email: email,
        p_nome: nomeOperadorPorEmail(email),
      });
      buscarFila();
    }

    bater();
    const intervaloHeartbeat = setInterval(bater, 20000);
    return () => clearInterval(intervaloHeartbeat);
  }, [email, ehParticipante]);

  const ordem = useMemo(() => {
    const agora = Date.now();

    return linhas
      .filter((linha) => OPERADORES_RECEPTIVO.includes(linha.email))
      .filter((linha) => {
        const online = linha.online_em ? new Date(linha.online_em).getTime() : 0;
        return agora - online <= LIMITE_ONLINE_MS;
      })
      .sort((a, b) => {
        if (a.atendimentos_hoje !== b.atendimentos_hoje) {
          return a.atendimentos_hoje - b.atendimentos_hoje;
        }
        const ua = a.ultimo_atendimento ? new Date(a.ultimo_atendimento).getTime() : 0;
        const ub = b.ultimo_atendimento ? new Date(b.ultimo_atendimento).getTime() : 0;
        return ua - ub;
      });
  }, [linhas]);

  async function marcarAtendido() {
    if (!ehParticipante || marcando) return;
    setMarcando(true);
    try {
      await supabase.rpc("fila_receptivo_marcar_atendido", { p_email: email });
      await buscarFila();
    } finally {
      setMarcando(false);
    }
  }

  if (ordem.length === 0) return null;

  const proximo = ordem[0];
  const souOProximo = proximo.email === email;

  return (
    <div style={estilos.caixa(souOProximo)}>
      <div style={estilos.linhaTopo}>
        <div>
          {souOProximo ? (
            <strong style={estilos.destaqueMim}>🔔 Você é o próximo do receptivo!</strong>
          ) : (
            <strong style={estilos.destaque}>
              📞 Próximo do receptivo: {primeiroNome(proximo.nome)}
            </strong>
          )}
          {ordem.length > 1 && (
            <div style={estilos.fila}>
              Depois:{" "}
              {ordem
                .slice(1)
                .map((linha) => `${primeiroNome(linha.nome)} (${linha.atendimentos_hoje} hoje)`)
                .join(", ")}
            </div>
          )}
        </div>

        {ehParticipante && (
          <button
            type="button"
            onClick={marcarAtendido}
            disabled={marcando}
            style={estilos.botao}
          >
            {marcando ? "Marcando..." : "✅ Marquei atendimento"}
          </button>
        )}
      </div>
    </div>
  );
}

const estilos = {
  caixa: (destaque) => ({
    display: "flex",
    padding: "10px 16px",
    marginBottom: 14,
    borderRadius: 10,
    background: destaque ? "rgba(34, 197, 94, 0.14)" : "rgba(148, 163, 184, 0.12)",
    border: destaque ? "1px solid rgba(34, 197, 94, 0.5)" : "1px solid rgba(148, 163, 184, 0.35)",
  }),
  linhaTopo: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    width: "100%",
    gap: 12,
    flexWrap: "wrap",
  },
  destaque: {
    fontSize: 14,
  },
  destaqueMim: {
    fontSize: 14,
    color: "#86efac",
  },
  fila: {
    fontSize: 12,
    opacity: 0.75,
    marginTop: 2,
  },
  botao: {
    padding: "6px 14px",
    borderRadius: 8,
    border: "1px solid rgba(34, 197, 94, 0.6)",
    background: "rgba(34, 197, 94, 0.18)",
    color: "#dcfce7",
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
};
