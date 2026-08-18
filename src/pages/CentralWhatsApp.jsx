// Central WhatsApp — os 2 números da operação numa caixa de entrada só.
//
// PRINCÍPIOS DESTA TELA, na ordem em que importam:
//
// 1. "SEM RETORNO" É O FILTRO PADRÃO. O problema da operação não é ler
//    mensagem, é saber quem ficou esperando no meio de milhares de conversas.
//    A tela abre já na fila de quem espera, do mais antigo para o mais novo.
//
// 2. LER NÃO É RESPONDER. Abrir a conversa zera o "não lida", mas ela CONTINUA
//    na fila até alguém responder de verdade. Foi pedido explícito.
//
// 3. A LISTA NÃO CONSULTA A BASE DE ALUNOS. O possível aluno já vem gravado na
//    conversa, identificado uma vez quando ela nasceu. A ficha só é carregada
//    quando o operador abre a conversa. É isso que segura a performance com 11
//    operadores olhando a central ao mesmo tempo.
//
// 4. RESPONSÁVEL EVITA RESPOSTA DOBRADA. Quem responde assume; quem já tem dono
//    não é assumido por outro (só gestão). A trava é do BANCO, não daqui.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../services/supabase";
import { formatarTelefone } from "../utils/telefone";
import {
  FILTRO_MINHAS,
  FILTRO_NAO_LIDAS,
  FILTRO_SEM_RESPONSAVEL,
  FILTRO_SEM_RETORNO,
  ROTULO_CONEXAO,
  ROTULO_STATUS,
  abrirFichaDoAluno,
  assumirConversa,
  buscarAluno,
  carregarCandidatos,
  carregarFichaAluno,
  carregarQr,
  carregarResumo,
  carregarSupervisao,
  carregarSyncStatus,
  comandarSessao,
  encerrarConversa,
  enviarMensagem,
  esperaDesde,
  listarCanais,
  listarConversas,
  listarMensagens,
  listarOperadores,
  marcarLida,
  reabrirConversa,
  retirarResponsavel,
  souGestao,
  transferirConversa,
  vincularAluno,
} from "../services/whatsapp";

const FILTROS_STATUS = [
  { valor: FILTRO_SEM_RETORNO, rotulo: "Sem retorno" },
  { valor: FILTRO_MINHAS, rotulo: "Minhas" },
  { valor: FILTRO_NAO_LIDAS, rotulo: "Não lidas" },
  { valor: FILTRO_SEM_RESPONSAVEL, rotulo: "Aguardando atendimento" },
  { valor: "EM_ATENDIMENTO", rotulo: "Em atendimento" },
  { valor: "ENCERRADO", rotulo: "Finalizadas" },
  { valor: "", rotulo: "Todas" },
];

