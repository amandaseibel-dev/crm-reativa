import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { nomeOperadorPorEmail } from "../utils/operadores";

const LIMITE_ONLINE_MS = 90 * 1000;

function primeiroNome(nome) {
  return String(nome || "").split(" ")[0];
}

export default function FilaReceptivo({ usuarioLogado }) {
  const [linhas, setLinhas] = useState([]);
  const [perfis, setPerfis] = useState({});
  const [marcando, setMarcando] = useState(false);
  const [operadoresReceptivo, setOperadoresReceptivo] = useState([]);

  const email = usuarioLogado?.email || "";
  const ehParticipante = operadoresReceptivo.includes(email);

  async function buscarFila() {
    // Quem é receptivo agora vem do cadastro de usuários (aba Usuários,
    // checkbox "Operador receptivo"), não é mais uma lista fixa no código.
    const { data: usuariosReceptivos } = await supabase
      .from("usuarios")
      .select("email, apelido, foto_url")
      .eq("receptivo", true);

    const emails = (usuariosReceptivos || []).map((u) => u.email);
    setOperadoresReceptivo(emails);

    const mapa = {};
    for (const usuario of usuariosReceptivos || []) {
      mapa[usuario.email] = usuario;
    }
    setPerfis(mapa);

    if (emails.length === 0) {
      setLinhas([]);
      return;
    }

    const { data } = await supabase
      .from("fila_receptivo")
      .select("email, nome, atendimentos_hoje, ultimo_atendimento, online_em, em_pausa")
      .in("email", emails);
    setLinhas(data || []);
  }

  useEffect(() => {
    buscarFila();
    const intervaloBusca = setInterval(buscarFila, 20000);
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

  async function alternarPausa(pausar) {
    if (!ehParticipante || marcando) return;
    setMarcando(true);
    try {
      await supabase.rpc("fila_receptivo_heartbeat", {
        p_email: email,
        p_nome: nomeOperadorPorEmail(email),
        p_em_pausa: pausar,
      });
      await buscarFila();
    } finally {
      setMarcando(false);
    }
  }

  const ordem = useMemo(() => {
    const agora = Date.now();

    return linhas
      .filter((linha) => operadoresReceptivo.includes(linha.email))
      .filter((linha) => !linha.em_pausa)
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
  }, [linhas, operadoresReceptivo]);

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

  const minhaLinha = linhas.find((linha) => linha.email === email);
  const euEstouEmPausa = Boolean(minhaLinha?.em_pausa);

  const botaoPausa = ehParticipante && (
    <button
      type="button"
      onClick={() => alternarPausa(!euEstouEmPausa)}
      disabled={marcando}
      style={euEstouEmPausa ? estilos.botaoPausaAtiva : estilos.botaoPausa}
    >
      {marcando ? "..." : euEstouEmPausa ? "▶️ Voltar da pausa" : "⏸️ Pausar"}
    </button>
  );

  // Reserva o espaço mesmo sem ninguém na fila do receptivo, pra essa
  // caixa não ficar aparecendo/sumindo e empurrando o resto da tela --
  // mas se eu sou participante, mantém o botão de pausa visível mesmo
  // com a fila vazia (senão, uma vez pausado, eu não conseguia voltar).
  if (ordem.length === 0) {
    if (!ehParticipante) return <div style={estilos.espacoReservado} />;

    return (
      <div style={estilos.caixa(false)}>
        <div style={estilos.linhaTopo}>
          <div>
            <strong style={estilos.destaque}>
              {euEstouEmPausa
                ? "⏸️ Você está em pausa no receptivo."
                : "📞 Fila do receptivo: ninguém online agora."}
            </strong>
          </div>
          {botaoPausa}
        </div>
      </div>
    );
  }

  function nomeExibicao(linha) {
    return perfis[linha.email]?.apelido || primeiroNome(linha.nome);
  }

  function Avatar({ linha, tamanho = 22 }) {
    const foto = perfis[linha.email]?.foto_url;
    if (!foto) return null;
    return (
      <img
        src={foto}
        alt={nomeExibicao(linha)}
        style={{
          width: tamanho,
          height: tamanho,
          borderRadius: "50%",
          objectFit: "cover",
          verticalAlign: "middle",
          marginRight: 6,
        }}
      />
    );
  }

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
              <Avatar linha={proximo} tamanho={24} />
              📞 Próximo do receptivo: {nomeExibicao(proximo)}
            </strong>
          )}
          {ordem.length > 1 && (
            <div style={estilos.fila}>
              Depois:{" "}
              {ordem.slice(1).map((linha, indice) => (
                <span key={linha.email} style={{ marginRight: 10, whiteSpace: "nowrap" }}>
                  <Avatar linha={linha} />
                  {nomeExibicao(linha)} ({linha.atendimentos_hoje} hoje)
                  {indice < ordem.length - 2 ? "," : ""}
                </span>
              ))}
            </div>
          )}
        </div>

        {ehParticipante && (
          <div style={{ display: "flex", gap: "8px" }}>
            <button
              type="button"
              onClick={marcarAtendido}
              disabled={marcando}
              style={estilos.botao}
            >
              {marcando ? "Marcando..." : "✅ Marquei atendimento"}
            </button>
            {botaoPausa}
          </div>
        )}
      </div>
    </div>
  );
}

const estilos = {
  espacoReservado: {
    height: 52,
    marginBottom: 14,
  },
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
  botaoPausa: {
    padding: "6px 14px",
    borderRadius: 8,
    border: "1px solid rgba(148, 163, 184, 0.6)",
    background: "rgba(148, 163, 184, 0.18)",
    color: "#e2e8f0",
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  botaoPausaAtiva: {
    padding: "6px 14px",
    borderRadius: 8,
    border: "1px solid rgba(251, 191, 36, 0.6)",
    background: "rgba(251, 191, 36, 0.18)",
    color: "#fef3c7",
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
};
