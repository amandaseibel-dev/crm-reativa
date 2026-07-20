import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { nomeOperadorPorEmail } from "../utils/operadores";

// A fila só mostra quem está realmente logado agora. O "heartbeat" bate a
// cada 20s enquanto o operador está com o sistema aberto; se ele desloga
// ou fecha, para de bater e sai da fila sozinho. 90s dá folga pra abas em
// segundo plano sem deixar gente offline "presa" na fila.
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
        if (ua !== ub) return ua - ub; const oa = a.online_em ? new Date(a.online_em).getTime() : 0; const ob = b.online_em ? new Date(b.online_em).getTime() : 0; return oa - ob;
      });
  }, [linhas, operadoresReceptivo]);

  // Marca um atendimento. Sem argumento, marca o próprio operador logado.
  // Com um e-mail (botão na linha), marca aquele operador — útil quando quem
  // atendeu não foi quem estava na vez, ou pra a gestão registrar por eles.
  async function marcarAtendido(alvoEmail) {
    const alvo = alvoEmail || email;
    if (!alvo || marcando) return;
    setMarcando(true);
    try {
      await supabase.rpc("fila_receptivo_marcar_atendido", { p_email: alvo });
      await buscarFila();
    } finally {
      setMarcando(false);
    }
  }

  const minhaLinha = linhas.find((linha) => linha.email === email);
  const euEstouEmPausa = Boolean(minhaLinha?.em_pausa);

  function nomeExibicao(linha) {
    return perfis[linha.email]?.apelido || primeiroNome(linha.nome);
  }

  function Avatar({ linha, tamanho = 30 }) {
    const foto = perfis[linha.email]?.foto_url;
    const inicial = (nomeExibicao(linha) || "?").charAt(0).toUpperCase();
    if (!foto) {
      return (
        <span style={{ ...estilos.avatarFallback, width: tamanho, height: tamanho }}>
          {inicial}
        </span>
      );
    }
    return (
      <img
        src={foto}
        alt={nomeExibicao(linha)}
        style={{ width: tamanho, height: tamanho, borderRadius: "50%", objectFit: "cover" }}
      />
    );
  }

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

  // Sem ninguém online: mantém a caixa (pra não empurrar a tela) e, se eu
  // sou participante, o botão de pausa continua acessível.
  if (ordem.length === 0) {
    if (!ehParticipante) return <div style={estilos.espacoReservado} />;
    return (
      <div style={estilos.caixa}>
        <div style={estilos.cabecalho}>
          <strong style={estilos.titulo}>📞 Fila do receptivo</strong>
          {botaoPausa}
        </div>
        <p style={estilos.vazio}>
          {euEstouEmPausa
            ? "Você está em pausa. Volte quando quiser entrar na vez."
            : "Ninguém online no receptivo agora."}
        </p>
      </div>
    );
  }

  const proximo = ordem[0];
  const souOProximo = proximo.email === email;

  return (
    <div style={estilos.caixa}>
      <div style={estilos.cabecalho}>
        <strong style={estilos.titulo}>📞 Fila do receptivo</strong>
        <span style={estilos.online}>
          <span style={estilos.pontoOnline} />
          {ordem.length} online agora
        </span>
      </div>

      {ehParticipante && (
        <div style={{ ...estilos.destaque, ...(souOProximo ? estilos.destaqueVez : {}) }}>
          <div>
            <div style={estilos.destaqueRotulo}>
              {souOProximo ? "É a sua vez de atender" : "Próximo a atender"}
            </div>
            <div style={estilos.destaqueNome}>{nomeExibicao(proximo)}</div>
          </div>
          <button
            type="button"
            onClick={() => marcarAtendido(email)}
            disabled={marcando}
            style={estilos.botaoAtendi}
          >
            {marcando ? "Registrando..." : "✅ Atendi uma ligação"}
          </button>
        </div>
      )}

      <div style={estilos.rotuloLista}>Ordem de atendimento — quem atende vai para o fim</div>

      <div style={estilos.lista}>
        {ordem.map((linha, indice) => {
          const eu = linha.email === email;
          const primeiro = indice === 0;
          return (
            <div
              key={linha.email}
              style={{
                ...estilos.item,
                ...(primeiro ? estilos.itemPrimeiro : {}),
                ...(eu ? estilos.itemEu : {}),
              }}
            >
              <span style={{ ...estilos.posicao, ...(primeiro ? estilos.posicaoPrimeiro : {}) }}>
                {indice + 1}
              </span>
              <Avatar linha={linha} />
              <span style={estilos.nomeItem}>
                {nomeExibicao(linha)}
                {eu ? " (você)" : ""}
              </span>
              <span style={estilos.contador}>{linha.atendimentos_hoje} hoje</span>
              <button
                type="button"
                onClick={() => marcarAtendido(linha.email)}
                disabled={marcando}
                style={estilos.botaoMarcarLinha}
                title={`Marcar um atendimento para ${nomeExibicao(linha)}`}
              >
                ✅ Marcar
              </button>
            </div>
          );
        })}
      </div>

      {ehParticipante && <div style={estilos.rodape}>{botaoPausa}</div>}
    </div>
  );
}