function horaCurta(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const mesmoDia = d.toDateString() === new Date().toDateString();
  return mesmoDia
    ? d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

function horaCompleta(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

const dinheiro = (v) =>
  v === null || v === undefined
    ? "—"
    : Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

export default function CentralWhatsApp() {
  const [canais, setCanais] = useState([]);
  const [conversas, setConversas] = useState([]);
  const [selecionada, setSelecionada] = useState(null);
  const [mensagens, setMensagens] = useState([]);
  const [operadores, setOperadores] = useState([]);
  const [gestao, setGestao] = useState(false);

  const [filtroStatus, setFiltroStatus] = useState(FILTRO_SEM_RETORNO);
  const [filtroCanal, setFiltroCanal] = useState("");
  const [filtroResponsavel, setFiltroResponsavel] = useState("");
  const [busca, setBusca] = useState("");
  const [resumo, setResumo] = useState(null);
  const [supervisao, setSupervisao] = useState([]);
  const [verSupervisao, setVerSupervisao] = useState(false);
  const [sync, setSync] = useState([]);

  const [ficha, setFicha] = useState(null);
  const [candidatos, setCandidatos] = useState([]);
  const [buscaAluno, setBuscaAluno] = useState("");
  const [achadosAluno, setAchadosAluno] = useState([]);

  const [qrCanal, setQrCanal] = useState(null);
  const [carregandoLista, setCarregandoLista] = useState(true);
  const [carregandoThread, setCarregandoThread] = useState(false);
  const [rascunho, setRascunho] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState("");
  const [som, setSom] = useState(false);

  // Relógio de 1 min só para os contadores de espera reescreverem sozinhos.
  const [, setTique] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTique((n) => n + 1), 60000);
    return () => clearInterval(t);
  }, []);

  const fimDaThreadRef = useRef(null);
  const audioRef = useRef(null);
  // Espelhos para os callbacks do Realtime, que são criados uma vez e não
  // enxergariam o estado novo.
  const selecionadaRef = useRef(null);
  const somRef = useRef(false);
  useEffect(() => { selecionadaRef.current = selecionada; }, [selecionada]);
  useEffect(() => { somRef.current = som; }, [som]);

  // Aviso sonoro discreto, gerado no próprio navegador — sem arquivo para
  // baixar. O navegador só deixa tocar depois de um clique do usuário, por isso
  // é um botão que liga, e não algo ligado por padrão.
  const tocarAviso = useCallback(() => {
    if (!somRef.current) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = audioRef.current || (audioRef.current = new Ctx());
      const osc = ctx.createOscillator();
      const ganho = ctx.createGain();
      osc.frequency.value = 880;
      ganho.gain.setValueAtTime(0.06, ctx.currentTime);
      ganho.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
      osc.connect(ganho);
      ganho.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.25);
    } catch {
      /* som é conforto, não pode derrubar a tela */
    }
  }, []);

  const carregarConversas = useCallback(async () => {
    setCarregandoLista(true);
    try {
      const linhas = await listarConversas({
        status: filtroStatus,
        canalId: filtroCanal,
        busca,
        responsavel: filtroResponsavel,
      });
      setConversas(linhas);
      const atual = selecionadaRef.current;
      if (atual) {
        const atualizada = linhas.find((c) => c.id === atual.id);
        if (atualizada) setSelecionada(atualizada);
      }
      carregarResumo().then(setResumo).catch(() => {});
      listarCanais().then(setCanais).catch(() => {});
    } catch (e) {
      setErro(e.message);
    } finally {
      setCarregandoLista(false);
    }
  }, [filtroStatus, filtroCanal, busca, filtroResponsavel]);

  useEffect(() => {
    listarCanais().then(setCanais).catch((e) => setErro(e.message));
    listarOperadores().then(setOperadores).catch(() => {});
    carregarSyncStatus().then(setSync).catch(() => {});
    souGestao().then(setGestao).catch(() => {});
  }, []);

  useEffect(() => {
    const t = setTimeout(carregarConversas, busca ? 350 : 0);
    return () => clearTimeout(t);
  }, [carregarConversas, busca]);

  // Realtime: UM canal, escutando só mensagem nova. Sem polling — o projeto já
  // teve incidente de carga por excesso de assinatura.
  useEffect(() => {
    const canal = supabase
      .channel("central-whatsapp")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "whatsapp_mensagens" },
        (payload) => {
          const nova = payload?.new;
          if (!nova) return;

          if (nova.direcao === "ENTRADA" && nova.origem === "TEMPO_REAL") tocarAviso();

          const atual = selecionadaRef.current;
          if (atual && nova.conversa_id === atual.id) {
            setMensagens((antes) =>
              antes.some((m) => m.id === nova.id) ? antes : [...antes, nova],
            );
          }
          carregarConversas();
        },
      )
      .subscribe();
    return () => supabase.removeChannel(canal);
  }, [carregarConversas, tocarAviso]);

  useEffect(() => {
    fimDaThreadRef.current?.scrollIntoView({ block: "end" });
  }, [mensagens]);

  // Contador no título da aba: o operador vê que chegou algo mesmo com o CRM
  // numa aba de fundo.
  useEffect(() => {
    const total = resumo?.nao_lidas || 0;
    document.title = total > 0 ? `(${total}) Central WhatsApp` : "Central WhatsApp";
    return () => { document.title = "ReATIVA One"; };
  }, [resumo?.nao_lidas]);

  // Rede de segurança para o Realtime cair calado: ao voltar o foco na aba,
  // recarrega. Debounced, para vários operadores voltando ao mesmo tempo não
  // dispararem enxame de RPC.
  useEffect(() => {
    let agendado = null;
    function aoVoltar() {
      if (document.visibilityState !== "visible" || agendado) return;
      agendado = setTimeout(() => { agendado = null; carregarConversas(); }, 800);
    }
    document.addEventListener("visibilitychange", aoVoltar);
    window.addEventListener("focus", aoVoltar);
    return () => {
      if (agendado) clearTimeout(agendado);
      document.removeEventListener("visibilitychange", aoVoltar);
      window.removeEventListener("focus", aoVoltar);
    };
  }, [carregarConversas]);

  useEffect(() => {
    if (!gestao || !verSupervisao) return;
    carregarSupervisao().then(setSupervisao).catch(() => {});
  }, [gestao, verSupervisao, conversas]);

  async function abrirConversa(conversa) {
    setSelecionada(conversa);
    setErro("");
    setFicha(null);
    setCandidatos([]);
    setAchadosAluno([]);
    setBuscaAluno("");
    setCarregandoThread(true);
    try {
      setMensagens(await listarMensagens(conversa.id));

      // A ficha só é buscada AQUI — nunca na listagem.
      if (conversa.aluno_id) {
        carregarFichaAluno(conversa.id).then(setFicha).catch(() => {});
      } else if (conversa.aluno_status === "AMBIGUO") {
        carregarCandidatos(conversa.id).then((c) => setCandidatos(c || [])).catch(() => {});
      }

      if (conversa.nao_lidas > 0) {
        await marcarLida(conversa.id);
        carregarConversas();
      }
    } catch (e) {
      setErro(e.message);
    } finally {
      setCarregandoThread(false);
    }
  }

  async function enviar() {
    const texto = rascunho.trim();
    if (!texto || !selecionada || enviando) return;
    setEnviando(true);
    setErro("");
    try {
      await enviarMensagem(selecionada.id, texto);
      setRascunho("");
      setMensagens(await listarMensagens(selecionada.id));
      carregarConversas();
    } catch (e) {
      setErro(e.message);
    } finally {
      setEnviando(false);
    }
  }

  async function acao(fn, ...args) {
    if (!selecionada) return;
    setErro("");
    try {
      await fn(selecionada.id, ...args);
      await carregarConversas();
    } catch (e) {
      setErro(e.message);
    }
  }

  async function escolherAluno(alunoId) {
    await acao(vincularAluno, alunoId);
    setCandidatos([]);
    setAchadosAluno([]);
    setBuscaAluno("");
    if (selecionada) carregarFichaAluno(selecionada.id).then(setFicha).catch(() => {});
  }

  async function procurarAluno() {
    const termo = buscaAluno.trim();
    if (!termo) return;
    try {
      setAchadosAluno(await buscarAluno(termo));
    } catch (e) {
      setErro(e.message);
    }
  }

  async function verQr(canal) {
    setErro("");
    try {
      const dados = await carregarQr(canal.id);
      if (!dados?.qr_code) {
        setErro("Não há QR Code válido no momento. Clique em Reconectar e aguarde alguns segundos.");
        return;
      }
      setQrCanal({ ...canal, ...dados });
    } catch (e) {
      setErro(e.message);
    }
  }

  async function comando(canal, cmd) {
    setErro("");
    try {
      await comandarSessao(canal.id, cmd);
      setTimeout(() => listarCanais().then(setCanais).catch(() => {}), 1500);
    } catch (e) {
      setErro(e.message);
    }
  }

  const canalDaConversa = useMemo(
    () => canais.find((c) => c.id === selecionada?.canal_id) || null,
    [canais, selecionada?.canal_id],
  );

  // O composer fecha por motivo REAL e explicado, nunca em silêncio.
  const bloqueio = useMemo(() => {
    if (!selecionada) return null;
    if (canalDaConversa && !canalDaConversa.online) {
      return `O número ${canalDaConversa.apelido} está ${
        ROTULO_CONEXAO[canalDaConversa.conexao_status] || canalDaConversa.conexao_status
      }. A resposta não sai enquanto ele não voltar — a mensagem do aluno continua guardada aqui.`;
    }
    if (selecionada.status === "ENCERRADO") {
      return "Conversa finalizada. Reabra para voltar a responder.";
    }
    return null;
  }, [selecionada, canalDaConversa]);

  const algumCanalFora = canais.some((c) => c.ativo && !c.online);

  return (
    <div style={S.pagina}>
      <div style={S.cabecalho}>
        <div>
          <h1 style={S.titulo}>Central WhatsApp</h1>
          <p style={S.subtitulo}>
            Os {canais.length || 2} números da operação em uma única caixa de entrada
          </p>
        </div>
        <div style={S.cabecalhoAcoes}>
          <button
            style={som ? S.botaoSecAtivo : S.botaoSec}
            onClick={() => { setSom((s) => !s); if (!som) tocarAviso(); }}
            title="Aviso sonoro quando chega mensagem nova"
          >
            {som ? "Som ligado" : "Som desligado"}
          </button>
          {gestao ? (
            <button style={S.botaoSec} onClick={() => setVerSupervisao((v) => !v)}>
              {verSupervisao ? "Ocultar supervisão" : "Supervisão"}
            </button>
          ) : null}
          {/* Rede de segurança para quando o Realtime cai sem avisar. */}
          <button style={S.botaoSec} onClick={carregarConversas}>Atualizar</button>
        </div>
      </div>

      {/* ------------- Estado dos números ------------- */}
      <div style={algumCanalFora ? S.conexoesAlerta : S.conexoes}>
        {canais.length === 0 ? (
          <span style={S.conexaoVazia}>
            Nenhum número cadastrado ainda. A gestão cadastra o canal e depois lê o QR Code.
          </span>
        ) : (
          canais.map((c) => (
            <div key={c.id} style={S.conexao}>
              <span style={c.online ? S.pontoOk : S.pontoRuim} />
              <span style={S.conexaoNome}>{c.apelido}</span>
              <span style={S.conexaoNumero}>{c.display_phone_number}</span>
              <span style={c.online ? S.conexaoStatusOk : S.conexaoStatusRuim}>
                {c.online ? "Conectado" : ROTULO_CONEXAO[c.conexao_status] || c.conexao_status}
              </span>
              {!c.sync_inicial_em ? (
                <span style={S.avisoSync}>histórico ainda não importado</span>
              ) : null}
              {gestao ? (
                <span style={S.conexaoBotoes}>
                  {c.aguardando_qr ? (
                    <button style={S.botaoMini} onClick={() => verQr(c)}>Ver QR Code</button>
                  ) : null}
                  <button style={S.botaoMini} onClick={() => comando(c, "reconectar")}>Reconectar</button>
                </span>
              ) : null}
            </div>
          ))
        )}
      </div>

      {/* ------------- Painel: quem está esperando ------------- */}
      {resumo ? (
        <div style={S.painel}>
          <div style={resumo.sem_retorno > 0 ? S.tileAlerta : S.tile}>
            <span style={S.tileNumero}>{resumo.sem_retorno}</span>
            <span style={S.tileRotulo}>sem retorno</span>
          </div>
          <div style={S.tile}>
            <span style={S.tileNumero}>{resumo.esperando_mais_1h}</span>
            <span style={S.tileRotulo}>esperando +1h</span>
          </div>
          <div style={resumo.esperando_mais_24h > 0 ? S.tileCritico : S.tile}>
            <span style={S.tileNumero}>{resumo.esperando_mais_24h}</span>
            <span style={S.tileRotulo}>esperando +24h</span>
          </div>
          <div style={S.tile}>
            <span style={S.tileNumero}>{resumo.sem_responsavel}</span>
            <span style={S.tileRotulo}>sem responsável</span>
          </div>
          <div style={S.tile}>
            <span style={S.tileNumero}>{resumo.minhas}</span>
            <span style={S.tileRotulo}>minhas</span>
          </div>
          {resumo.pendencias_resgate > 0 ? (
            <div style={S.tileResgate}>
              <span style={S.tileNumero}>{resumo.pendencias_resgate}</span>
              <span style={S.tileRotulo}>pendências resgatadas</span>
            </div>
          ) : null}
          {resumo.espera_mais_antiga ? (
            <div style={S.tileTexto}>
              espera mais antiga: <strong>{esperaDesde(resumo.espera_mais_antiga)?.texto}</strong>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* ------------- Supervisão ------------- */}
      {gestao && verSupervisao ? (
        <div style={S.supervisao}>
          <table style={S.tabela}>
            <thead>
              <tr>
                <th style={S.th}>Responsável</th>
                <th style={S.th}>Em atendimento</th>
                <th style={S.th}>Aguardando resposta</th>
                <th style={S.th}>Não lidas</th>
                <th style={S.th}>Finalizadas hoje</th>
                <th style={S.th}>Espera mais antiga</th>
              </tr>
            </thead>
            <tbody>
              {supervisao.map((l) => (
                <tr key={l.responsavel_email}>
                  <td style={S.td}>{l.responsavel_nome}</td>
                  <td style={S.td}>{l.em_atendimento}</td>
                  <td style={S.td}>{l.aguardando_resposta}</td>
                  <td style={S.td}>{l.nao_lidas}</td>
                  <td style={S.td}>{l.encerradas_hoje}</td>
                  <td style={S.td}>
                    {l.espera_mais_antiga ? esperaDesde(l.espera_mais_antiga)?.texto : "—"}
                  </td>
                </tr>
              ))}
              {supervisao.length === 0 ? (
                <tr><td style={S.td} colSpan={6}>Nada em atendimento no momento.</td></tr>
              ) : null}
            </tbody>
          </table>
          {sync.length > 0 ? (
            <div style={S.syncLinha}>
              {sync.map((s) => (
                <span key={s.canal_id} style={S.syncItem}>
                  <strong>{s.canal_apelido}</strong>: importação {s.status.toLowerCase()} ·{" "}
                  {s.conversas_criadas} conversas · {s.mensagens_importadas} mensagens ·{" "}
                  {s.pendencias_detectadas} possíveis pendências
                  {s.erro ? ` · erro: ${s.erro}` : ""}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {erro ? (
        <div style={S.erro}>
          {erro}
          <button style={S.fecharErro} onClick={() => setErro("")}>×</button>
        </div>
      ) : null}

      <div style={S.corpo}>
        {/* ---------------- Lista de conversas ---------------- */}
        <aside style={S.coluna}>
          <div style={S.filtros}>
            <input
              style={S.busca}
              placeholder="Buscar por nome, telefone, CPF ou matrícula"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
            />
            <div style={S.chips}>
              {FILTROS_STATUS.map((f) => (
                <button
                  key={f.valor || "todas"}
                  onClick={() => setFiltroStatus(f.valor)}
                  style={filtroStatus === f.valor ? S.chipAtivo : S.chip}
                >
                  {f.rotulo}
                </button>
              ))}
            </div>
            <div style={S.selects}>
              {canais.length > 1 ? (
                <select style={S.select} value={filtroCanal} onChange={(e) => setFiltroCanal(e.target.value)}>
                  <option value="">Todos os números</option>
                  {canais.map((c) => (
                    <option key={c.id} value={c.id}>{c.apelido} · {c.display_phone_number}</option>
                  ))}
                </select>
              ) : null}
              <select
                style={S.select}
                value={filtroResponsavel}
                onChange={(e) => setFiltroResponsavel(e.target.value)}
              >
                <option value="">Qualquer responsável</option>
                {operadores.map((o) => (
                  <option key={o.email} value={o.email}>{o.nome}</option>
                ))}
              </select>
            </div>
          </div>

          <div style={S.lista}>
            {carregandoLista ? (
              <div style={S.vazio}>Carregando…</div>
            ) : conversas.length === 0 ? (
              <div style={S.vazio}>
                Nenhuma conversa neste filtro.
                <br />
                <span style={S.vazioDica}>
                  As mensagens aparecem sozinhas assim que os números estiverem conectados.
                </span>
              </div>
            ) : (
              conversas.map((c) => {
                const ativa = selecionada?.id === c.id;
                const espera = c.aguardando_resposta ? esperaDesde(c.aguardando_desde) : null;
                return (
                  <button key={c.id} onClick={() => abrirConversa(c)} style={ativa ? S.itemAtivo : S.item}>
                    <div style={S.itemTopo}>
                      <span style={S.itemNome}>
                        {c.aluno_nome || c.nome_perfil || formatarTelefone(c.telefone_e164)}
                      </span>
                      <span style={S.itemHora}>{horaCurta(c.ultima_mensagem_em)}</span>
                    </div>

                    {/* Identificação leve: um palpite honesto, sem carregar ficha. */}
                    {c.aluno_status === "IDENTIFICADO" && c.aluno_nome ? (
                      <div style={S.possivelAluno}>Possível aluno: {c.aluno_nome}</div>
                    ) : c.aluno_status === "AMBIGUO" ? (
                      <div style={S.alunoAmbiguo}>Mais de um aluno com este telefone</div>
                    ) : null}

                    <div style={S.itemPrevia}>{c.ultima_mensagem_previa || "—"}</div>

                    <div style={S.itemRodape}>
                      <span style={S.etiquetaCanal}>{c.canal_apelido}</span>
                      {c.responsavel_nome ? (
                        <span style={S.etiquetaDono}>{c.responsavel_nome}</span>
                      ) : (
                        <span style={S.etiquetaLivre}>sem responsável</span>
                      )}
                      {espera ? (
                        <span style={S.esperaEstilo[espera.nivel]}>esperando {espera.texto}</span>
                      ) : (
                        <span style={S.etiquetaStatus}>{ROTULO_STATUS[c.status] || c.status}</span>
                      )}
                      {c.origem_sync ? <span style={S.etiquetaResgate}>resgatada</span> : null}
                      {c.nao_lidas > 0 ? <span style={S.badge}>{c.nao_lidas}</span> : null}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </aside>

        {/* ---------------- Conversa aberta ---------------- */}
        <section style={S.thread}>
          {!selecionada ? (
            <div style={S.vazioThread}>Escolha uma conversa à esquerda.</div>
          ) : (
            <>
              <div style={S.threadTopo}>
                <div>
                  <div style={S.threadNome}>
                    {selecionada.aluno_nome || selecionada.nome_perfil ||
                      formatarTelefone(selecionada.telefone_e164)}
                  </div>
                  <div style={S.threadInfo}>
                    {formatarTelefone(selecionada.telefone_e164)} · recebido em{" "}
                    <strong>{selecionada.canal_apelido}</strong> ({selecionada.canal_numero})
                  </div>
                  <div style={S.threadDono}>
                    {selecionada.responsavel_nome
                      ? <>Responsável: <strong>{selecionada.responsavel_nome}</strong></>
                      : "Sem responsável"}
                  </div>
                </div>
                <div style={S.threadAcoes}>
                  {selecionada.responsavel_email ? (
                    <button style={S.botaoSec} onClick={() => acao(retirarResponsavel)}>
                      Retirar responsável
                    </button>
                  ) : (
                    <button style={S.botaoSec} onClick={() => acao(assumirConversa)}>Assumir</button>
                  )}
                  <select
                    style={S.selectAcao}
                    value=""
                    onChange={(e) => { if (e.target.value) acao(transferirConversa, e.target.value); }}
                  >
                    <option value="">Transferir para…</option>
                    {operadores
                      .filter((o) => o.email !== selecionada.responsavel_email)
                      .map((o) => <option key={o.email} value={o.email}>{o.nome}</option>)}
                  </select>
                  {selecionada.status === "ENCERRADO" ? (
                    <button style={S.botaoSec} onClick={() => acao(reabrirConversa)}>Reabrir</button>
                  ) : (
                    <button style={S.botaoSec} onClick={() => acao(encerrarConversa)}>Finalizar</button>
                  )}
                </div>
              </div>

              {/* Ambiguidade: a tela NUNCA escolhe sozinha. Quem decide é gente. */}
              {selecionada.aluno_status === "AMBIGUO" || !selecionada.aluno_id ? (
                <div style={S.blocoAluno}>
                  {candidatos.length > 0 ? (
                    <>
                      <span style={S.blocoAlunoTitulo}>
                        Este telefone aparece em {candidatos.length} alunos. Qual deles é?
                      </span>
                      <div style={S.candidatos}>
                        {candidatos.map((c) => (
                          <button key={c.id} style={S.botaoMini} onClick={() => escolherAluno(c.id)}>
                            {c.nome}{c.matricula ? ` · ${c.matricula}` : ""}
                          </button>
                        ))}
                      </div>
                    </>
                  ) : (
                    <>
                      <span style={S.blocoAlunoTitulo}>Aluno não identificado pelo telefone.</span>
                      <div style={S.linhaBuscaAluno}>
                        <input
                          style={S.buscaAluno}
                          placeholder="Vincular à mão: nome, CPF ou matrícula"
                          value={buscaAluno}
                          onChange={(e) => setBuscaAluno(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") procurarAluno(); }}
                        />
                        <button style={S.botaoMini} onClick={procurarAluno}>Procurar</button>
                      </div>
                      <div style={S.candidatos}>
                        {achadosAluno.map((a) => (
                          <button key={a.id} style={S.botaoMini} onClick={() => escolherAluno(a.id)}>
                            {a.nome}{a.matricula ? ` · ${a.matricula}` : ""}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              ) : null}

              {/* Ficha leve, carregada só agora. O pesado fica na ficha completa. */}
              {ficha ? (
                <div style={S.fichaBox}>
                  <div style={S.fichaLinha}>
                    <strong>{ficha.nome}</strong>
                    {ficha.matricula ? <span style={S.fichaItem}>matrícula {ficha.matricula}</span> : null}
                    {ficha.cpf_mascarado ? <span style={S.fichaItem}>CPF {ficha.cpf_mascarado}</span> : null}
                    <button style={S.botaoMini} onClick={() => abrirFichaDoAluno(ficha.aluno_id)}>
                      Abrir ficha completa
                    </button>
                  </div>
                  <div style={S.fichaLinha}>
                    {ficha.curso ? <span style={S.fichaItem}>{ficha.curso}</span> : null}
                    {ficha.unidade ? <span style={S.fichaItem}>{ficha.unidade}</span> : null}
                    {ficha.situacao_academica ? <span style={S.fichaItem}>{ficha.situacao_academica}</span> : null}
                    {ficha.situacao_operacional ? <span style={S.fichaItem}>{ficha.situacao_operacional}</span> : null}
                  </div>
                  <div style={S.fichaLinha}>
                    <span style={S.fichaItem}>vencido: <strong>{dinheiro(ficha.saldo_vencido)}</strong></span>
                    <span style={S.fichaItem}>total: <strong>{dinheiro(ficha.saldo_total)}</strong></span>
                    <span style={S.fichaItem}>
                      negociações ativas: <strong>{ficha.acordos_ativos ?? 0}</strong>
                    </span>
                    {ficha.responsavel_carteira ? (
                      <span style={S.fichaItem}>carteira: {ficha.responsavel_carteira}</span>
                    ) : null}
                  </div>
                </div>
              ) : null}

              <div style={S.mensagens}>
                {carregandoThread ? (
                  <div style={S.vazio}>Carregando conversa…</div>
                ) : (
                  mensagens.map((m) => {
                    const saida = m.direcao === "SAIDA";
                    return (
                      <div key={m.id} style={saida ? S.balaoSaidaWrap : S.balaoEntradaWrap}>
                        <div style={saida ? S.balaoSaida : S.balaoEntrada}>
                          {m.texto || <em style={S.midia}>[{m.tipo}]</em>}
                          <div style={S.balaoRodape}>
                            {horaCompleta(m.timestamp_wa)}
                            {saida && m.enviado_por_email ? ` · ${m.enviado_por_email}` : ""}
                            {saida && !m.enviado_por_email ? " · enviada pelo celular" : ""}
                            {m.origem === "SYNC_INICIAL" ? " · do histórico" : ""}
                            {saida && m.status ? ` · ${m.status.toLowerCase()}` : ""}
                          </div>
                          {m.erro_detalhe ? <div style={S.balaoErro}>{m.erro_detalhe}</div> : null}
                        </div>
                      </div>
                    );
                  })
                )}
                <div ref={fimDaThreadRef} />
              </div>

              <div style={S.composer}>
                {bloqueio ? (
                  <div style={S.composerBloqueado}>{bloqueio}</div>
                ) : (
                  <div style={S.composerLinha}>
                    <textarea
                      style={S.campo}
                      rows={2}
                      placeholder="Escreva a resposta…"
                      value={rascunho}
                      onChange={(e) => setRascunho(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); enviar(); }
                      }}
                    />
                    <button
                      style={enviando || !rascunho.trim() ? S.botaoOff : S.botao}
                      disabled={enviando || !rascunho.trim()}
                      onClick={enviar}
                    >
                      {enviando ? "Enviando…" : "Enviar"}
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </section>
      </div>

      {/* ---------------- QR Code (gestão) ---------------- */}
      {qrCanal ? (
        <div style={S.modalFundo} onClick={() => setQrCanal(null)}>
          <div style={S.modal} onClick={(e) => e.stopPropagation()}>
            <h2 style={S.modalTitulo}>Conectar {qrCanal.apelido}</h2>
            <p style={S.modalTexto}>
              No celular: <strong>Configurações → Aparelhos conectados → Conectar aparelho</strong>.
            </p>
            <img src={qrCanal.qr_code} alt="QR Code" style={S.qr} />
            <p style={S.modalAviso}>
              O código muda a cada poucos segundos. Se vencer, feche e abra de novo.
              <br />
              <strong>Antes de ler:</strong> desconecte as outras sessões de WhatsApp Web —
              a conta só permite 4 aparelhos e uma delas pode derrubar esta.
              <br />
              O histórico do aparelho é importado <strong>uma única vez</strong>, agora.
            </p>
            <button style={S.botaoSec} onClick={() => setQrCanal(null)}>Fechar</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Estilos. Objeto único no fim do arquivo, no padrão das outras telas do CRM.
// ---------------------------------------------------------------------------
const CINZA = "#64748b";
const BORDA = "#e2e8f0";
const VERDE = "#16a34a";
const VERMELHO = "#dc2626";
const LARANJA = "#ea580c";
const AZUL = "#2563eb";

const etiquetaBase = {
  fontSize: 11,
  padding: "2px 7px",
  borderRadius: 999,
  whiteSpace: "nowrap",
};

const tileBase = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  minWidth: 92,
  padding: "8px 12px",
  borderRadius: 10,
  background: "#f8fafc",
  border: `1px solid ${BORDA}`,
};

const botaoBase = {
  padding: "8px 14px",
  borderRadius: 8,
  border: `1px solid ${BORDA}`,
  background: "#fff",
  cursor: "pointer",
  fontSize: 13,
};

const balaoBase = {
  maxWidth: "72%",
  padding: "8px 11px",
  borderRadius: 12,
  fontSize: 14,
  lineHeight: 1.45,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const S = {
  pagina: { padding: 16, maxWidth: 1500, margin: "0 auto" },

  cabecalho: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 },
  cabecalhoAcoes: { display: "flex", gap: 8, flexWrap: "wrap" },
  titulo: { margin: 0, fontSize: 22, fontWeight: 700 },
  subtitulo: { margin: "4px 0 0", fontSize: 13, color: CINZA },

  // ---- estado das conexões ----
  conexoes: {
    display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center",
    margin: "12px 0", padding: "10px 12px", borderRadius: 10,
    border: `1px solid ${BORDA}`, background: "#f8fafc",
  },
  conexoesAlerta: {
    display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center",
    margin: "12px 0", padding: "10px 12px", borderRadius: 10,
    border: "1px solid #fecaca", background: "#fef2f2",
  },
  conexao: { display: "flex", alignItems: "center", gap: 8, fontSize: 13 },
  conexaoVazia: { fontSize: 13, color: CINZA },
  conexaoNome: { fontWeight: 600 },
  conexaoNumero: { color: CINZA, fontSize: 12 },
  conexaoStatusOk: { ...etiquetaBase, background: "#dcfce7", color: "#166534" },
  conexaoStatusRuim: { ...etiquetaBase, background: "#fee2e2", color: "#991b1b" },
  conexaoBotoes: { display: "flex", gap: 6 },
  pontoOk: { width: 8, height: 8, borderRadius: "50%", background: VERDE },
  pontoRuim: { width: 8, height: 8, borderRadius: "50%", background: VERMELHO },
  avisoSync: { ...etiquetaBase, background: "#fef3c7", color: "#92400e" },

  // ---- painel ----
  painel: { display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", margin: "0 0 12px" },
  tile: tileBase,
  tileAlerta: { ...tileBase, background: "#fff7ed", borderColor: "#fed7aa" },
  tileCritico: { ...tileBase, background: "#fef2f2", borderColor: "#fecaca" },
  tileResgate: { ...tileBase, background: "#eff6ff", borderColor: "#bfdbfe" },
  tileNumero: { fontSize: 20, fontWeight: 700 },
  tileRotulo: { fontSize: 11, color: CINZA, textAlign: "center" },
  tileTexto: { fontSize: 12, color: CINZA },

  // ---- supervisão ----
  supervisao: {
    margin: "0 0 12px", padding: 12, borderRadius: 10,
    border: `1px solid ${BORDA}`, background: "#fff", overflowX: "auto",
  },
  tabela: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", padding: "6px 8px", borderBottom: `1px solid ${BORDA}`, color: CINZA, fontWeight: 600 },
  td: { padding: "6px 8px", borderBottom: "1px solid #f1f5f9" },
  syncLinha: { display: "flex", flexWrap: "wrap", gap: 14, marginTop: 10, fontSize: 12, color: CINZA },
  syncItem: { whiteSpace: "nowrap" },

  erro: {
    display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8,
    padding: "9px 12px", marginBottom: 12, borderRadius: 8,
    background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", fontSize: 13,
  },
  fecharErro: { border: "none", background: "transparent", cursor: "pointer", fontSize: 18, color: "#991b1b" },

  // ---- corpo ----
  corpo: { display: "grid", gridTemplateColumns: "minmax(300px, 380px) 1fr", gap: 14, alignItems: "start" },
  coluna: { border: `1px solid ${BORDA}`, borderRadius: 12, background: "#fff", overflow: "hidden" },

  filtros: { padding: 10, borderBottom: `1px solid ${BORDA}`, display: "flex", flexDirection: "column", gap: 8 },
  busca: { padding: "8px 10px", borderRadius: 8, border: `1px solid ${BORDA}`, fontSize: 13, width: "100%", boxSizing: "border-box" },
  chips: { display: "flex", flexWrap: "wrap", gap: 6 },
  chip: { ...etiquetaBase, border: `1px solid ${BORDA}`, background: "#fff", color: CINZA, cursor: "pointer", padding: "4px 9px" },
  chipAtivo: { ...etiquetaBase, border: `1px solid ${AZUL}`, background: "#eff6ff", color: AZUL, cursor: "pointer", padding: "4px 9px", fontWeight: 600 },
  selects: { display: "flex", gap: 6, flexWrap: "wrap" },
  select: { flex: 1, minWidth: 130, padding: "7px 8px", borderRadius: 8, border: `1px solid ${BORDA}`, fontSize: 12, background: "#fff" },

  lista: { maxHeight: "62vh", overflowY: "auto" },
  vazio: { padding: 20, textAlign: "center", color: CINZA, fontSize: 13 },
  vazioDica: { fontSize: 12, color: "#94a3b8" },

  item: {
    display: "block", width: "100%", textAlign: "left", padding: "10px 12px",
    border: "none", borderBottom: "1px solid #f1f5f9", background: "#fff", cursor: "pointer",
  },
  itemAtivo: {
    display: "block", width: "100%", textAlign: "left", padding: "10px 12px",
    border: "none", borderBottom: "1px solid #f1f5f9", background: "#eff6ff",
    cursor: "pointer", boxShadow: `inset 3px 0 0 ${AZUL}`,
  },
  itemTopo: { display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" },
  itemNome: { fontWeight: 600, fontSize: 13.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  itemHora: { fontSize: 11, color: CINZA, whiteSpace: "nowrap" },
  possivelAluno: { fontSize: 11, color: VERDE, marginTop: 2 },
  alunoAmbiguo: { fontSize: 11, color: LARANJA, marginTop: 2 },
  itemPrevia: {
    fontSize: 12, color: CINZA, marginTop: 3,
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  },
  itemRodape: { display: "flex", flexWrap: "wrap", gap: 5, alignItems: "center", marginTop: 6 },

  etiquetaCanal: { ...etiquetaBase, background: "#f1f5f9", color: "#475569" },
  etiquetaStatus: { ...etiquetaBase, background: "#f1f5f9", color: CINZA },
  etiquetaDono: { ...etiquetaBase, background: "#ede9fe", color: "#5b21b6" },
  etiquetaLivre: { ...etiquetaBase, background: "#fef3c7", color: "#92400e" },
  etiquetaResgate: { ...etiquetaBase, background: "#eff6ff", color: "#1d4ed8" },
  badge: {
    ...etiquetaBase, background: VERDE, color: "#fff", fontWeight: 700, minWidth: 18, textAlign: "center",
  },
  // Quanto mais tempo esperando, mais forte a cor. É o que diz por onde começar.
  esperaEstilo: {
    calmo: { ...etiquetaBase, background: "#f1f5f9", color: CINZA },
    atencao: { ...etiquetaBase, background: "#fff7ed", color: "#9a3412" },
    critico: { ...etiquetaBase, background: "#fef2f2", color: "#991b1b", fontWeight: 600 },
  },

  // ---- thread ----
  thread: {
    border: `1px solid ${BORDA}`, borderRadius: 12, background: "#fff",
    display: "flex", flexDirection: "column", minHeight: "62vh",
  },
  vazioThread: { padding: 40, textAlign: "center", color: CINZA, fontSize: 14 },
  threadTopo: {
    display: "flex", justifyContent: "space-between", alignItems: "flex-start",
    gap: 12, padding: 12, borderBottom: `1px solid ${BORDA}`, flexWrap: "wrap",
  },
  threadNome: { fontWeight: 700, fontSize: 15 },
  threadInfo: { fontSize: 12, color: CINZA, marginTop: 2 },
  threadDono: { fontSize: 12, color: "#5b21b6", marginTop: 4 },
  threadAcoes: { display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" },
  selectAcao: { padding: "8px 10px", borderRadius: 8, border: `1px solid ${BORDA}`, fontSize: 13, background: "#fff", cursor: "pointer" },

  blocoAluno: {
    padding: "10px 12px", borderBottom: `1px solid ${BORDA}`,
    background: "#fffbeb", display: "flex", flexDirection: "column", gap: 8,
  },
  blocoAlunoTitulo: { fontSize: 12.5, color: "#92400e", fontWeight: 600 },
  candidatos: { display: "flex", flexWrap: "wrap", gap: 6 },
  linhaBuscaAluno: { display: "flex", gap: 6 },
  buscaAluno: { flex: 1, padding: "7px 9px", borderRadius: 8, border: `1px solid ${BORDA}`, fontSize: 12.5 },

  fichaBox: {
    padding: "10px 12px", borderBottom: `1px solid ${BORDA}`,
    background: "#f8fafc", display: "flex", flexDirection: "column", gap: 5,
  },
  fichaLinha: { display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", fontSize: 12.5 },
  fichaItem: { color: "#475569" },

  mensagens: { flex: 1, overflowY: "auto", maxHeight: "48vh", padding: 14, display: "flex", flexDirection: "column", gap: 8 },
  balaoEntradaWrap: { display: "flex", justifyContent: "flex-start" },
  balaoSaidaWrap: { display: "flex", justifyContent: "flex-end" },
  balaoEntrada: { ...balaoBase, background: "#f1f5f9", color: "#0f172a" },
  balaoSaida: { ...balaoBase, background: "#dcfce7", color: "#052e16" },
  balaoRodape: { fontSize: 10.5, color: CINZA, marginTop: 4 },
  balaoErro: { fontSize: 11, color: "#991b1b", marginTop: 3 },
  midia: { color: CINZA },

  composer: { borderTop: `1px solid ${BORDA}`, padding: 12 },
  composerLinha: { display: "flex", gap: 8, alignItems: "flex-end" },
  composerBloqueado: {
    padding: "10px 12px", borderRadius: 8, background: "#fef2f2",
    border: "1px solid #fecaca", color: "#991b1b", fontSize: 12.5, lineHeight: 1.5,
  },
  campo: {
    flex: 1, padding: "9px 11px", borderRadius: 8, border: `1px solid ${BORDA}`,
    fontSize: 14, fontFamily: "inherit", resize: "vertical",
  },

  botao: { ...botaoBase, background: VERDE, color: "#fff", border: `1px solid ${VERDE}`, fontWeight: 600 },
  botaoOff: { ...botaoBase, background: "#e2e8f0", color: "#94a3b8", cursor: "not-allowed" },
  botaoSec: botaoBase,
  botaoSecAtivo: { ...botaoBase, background: "#eff6ff", borderColor: AZUL, color: AZUL, fontWeight: 600 },
  botaoMini: { ...botaoBase, padding: "4px 9px", fontSize: 12 },

  // ---- modal do QR ----
  modalFundo: {
    position: "fixed", inset: 0, background: "rgba(15,23,42,.55)",
    display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 60,
  },
  modal: {
    background: "#fff", borderRadius: 14, padding: 22, maxWidth: 440,
    textAlign: "center", display: "flex", flexDirection: "column", gap: 10, alignItems: "center",
  },
  modalTitulo: { margin: 0, fontSize: 18 },
  modalTexto: { margin: 0, fontSize: 13, color: CINZA },
  qr: { width: 260, height: 260, imageRendering: "pixelated" },
  modalAviso: { margin: 0, fontSize: 11.5, color: CINZA, lineHeight: 1.6 },
};
