import { useMemo, useRef, useState } from "react";
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

  const email = usuarioLogado?.email || "";
  const ehParticipante = operadoresReceptivo.includes(email);
  // Perfis autorizados a registrar atendimento em nome de outro operador.
  // Espelha usuario_e_gestao_fila() no banco: gerencia, supervisor, administrativo
  // + allowlist de gestão (cobranca04, cobranca07 têm perfis equivalentes).
  const PERFIS_PROXY = ["gerencia", "supervisor", "administrativo"];
  const podeMarcarPorOutros = PERFIS_PROXY.includes(usuarioLogado?.perfil);

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
  // Com um e-mail (botão na linha), marca aquele operador — permitido apenas
  // para gestão/supervisão (podeMarcarPorOutros); o botão não aparece para
  // operadores comuns na linha alheia.
  async function marcarAtendido(alvoEmail) {
    const alvo = alvoEmail || email;
    if (!alvo || emAcaoRef.current) return;
    // Guard de autorização: operador só marca o próprio atendimento.
    // Espelha usuario_e_gestao_fila() no banco — a rejeição real vem do banco,
    // esta verificação é defesa em profundidade na interface.
    if (alvo !== email && !podeMarcarPorOutros) return;
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
    // Quem nao e do receptivo nem e gestao nao tem o que fazer com a fila:
    // nao ocupa linha nenhuma no topo da Central. Mesma regra da caixa
    // vertical logo abaixo (!ehParticipante && !podeMarcarPorOutros).
    if (!ehParticipante && !podeMarcarPorOutros) return null;

    const naVez = ordem[0] || null;
    const minhaVez = Boolean(naVez && naVez.email === email);
    const fila = ordem.slice(1);
    // A PILHA e o que impede o cabecalho de virar uma fila extensa: por mais
    // gente que entre, a barra mostra no maximo 6 rostos sobrepostos e fecha
    // o resto num "+N". A altura e a mesma com 3 ou com 30 operadores.
    const PILHA_MAX = 6;
    const naPilha = fila.slice(0, PILHA_MAX);
    const excedente = Math.max(0, fila.length - PILHA_MAX);
    const nomesDaFila = fila.map((l) => nomeExibicao(l)).join(" · ");

    return (
      <div style={B.envoltorio}>
        <div style={B.barra}>
          <span style={B.rotulo}>Receptivo</span>
          <span style={B.contagem}>
            <span style={ordem.length ? B.pontoVerde : B.pontoCinza} />
            {ordem.length} online
          </span>

          <span style={B.risco} />

          {naVez ? (
            <span
              style={minhaVez ? B.naVezEu : B.naVez}
              title={`${nomeExibicao(naVez)} — ${naVez.atendimentos_hoje} atendimento(s) hoje`}
            >
              <AvatarFoto
                usuarioId={perfis[naVez.email]?.id}
                nome={nomeExibicao(naVez)}
                tamanho={22}
              />
              <span style={B.naVezNome}>{nomeExibicao(naVez)}</span>
              <span style={B.naVezEtiqueta}>{minhaVez ? "sua vez" : "na vez"}</span>
            </span>
          ) : (
            <span style={B.vazio}>
              {euEstouEmPausa ? "Você está em pausa" : "Ninguém online no receptivo"}
            </span>
          )}

          {naPilha.length ? (
            <span style={B.pilha} title={`Em seguida: ${nomesDaFila}`}>
              {naPilha.map((linha, indice) => (
                <span
                  key={linha.email}
                  style={{ ...B.pilhaItem, zIndex: PILHA_MAX - indice }}
                >
                  <AvatarFoto
                    usuarioId={perfis[linha.email]?.id}
                    nome={nomeExibicao(linha)}
                    tamanho={24}
                  />
                </span>
              ))}
              {excedente ? <span style={B.pilhaMais}>+{excedente}</span> : null}
            </span>
          ) : null}

          <span style={B.espacador} />

          {ehParticipante ? (
            <>
              <button
                type="button"
                onClick={() => marcarAtendido(email)}
                disabled={marcando}
                style={minhaVez ? B.botaoAtendiVez : B.botaoAtendi}
              >
                {marcando ? "Registrando…" : "Atendi"}
              </button>
              <button
                type="button"
                onClick={() => alternarPausa(!euEstouEmPausa)}
                disabled={marcando}
                style={euEstouEmPausa ? B.botaoLeveAtivo : B.botaoLeve}
              >
                {euEstouEmPausa ? "Voltar" : "Pausar"}
              </button>
            </>
          ) : null}

          {ordem.length ? (
            <button
              type="button"
              onClick={() => setFilaAberta((v) => !v)}
              style={B.botaoGaveta}
              aria-expanded={filaAberta}
              aria-label={filaAberta ? "Fechar a fila" : "Ver a fila inteira"}
              title={filaAberta ? "Fechar a fila" : "Ver a fila inteira"}
            >
              {filaAberta ? "⌃" : "⌄"}
            </button>
          ) : null}
        </div>

        {/* A gaveta: a fila inteira, numerada. Fechada por padrao -- quem so
            quer saber de quem e a vez nunca ve esta lista. */}
        {filaAberta && ordem.length ? (
          <div style={B.gaveta}>
            {ordem.map((linha, indice) => {
              const eu = linha.email === email;
              const primeiro = indice === 0;
              return (
                <div
                  key={linha.email}
                  style={{
                    ...B.linha,
                    ...(primeiro ? B.linhaVez : {}),
                    ...(eu ? B.linhaEu : {}),
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
                  <span style={B.linhaNome}>
                    {nomeExibicao(linha)}
                    {eu ? " (você)" : ""}
                  </span>
                  <span style={B.linhaContador}>{linha.atendimentos_hoje} hoje</span>
                  {/* Mesmo guard da caixa vertical: operador comum so marca o
                      proprio atendimento; a recusa de verdade e do banco. */}
                  {eu || podeMarcarPorOutros ? (
                    <button
                      type="button"
                      onClick={() => marcarAtendido(linha.email)}
                      disabled={marcando}
                      style={B.linhaBotao}
                      title={`Marcar um atendimento para ${nomeExibicao(linha)}`}
                    >
                      Marcar
                    </button>
                  ) : null}
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
    if (!ehParticipante && !podeMarcarPorOutros) return <div style={estilos.espacoReservado} />;
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
              {(eu || podeMarcarPorOutros) && (
                <button
                  type="button"
                  onClick={() => marcarAtendido(linha.email)}
                  disabled={marcando}
                  style={estilos.botaoMarcarLinha}
                  title={`Marcar um atendimento para ${nomeExibicao(linha)}`}
                >
                  ✅ Marcar
                </button>
              )}
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

// Estilos da variante "barra". A caixa vertical acima nao muda em nada.
//
// Duas regras mandam aqui:
//  1. ALTURA CONSTANTE. A barra tem uma linha, com 3 ou com 30 operadores
//     online. Quem nao e a vez vira rosto na pilha, e o excedente vira "+N".
//  2. NAO COMPETIR com a lista de conversas: sem cor forte, sem emoji, sem
//     borda grossa -- o unico destaque e quem esta na vez.
const B = {
  envoltorio: {
    marginBottom: 12,
  },
  barra: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    height: 40,
    padding: "0 12px",
    borderRadius: 10,
    border: `1px solid ${BORDA_SUAVE}`,
    background: "var(--rv-fundo-cartao)",
    overflow: "hidden",
  },
  rotulo: {
    fontSize: 10.5,
    fontWeight: 700,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    color: "var(--rv-texto-fraco)",
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
  contagem: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    fontSize: 11.5,
    color: "var(--rv-texto-suave)",
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
  pontoVerde: {
    width: 6, height: 6, borderRadius: "50%", background: "#16a34a", display: "inline-block",
  },
  pontoCinza: {
    width: 6, height: 6, borderRadius: "50%", background: "var(--rv-texto-fraco)", display: "inline-block",
  },
  risco: {
    width: 1,
    height: 18,
    background: BORDA_SUAVE,
    flexShrink: 0,
  },
  naVez: {
    display: "inline-flex",
    alignItems: "center",
    gap: 7,
    padding: "3px 10px 3px 3px",
    borderRadius: 999,
    background: "var(--rv-superficie)",
    border: `1px solid ${BORDA_SUAVE}`,
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
  naVezEu: {
    display: "inline-flex",
    alignItems: "center",
    gap: 7,
    padding: "3px 10px 3px 3px",
    borderRadius: 999,
    background: "var(--rv-verde-ok-fundo)",
    border: "1px solid var(--rv-verde-ok-borda)",
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
  naVezNome: {
    fontSize: 13,
    fontWeight: 650,
    color: "var(--rv-tinta)",
  },
  naVezEtiqueta: {
    fontSize: 9.5,
    fontWeight: 700,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    color: "var(--rv-verde-ok)",
  },
  // Rostos sobrepostos: cada um entra 8px por cima do anterior.
  pilha: {
    display: "inline-flex",
    alignItems: "center",
    paddingLeft: 8,
    minWidth: 0,
    overflow: "hidden",
  },
  pilhaItem: {
    display: "inline-flex",
    marginLeft: -8,
    borderRadius: "50%",
    boxShadow: "0 0 0 2px var(--rv-fundo-cartao)",
    position: "relative",
    flexShrink: 0,
  },
  pilhaMais: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    marginLeft: -8,
    width: 24,
    height: 24,
    borderRadius: "50%",
    background: "var(--rv-fundo-suave)",
    color: "var(--rv-texto-suave)",
    boxShadow: "0 0 0 2px var(--rv-fundo-cartao)",
    fontSize: 10.5,
    fontWeight: 700,
    flexShrink: 0,
  },
  vazio: {
    fontSize: 12,
    color: "var(--rv-texto-fraco)",
    whiteSpace: "nowrap",
  },
  espacador: { flex: 1, minWidth: 8 },
  botaoAtendi: {
    background: "var(--rv-superficie)",
    color: "var(--rv-texto)",
    border: `1px solid ${BORDA}`,
    borderRadius: 8,
    padding: "5px 12px",
    fontSize: 12,
    fontWeight: 650,
    cursor: "pointer",
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
  // So vira verde cheio quando e a vez DELE: o destaque aparece na hora em
  // que serve para alguma coisa, e nao o tempo todo.
  botaoAtendiVez: {
    background: "#16a34a",
    color: "#fff",
    border: "1px solid #16a34a",
    borderRadius: 8,
    padding: "5px 12px",
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
  botaoLeve: {
    background: "transparent",
    color: "var(--rv-texto-suave)",
    border: `1px solid ${BORDA_SUAVE}`,
    borderRadius: 8,
    padding: "5px 10px",
    fontSize: 12,
    cursor: "pointer",
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
  botaoLeveAtivo: {
    background: "var(--rv-ambar-fundo)",
    color: "var(--rv-ambar-texto)",
    border: "1px solid var(--rv-ambar-borda)",
    borderRadius: 8,
    padding: "5px 10px",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
  botaoGaveta: {
    background: "transparent",
    border: `1px solid ${BORDA_SUAVE}`,
    borderRadius: 8,
    width: 26,
    height: 26,
    padding: 0,
    fontSize: 12,
    lineHeight: 1,
    color: "var(--rv-texto-suave)",
    cursor: "pointer",
    flexShrink: 0,
  },
  // ---- gaveta ----
  gaveta: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))",
    gap: 6,
    marginTop: 6,
    padding: 10,
    borderRadius: 10,
    border: `1px solid ${BORDA_SUAVE}`,
    background: "var(--rv-superficie)",
  },
  linha: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "5px 8px",
    borderRadius: 8,
    border: `1px solid ${BORDA_SUAVE}`,
    background: "var(--rv-superficie)",
    minWidth: 0,
  },
  linhaVez: {
    border: "1px solid var(--rv-verde-ok-borda)",
    background: "var(--rv-verde-ok-fundo)",
  },
  linhaEu: { boxShadow: "inset 0 0 0 1px var(--rv-borda-forte)" },
  posicao: {
    width: 19, height: 19, borderRadius: "50%",
    background: "var(--rv-fundo-suave)", color: "var(--rv-texto-suave)",
    fontSize: 10.5, fontWeight: 700,
    display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
  },
  posicaoVez: { background: "#16a34a", color: "#fff" },
  linhaNome: {
    flex: 1,
    minWidth: 0,
    fontSize: 12.5,
    fontWeight: 600,
    color: "var(--rv-tinta)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  linhaContador: {
    fontSize: 11,
    color: "var(--rv-texto-fraco)",
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
  linhaBotao: {
    border: `1px solid ${BORDA_SUAVE}`,
    background: "var(--rv-superficie)",
    borderRadius: 7,
    padding: "3px 8px",
    fontSize: 11,
    color: "var(--rv-texto-suave)",
    cursor: "pointer",
    whiteSpace: "nowrap",
    flexShrink: 0,
  },
};
