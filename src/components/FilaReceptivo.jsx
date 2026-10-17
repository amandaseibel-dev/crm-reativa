import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../services/supabase";
import usePolling from "../utils/polling";
import { nomeOperadorPorEmail } from "../utils/operadores";
import { AvatarFoto } from "../components/AvatarFoto";

// A fila só mostra quem está realmente logado agora. O "heartbeat" bate a
// cada 20s enquanto o operador está com o sistema aberto; se ele desloga
// ou fecha, para de bater e sai da fila sozinho. 90s dá folga pra abas em
// segundo plano sem deixar gente offline "presa" na fila.
const LIMITE_ONLINE_MS = 90 * 1000;

function primeiroNome(nome) {
  return String(nome || "").split(" ")[0];
}

// `variante`:
//   "coluna" (padrao) -- a caixa vertical de sempre, na aba Receptivo da Carteira.
//   "barra"           -- a MESMA fila na horizontal, para morar no topo da fila
//                        da Central WhatsApp. Muda so a forma: os dados, a
//                        ordem, os RPCs e o contador do dia sao exatamente os
//                        mesmos -- nada zera e nada e recontado aqui.
export default function FilaReceptivo({ usuarioLogado, variante = "coluna" }) {
  const [linhas, setLinhas] = useState([]);
  const [perfis, setPerfis] = useState({});
  const [marcando, setMarcando] = useState(false);
  const [operadoresReceptivo, setOperadoresReceptivo] = useState([]);
  // So a variante "barra": a fila inteira fica fechada numa gaveta. Em cima
  // da fila de conversas o que importa e quem esta na vez -- a lista toda
  // so aparece quando alguem precisa marcar atendimento de outro.
  const [filaAberta, setFilaAberta] = useState(false);
  // Guarda SÍNCRONA contra clique duplo: setMarcando (estado React) só
  // desabilita o botão no próximo render, deixando uma janela para 2 cliques
  // rápidos dispararem 2 RPCs concorrentes na mesma linha. A ref bloqueia na
  // hora, antes de qualquer await.
  const emAcaoRef = useRef(false);

  // A Carteira passa o usuario por prop; a Central WhatsApp nao tem esse
  // objeto em maos. Quando a prop falta, o e-mail vem da propria sessao --
  // sem isso a barra nao saberia quem e "voce" e esconderia os botoes.
  const [emailSessao, setEmailSessao] = useState("");
  useEffect(() => {
    if (usuarioLogado?.email) return undefined;
    let vivo = true;
    (async () => {
      const { data } = await supabase.auth.getUser();
      if (vivo) setEmailSessao(data?.user?.email || "");
    })();
    return () => { vivo = false; };
  }, [usuarioLogado?.email]);

  const email = usuarioLogado?.email || emailSessao;
  const ehParticipante = operadoresReceptivo.includes(email);

  async function buscarFila() {
    const { data: usuariosReceptivos } = await supabase
      .from("usuarios")
      .select("id, email, apelido")
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

  // O heartbeat NAO roda mais aqui: o componente global HeartbeatReceptivo
  // (montado no App.jsx) ja mantem o operador online em qualquer tela. Antes
  // os dois batiam a cada 20s, dobrando as chamadas de fila_receptivo_heartbeat.
  // Aqui ficou so a leitura da fila, pausada em aba oculta e sem sobreposicao.
  usePolling(async () => { await buscarFila(); }, 60000, []);

  async function alternarPausa(pausar) {
    if (!ehParticipante || emAcaoRef.current) return;
    emAcaoRef.current = true;
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
      emAcaoRef.current = false;
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
    if (!alvo || emAcaoRef.current) return;
    emAcaoRef.current = true;
    setMarcando(true);
    try {
      await supabase.rpc("fila_receptivo_marcar_atendido", { p_email: alvo });
      await buscarFila();
    } finally {
      setMarcando(false);
      emAcaoRef.current = false;
    }
  }

  const minhaLinha = linhas.find((linha) => linha.email === email);
  const euEstouEmPausa = Boolean(minhaLinha?.em_pausa);

  function nomeExibicao(linha) {
    return perfis[linha.email]?.apelido || primeiroNome(linha.nome);
  }

  function Avatar({ linha, tamanho = 30 }) {
    return (
      <AvatarFoto
        usuarioId={perfis[linha.email]?.id}
        nome={nomeExibicao(linha)}
        tamanho={tamanho}
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

  // ----------------------------------------------------------------------
  // VARIANTE "BARRA": a mesma fila deitada, para o topo da Central WhatsApp.
  //
  // Lê e escreve exatamente o que a caixa vertical lê e escreve. A ordem é a
  // da regra de sempre (menos atendimentos primeiro; empate vai para quem
  // atendeu há mais tempo) e o "Marcar" chama o MESMO RPC — o contador do dia
  // continua sendo do banco, ninguém zera nada pela tela.
  // ----------------------------------------------------------------------
  if (variante === "barra") {
    const naVez = ordem[0] || null;
    const minhaVez = Boolean(naVez && naVez.email === email);
    const depois = ordem.slice(1, 4);
    const resto = Math.max(0, ordem.length - 4);

    const botaoPausaCompacto = ehParticipante ? (
      <button
        type="button"
        onClick={() => alternarPausa(!euEstouEmPausa)}
        disabled={marcando}
        style={euEstouEmPausa ? B.botaoLeveAtivo : B.botaoLeve}
        title={euEstouEmPausa ? "Voltar da pausa" : "Entrar em pausa"}
      >
        {euEstouEmPausa ? "▶️ Voltar" : "⏸️ Pausar"}
      </button>
    ) : null;

    return (
      <div style={B.envoltorio}>
        <div style={B.barra}>
          <span style={B.tituloBarra}>📞 Receptivo</span>
          <span style={ordem.length ? B.online : B.offline}>
            <span style={ordem.length ? B.pontoVerde : B.pontoCinza} />
            {ordem.length} online
          </span>

          {naVez ? (
            <span style={B.naVez}>
              <span style={B.naVezRotulo}>na vez</span>
              <AvatarFoto
                usuarioId={perfis[naVez.email]?.id}
                nome={nomeExibicao(naVez)}
                tamanho={22}
              />
              <strong style={B.naVezNome}>{nomeExibicao(naVez)}</strong>
              <span style={B.naVezContador}>{naVez.atendimentos_hoje} hoje</span>
            </span>
          ) : (
            <span style={B.vazioBarra}>
              {euEstouEmPausa
                ? "Você está em pausa — fora da vez."
                : "Ninguém online no receptivo agora."}
            </span>
          )}

          {depois.length ? (
            <span style={B.depois}>
              depois: {depois.map((l) => nomeExibicao(l)).join(" · ")}
              {resto > 0 ? ` +${resto}` : ""}
            </span>
          ) : null}

          <span style={B.espacador} />

          {minhaVez ? <span style={B.suaVez}>é a sua vez</span> : null}
          {ehParticipante ? (
            <button
              type="button"
              onClick={() => marcarAtendido(email)}
              disabled={marcando}
              style={B.botaoAtendi}
            >
              {marcando ? "Registrando..." : "✅ Atendi"}
            </button>
          ) : null}
          {botaoPausaCompacto}
          {ordem.length ? (
            <button
              type="button"
              onClick={() => setFilaAberta((v) => !v)}
              style={B.botaoLeve}
              aria-expanded={filaAberta}
              title="Ver a fila inteira e marcar atendimento de outro operador"
            >
              {filaAberta ? "Fechar fila ▴" : `Fila (${ordem.length}) ▾`}
            </button>
          ) : null}
        </div>

        {/* A gaveta: a fila inteira, com o Marcar de cada um. Fechada por
            padrao -- quem so quer saber de quem e a vez nao ve nada disso. */}
        {filaAberta && ordem.length ? (
          <div style={B.gaveta}>
            {ordem.map((linha, indice) => {
              const eu = linha.email === email;
              const primeiro = indice === 0;
              return (
                <div
                  key={linha.email}
                  style={{
                    ...B.chip,
                    ...(primeiro ? B.chipVez : {}),
                    ...(eu ? B.chipEu : {}),
                  }}
                >
                  <span style={{ ...B.posicao, ...(primeiro ? B.posicaoVez : {}) }}>
                    {indice + 1}
                  </span>
                  <AvatarFoto
                    usuarioId={perfis[linha.email]?.id}
                    nome={nomeExibicao(linha)}
                    tamanho={24}
                  />
                  <span style={B.chipNome}>
                    {nomeExibicao(linha)}
                    {eu ? " (você)" : ""}
                  </span>
                  <span style={B.chipContador}>{linha.atendimentos_hoje} hoje</span>
                  <button
                    type="button"
                    onClick={() => marcarAtendido(linha.email)}
                    disabled={marcando}
                    style={B.chipBotao}
                    title={`Marcar um atendimento para ${nomeExibicao(linha)}`}
                  >
                    ✅
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    );
  }

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
const BORDA = "var(--rv-borda)";
const BORDA_SUAVE = "var(--rv-borda-suave)";

const estilos = {
  espacoReservado: {
    height: 60,
    marginBottom: 16,
  },
  caixa: {
    background: "var(--rv-superficie)",
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
    color: "var(--rv-tinta)",
  },
  online: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    fontSize: 11.5,
    fontWeight: 600,
    color: "var(--rv-verde-ok)",
    background: "var(--rv-verde-ok-fundo)",
    border: "1px solid var(--rv-verde-ok-borda)",
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
    background: "var(--rv-superficie)",
    border: `1px solid ${BORDA}`,
    marginBottom: 14,
    flexWrap: "wrap",
  },
  destaqueVez: {
    background: "var(--rv-verde-ok-fundo)",
    border: "1px solid var(--rv-verde-ok-borda)",
  },
  destaqueRotulo: {
    fontSize: 11.5,
    fontWeight: 600,
    color: "var(--rv-verde-ok)",
  },
  destaqueNome: {
    fontSize: 17,
    fontWeight: 700,
    color: "var(--rv-tinta)",
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
    color: "var(--rv-texto-fraco)",
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
    background: "var(--rv-superficie)",
    border: `1px solid ${BORDA_SUAVE}`,
  },
  itemPrimeiro: {
    border: "1px solid var(--rv-verde-ok-borda)",
    background: "var(--rv-verde-ok-fundo)",
  },
  itemEu: {
    boxShadow: "inset 0 0 0 1px var(--rv-borda-forte)",
  },
  posicao: {
    width: 22,
    height: 22,
    borderRadius: "50%",
    background: "var(--rv-fundo-suave)",
    color: "var(--rv-texto-suave)",
    fontSize: 11.5,
    fontWeight: 700,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  posicaoPrimeiro: {
    background: "var(--rv-verde-ok-fundo)",
    color: "var(--rv-verde-ok-texto)",
  },
  avatarFallback: {
    borderRadius: "50%",
    background: "var(--rv-fundo-suave)",
    color: "var(--rv-texto)",
    fontSize: 12.5,
    fontWeight: 700,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  nomeItem: {
    flex: 1,
    color: "var(--rv-tinta)",
    fontWeight: 600,
    fontSize: 13.5,
  },
  contador: {
    fontSize: 11.5,
    color: "var(--rv-texto-fraco)",
    whiteSpace: "nowrap",
  },
  botaoMarcarLinha: {
    padding: "5px 10px",
    borderRadius: 8,
    border: "1px solid var(--rv-verde-ok-borda)",
    background: "var(--rv-verde-ok-fundo)",
    color: "var(--rv-verde-ok-texto)",
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
    color: "var(--rv-texto-fraco)",
    margin: 0,
  },
  botaoPausa: {
    padding: "8px 14px",
    borderRadius: 8,
    border: `1px solid ${BORDA}`,
    background: "var(--rv-superficie)",
    color: "var(--rv-texto)",
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  botaoPausaAtiva: {
    padding: "8px 14px",
    borderRadius: 8,
    border: "1px solid var(--rv-ambar-borda)",
    background: "var(--rv-ambar-fundo)",
    color: "var(--rv-ambar-texto)",
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
};

// Estilos da variante "barra". Separados dos de cima de proposito: a caixa
// vertical da Carteira nao muda em nada.
//
// A regra aqui e NAO COMPETIR COM A FILA DE CONVERSAS: a barra ocupa UMA linha
// discreta, mostra quem esta na vez e os proximos em texto, e guarda a lista
// inteira (com o Marcar de cada um) numa gaveta fechada.
const B = {
  envoltorio: {
    marginBottom: 12,
  },
  barra: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "7px 12px",
    borderRadius: 10,
    border: `1px solid ${BORDA_SUAVE}`,
    background: "var(--rv-fundo-cartao)",
    flexWrap: "wrap",
  },
  tituloBarra: {
    fontSize: 12.5,
    fontWeight: 700,
    color: "var(--rv-texto-suave)",
    whiteSpace: "nowrap",
  },
  online: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    fontSize: 11,
    fontWeight: 600,
    color: "var(--rv-verde-ok)",
    whiteSpace: "nowrap",
  },
  offline: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    fontSize: 11,
    fontWeight: 600,
    color: "var(--rv-texto-fraco)",
    whiteSpace: "nowrap",
  },
  pontoVerde: {
    width: 7, height: 7, borderRadius: "50%", background: "#16a34a", display: "inline-block",
  },
  pontoCinza: {
    width: 7, height: 7, borderRadius: "50%", background: "var(--rv-texto-fraco)", display: "inline-block",
  },
  naVez: {
    display: "inline-flex",
    alignItems: "center",
    gap: 7,
    padding: "3px 10px 3px 4px",
    borderRadius: 999,
    background: "var(--rv-verde-ok-fundo)",
    border: "1px solid var(--rv-verde-ok-borda)",
    whiteSpace: "nowrap",
  },
  naVezRotulo: {
    fontSize: 9.5,
    fontWeight: 700,
    letterSpacing: 0.5,
    textTransform: "uppercase",
    color: "var(--rv-verde-ok)",
    paddingLeft: 6,
  },
  naVezNome: {
    fontSize: 13,
    fontWeight: 700,
    color: "var(--rv-tinta)",
  },
  naVezContador: {
    fontSize: 11,
    color: "var(--rv-verde-ok-texto)",
  },
  depois: {
    fontSize: 11.5,
    color: "var(--rv-texto-fraco)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    minWidth: 0,
  },
  espacador: { flex: 1, minWidth: 8 },
  suaVez: {
    fontSize: 11,
    fontWeight: 700,
    color: "var(--rv-verde-ok)",
    whiteSpace: "nowrap",
  },
  botaoAtendi: {
    background: "#16a34a",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "6px 12px",
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  botaoLeve: {
    padding: "5px 10px",
    borderRadius: 8,
    border: `1px solid ${BORDA}`,
    background: "var(--rv-superficie)",
    color: "var(--rv-texto-suave)",
    fontSize: 11.5,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  botaoLeveAtivo: {
    padding: "5px 10px",
    borderRadius: 8,
    border: "1px solid var(--rv-ambar-borda)",
    background: "var(--rv-ambar-fundo)",
    color: "var(--rv-ambar-texto)",
    fontSize: 11.5,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  vazioBarra: {
    fontSize: 12,
    color: "var(--rv-texto-fraco)",
  },
  // ---- gaveta (fechada por padrao) ----
  gaveta: {
    display: "flex",
    flexWrap: "wrap",
    gap: 7,
    marginTop: 7,
    padding: "9px 10px",
    borderRadius: 10,
    border: `1px solid ${BORDA_SUAVE}`,
    background: "var(--rv-superficie)",
  },
  chip: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    padding: "4px 6px 4px 5px",
    borderRadius: 999,
    border: `1px solid ${BORDA_SUAVE}`,
    background: "var(--rv-superficie)",
  },
  chipVez: {
    border: "1px solid var(--rv-verde-ok-borda)",
    background: "var(--rv-verde-ok-fundo)",
  },
  chipEu: { boxShadow: "inset 0 0 0 1px var(--rv-borda-forte)" },
  posicao: {
    width: 19, height: 19, borderRadius: "50%",
    background: "var(--rv-fundo-suave)", color: "var(--rv-texto-suave)",
    fontSize: 10.5, fontWeight: 700,
    display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
  },
  posicaoVez: { background: "#16a34a", color: "#fff" },
  chipNome: {
    fontSize: 12.5, fontWeight: 600, color: "var(--rv-tinta)", whiteSpace: "nowrap",
  },
  chipContador: {
    fontSize: 11, color: "var(--rv-texto-fraco)", whiteSpace: "nowrap",
  },
  chipBotao: {
    border: `1px solid ${BORDA_SUAVE}`,
    background: "var(--rv-superficie)",
    borderRadius: 999,
    width: 24, height: 24, fontSize: 11, lineHeight: 1,
    cursor: "pointer", flexShrink: 0, padding: 0,
  },
};