// Paleta clara e neutra, alinhada ao PainelCarteira (fundo branco, bordas
// finas #e6eaf0, verde discreto para o destaque da vez, azul para a acao
// principal). Somente aparencia -- nenhuma mudanca de logica.
const BORDA = "#e6eaf0";
const BORDA_SUAVE = "#eef2f6";

const estilos = {
  espacoReservado: {
    height: 60,
    marginBottom: 16,
  },
  caixa: {
    background: "#fff",
    border: `1px solid ${BORDA_SUAVE}`,
    borderRadius: 14,
    padding: "16px 18px",
    marginBottom: 16,
    boxShadow: "0 1px 2px rgba(15,23,42,0.04)",
  },
  cabecalho: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 12,
    flexWrap: "wrap",
  },
  titulo: {
    fontSize: 14,
    fontWeight: 600,
    color: "#1e293b",
  },
  online: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    fontSize: 11.5,
    fontWeight: 600,
    color: "#16a34a",
    background: "#eefbf3",
    border: "1px solid #d6f2e0",
    borderRadius: 999,
    padding: "2px 9px",
  },
  pontoOnline: {
    width: 7,
    height: 7,
    borderRadius: "50%",
    background: "#16a34a",
    display: "inline-block",
  },
  destaque: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    padding: "12px 14px",
    borderRadius: 12,
    background: "#f9fafc",
    border: `1px solid ${BORDA}`,
    marginBottom: 14,
    flexWrap: "wrap",
  },
  destaqueVez: {
    background: "#eefbf3",
    border: "1px solid #bbe9cb",
  },
  destaqueRotulo: {
    fontSize: 11.5,
    fontWeight: 600,
    color: "#16a34a",
  },
  destaqueNome: {
    fontSize: 17,
    fontWeight: 700,
    color: "#1e293b",
  },
  botaoAtendi: {
    background: "#16a34a",
    color: "#fff",
    border: "none",
    borderRadius: 10,
    padding: "10px 16px",
    fontSize: 13.5,
    fontWeight: 700,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  rotuloLista: {
    fontSize: 11.5,
    color: "#94a3b8",
    marginBottom: 8,
  },
  lista: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  item: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "8px 10px",
    borderRadius: 10,
    background: "#fff",
    border: `1px solid ${BORDA_SUAVE}`,
  },
  itemPrimeiro: {
    border: "1px solid #bbe9cb",
    background: "#f4fcf7",
  },
  itemEu: {
    boxShadow: "inset 0 0 0 1px #dbe3ec",
  },
  posicao: {
    width: 22,
    height: 22,
    borderRadius: "50%",
    background: "#f1f5f9",
    color: "#64748b",
    fontSize: 11.5,
    fontWeight: 700,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  posicaoPrimeiro: {
    background: "#dcf5e5",
    color: "#15803d",
  },
  avatarFallback: {
    borderRadius: "50%",
    background: "#eef2f6",
    color: "#475569",
    fontSize: 12.5,
    fontWeight: 700,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  nomeItem: {
    flex: 1,
    color: "#1e293b",
    fontWeight: 600,
    fontSize: 13.5,
  },
  contador: {
    fontSize: 11.5,
    color: "#94a3b8",
    whiteSpace: "nowrap",
  },
  botaoMarcarLinha: {
    padding: "5px 10px",
    borderRadius: 8,
    border: "1px solid #bbe9cb",
    background: "#eefbf3",
    color: "#15803d",
    fontSize: 11.5,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
  rodape: {
    marginTop: 12,
    display: "flex",
    justifyContent: "flex-end",
  },
  vazio: {
    fontSize: 12.5,
    color: "#94a3b8",
    margin: 0,
  },
  botaoPausa: {
    padding: "8px 14px",
    borderRadius: 8,
    border: `1px solid ${BORDA}`,
    background: "#fff",
    color: "#475569",
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  botaoPausaAtiva: {
    padding: "8px 14px",
    borderRadius: 8,
    border: "1px solid #f6d99a",
    background: "#fff8ec",
    color: "#b45309",
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
};
