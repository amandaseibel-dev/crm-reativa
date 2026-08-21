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
import { formatarTelefone, normalizarE164 } from "../utils/telefone";
import AnexoWhatsApp from "../components/AnexoWhatsApp";
// A ficha COMPLETA, embutida. É o mesmo componente da tela /aluno: aqui ele
// recebe `fichaEmbedId` e se comporta como conteúdo, não como página — o padrão
// que Agenda Operacional, Saúde da Base e as filas de confirmação já usam.
import Aluno from "./Aluno";
import {
  FILTRO_ARQUIVADAS,
  FILTRO_MINHAS,
  FILTRO_NAO_LIDAS,
  FILTRO_RESGATE,
  FILTRO_SEM_RESPONSAVEL,
  FILTRO_SEM_RETORNO,
  ROTULO_CONEXAO,
  TEMPOS_SEM_INTERACAO,
  ROTULO_STATUS,
  assumirConversa,
  buscarAluno,
  carregarCandidatos,
  carregarFichaAluno,
  carregarQr,
  carregarResumo,
  carregarCadencia,
  carregarSupervisao,
  carregarSyncStatus,
  comandarSessao,
  arquivarConversa,
  desarquivarConversa,
  encerrarConversa,
  enviarDocumento,
  enviarMensagem,
  esperaDesde,
  iniciarConversa,
  listarCanais,
  listarConversas,
  listarMensagens,
  listarOperadores,
  marcarLida,
  procurarConversaPorTelefone,
  reabrirConversa,
  retirarResponsavel,
  salvarCadenciaCanal,
  salvarCanal,
  souGestao,
  transferirConversa,
  vincularAluno,
} from "../services/whatsapp";

const FILTROS_STATUS = [
  { valor: FILTRO_SEM_RETORNO, rotulo: "Sem retorno" },
  { valor: FILTRO_RESGATE, rotulo: "Resgate" },
  { valor: FILTRO_MINHAS, rotulo: "Minhas" },
  { valor: FILTRO_NAO_LIDAS, rotulo: "Não lidas" },
  { valor: FILTRO_SEM_RESPONSAVEL, rotulo: "Aguardando atendimento" },
  { valor: FILTRO_ARQUIVADAS, rotulo: "Arquivadas" },
  { valor: "EM_ATENDIMENTO", rotulo: "Em atendimento" },
  { valor: "ENCERRADO", rotulo: "Finalizadas" },
  { valor: "", rotulo: "Todas" },
];

// O banco devolve `time` como "09:00:00"; a tela mostra "09:00".
function horaSemSegundos(t) {
  return String(t || "").slice(0, 5);
}

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

// ---------------------------------------------------------------------------
// A CENTRAL NÃO SAI DO LUGAR
//
// A ficha do aluno abre EM POPUP, por cima da conversa (ver `FichaDoAluno`, no
// fim do arquivo). Não há mais navegação para /aluno e, com ela, sumiu todo o
// aparato que existia para sobreviver à ida e à volta: o retrato de filtros no
// sessionStorage, a restauração só em navegação POP e o cuidado de nunca gravar
// o texto da busca (que é PII — a caixa aceita CPF e telefone). Nada disso é
// necessário quando ninguém sai: o estado da tela nunca é desmontado.
//
// Se algum dia a Central voltar a navegar para fora, isto tem de voltar junto —
// o histórico está no PR #107 e nos anteriores (#96/#97).
// ---------------------------------------------------------------------------
export default function CentralWhatsApp() {

  const [canais, setCanais] = useState([]);
  const [conversas, setConversas] = useState([]);
  const [selecionada, setSelecionada] = useState(null);
  const [mensagens, setMensagens] = useState([]);
  const [operadores, setOperadores] = useState([]);
  const [gestao, setGestao] = useState(false);

  const [filtroStatus, setFiltroStatus] = useState(FILTRO_SEM_RETORNO);
  const [filtroCanal, setFiltroCanal] = useState("");
  const [filtroTempo, setFiltroTempo] = useState("");
  // Agrupa as recargas da lista disparadas pelo Realtime (ver o handler abaixo).
  const recargaRef = useRef(null);
  const [filtroResponsavel, setFiltroResponsavel] = useState("");
  // Busca NÃO é restaurada: ver o bloco acima — o que se digita aqui é PII.
  const [busca, setBusca] = useState("");
  const [resumo, setResumo] = useState(null);
  const [cadencia, setCadencia] = useState([]);
  const [supervisao, setSupervisao] = useState([]);
  const [verSupervisao, setVerSupervisao] = useState(false);
  const [sync, setSync] = useState([]);

  const [ficha, setFicha] = useState(null);
  // Ficha do aluno EM CIMA da conversa. Guarda o ID, e não um booleano: é ele
  // que a ficha embutida consome, e prender a ficha ao aluno que estava aberto
  // evita que uma troca de conversa no meio do caminho abra a ficha de outro.
  const [fichaAbertaId, setFichaAbertaId] = useState(null);
  const [candidatos, setCandidatos] = useState([]);
  const [buscaAluno, setBuscaAluno] = useState("");
  const [achadosAluno, setAchadosAluno] = useState([]);

  const [qrCanal, setQrCanal] = useState(null);
  const [novaAberta, setNovaAberta] = useState(false);
  const [canaisAberto, setCanaisAberto] = useState(false);
  // Desvincular obriga a reparear e queima a única chance de importar
  // histórico. Nunca em um clique só.
  const [confirmandoLogout, setConfirmandoLogout] = useState(null);
  // Conversa recém-criada que precisa ser aberta assim que aparecer na lista.
  const pendenteAbrirRef = useRef(null);
  const [carregandoLista, setCarregandoLista] = useState(true);
  const [carregandoThread, setCarregandoThread] = useState(false);
  const [arquivando, setArquivando] = useState(false);
  const [rascunho, setRascunho] = useState("");
  const [enviando, setEnviando] = useState(false);
  // Anexo: um estado só, com o nome do arquivo junto. "enviando" sem dizer O
  // QUE está subindo não ajuda quem mandou o arquivo errado.
  const [anexo, setAnexo] = useState(null); // { nome, estado: ENVIANDO|ENVIADO|ERRO, erro }
  const seletorArquivoRef = useRef(null);
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
        tempoSemInteracao: filtroTempo,
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
      carregarCadencia().then(setCadencia).catch(() => {});
    } catch (e) {
      setErro(e.message);
    } finally {
      setCarregandoLista(false);
    }
  }, [filtroStatus, filtroCanal, filtroTempo, busca, filtroResponsavel]);

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

          // A thread ABERTA continua imediata: quem está lendo a conversa vê a
          // mensagem aparecer na hora.
          const atual = selecionadaRef.current;
          if (atual && nova.conversa_id === atual.id) {
            setMensagens((antes) =>
              antes.some((m) => m.id === nova.id) ? antes : [...antes, nova],
            );
          }

          // A LISTA é recarregada em lote, não a cada INSERT.
          //
          // POR QUE: `carregarConversas()` direto aqui refazia a lista inteira a
          // cada mensagem. Numa importação de histórico (20/08: 1,2 inserções
          // por segundo por horas) a Central re-renderizava sem parar e piscava
          // na cara do operador. Agrupar em 600ms transforma uma rajada numa
          // recarga só, e a ordenação nova já coloca a conversa no topo — o
          // comportamento visível continua o mesmo, sem o tremor.
          if (recargaRef.current) clearTimeout(recargaRef.current);
          recargaRef.current = setTimeout(() => {
            recargaRef.current = null;
            carregarConversas();
          }, 600);
        },
      )
      .subscribe();
    return () => {
      if (recargaRef.current) clearTimeout(recargaRef.current);
      supabase.removeChannel(canal);
    };
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

  // A conversa criada agora só existe na tela depois que a lista recarrega.
  // Em vez de adivinhar o tempo, espera ela aparecer e então abre.
  useEffect(() => {
    const alvo = pendenteAbrirRef.current;
    // `carregandoLista` começa true: sem esta guarda, a lista VAZIA do primeiro
    // render contaria como "não achei" e mataria a restauração antes de a
    // primeira lista de verdade chegar.
    if (!alvo || carregandoLista) return;
    const achou = conversas.find((c) => c.id === alvo);
    if (achou) {
      pendenteAbrirRef.current = null;
      abrirConversa(achou);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversas, carregandoLista]);

  function aoCriarConversa(conversaId) {
    setNovaAberta(false);
    if (!conversaId) {
      carregarConversas();
      return;
    }
    pendenteAbrirRef.current = conversaId;
    // Conversa que EU iniciei não está "sem retorno" — ninguém está esperando
    // resposta minha ainda. No filtro padrão ela ficaria invisível logo depois
    // de criada, que é a pior hora para sumir. Vai para "Minhas", onde ela
    // acabou de entrar.
    setFiltroStatus(FILTRO_MINHAS);
    setFiltroCanal("");
    setFiltroResponsavel("");
    setBusca("");
    carregarConversas();
  }

  async function abrirConversa(conversa) {
    setSelecionada(conversa);
    setErro("");
    setAnexo(null);
    setFicha(null);
    setFichaAbertaId(null);
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

  // Anexar PDF. Estado visível o tempo todo: enviando, enviado, erro.
  //
  // O SELETOR É LIMPO SEMPRE, no fim. Sem isso, escolher o MESMO arquivo de
  // novo (depois de um erro, que é justamente quando se tenta de novo) não
  // dispara `change` e o botão parece morto.
  async function anexarPdf(arquivo) {
    if (!arquivo || !selecionada || enviando) return;
    setErro("");
    setAnexo({ nome: arquivo.name, estado: "ENVIANDO" });
    setEnviando(true);
    try {
      await enviarDocumento(selecionada.id, arquivo);
      setAnexo({ nome: arquivo.name, estado: "ENVIADO" });
      setMensagens(await listarMensagens(selecionada.id));
      carregarConversas();
    } catch (e) {
      // ERRO NÃO PODE PARECER ENVIADO. O estado fica em ERRO com o motivo, e a
      // thread é recarregada mesmo assim: o backend registra a tentativa como
      // FALHOU, e o operador precisa ver esse registro.
      setAnexo({ nome: arquivo.name, estado: "ERRO", erro: e.message });
      setMensagens(await listarMensagens(selecionada.id).catch(() => mensagens));
    } finally {
      setEnviando(false);
      if (seletorArquivoRef.current) seletorArquivoRef.current.value = "";
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

  // Transferência tem handler próprio porque a conversa pode SAIR do filtro
  // atual (por responsável, por exemplo) e sumir da lista. Quando isso
  // acontece, `carregarConversas` não acha a linha para atualizar e o cabeçalho
  // continua mostrando o dono antigo — o operador transferiria de novo achando
  // que a primeira não pegou.
  async function transferir(paraEmail) {
    if (!selecionada || !paraEmail) return;
    setErro("");
    try {
      await transferirConversa(selecionada.id, paraEmail);
      const dono = operadores.find((o) => o.email === paraEmail);
      setSelecionada((c) =>
        c ? { ...c, responsavel_email: paraEmail,
              responsavel_nome: dono?.nome || paraEmail, status: "EM_ATENDIMENTO" } : c);
      await carregarConversas();
    } catch (e) {
      setErro(e.message);
    }
  }

  // Arquivar e desarquivar tem handler proprio, como `transferir`, e pelo mesmo
  // motivo: a conversa SAI do filtro em que esta. Se so recarregassemos a lista,
  // `carregarConversas` nao acharia a linha para atualizar e o cabecalho ficaria
  // mostrando uma conversa que nao esta mais ali — o operador arquivaria de novo
  // achando que a primeira nao pegou.
  async function alternarArquivo() {
    if (!selecionada || arquivando) return;
    const estaArquivada = Boolean(selecionada.arquivada_em);
    setArquivando(true);
    setErro("");
    try {
      if (estaArquivada) {
        await desarquivarConversa(selecionada.id);
        // Desarquivou: ela volta as filas conforme o estado REAL que sempre
        // esteve la (status, responsavel e nao_lidas nunca foram tocados).
        setSelecionada((c) => (c ? { ...c, arquivada_em: null, arquivada_por: null } : c));
      } else {
        await arquivarConversa(selecionada.id);
        // Arquivou estando numa fila operacional: a conversa deixa de existir
        // nesta lista. Fechar a thread e o unico estado coerente.
        if (filtroStatus !== FILTRO_ARQUIVADAS) {
          setSelecionada(null);
          setMensagens([]);
          setFicha(null);
        } else {
          setSelecionada((c) => (c ? { ...c, arquivada_em: new Date().toISOString() } : c));
        }
      }
      await carregarConversas();
      carregarResumo().then(setResumo).catch(() => {});
    } catch (e) {
      setErro(e.message);
    } finally {
      setArquivando(false);
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

  // "Recebido em" é verdade para quem nos procurou. Numa conversa que NÓS
  // abrimos, ninguém recebeu nada — dizer o contrário confunde justamente na
  // hora de entender de onde veio o contato.
  const conversaIniciadaPorNos = useMemo(
    () => mensagens.length > 0 && !mensagens.some((m) => m.direcao === "ENTRADA"),
    [mensagens],
  );

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
  // Só dá para iniciar conversa por número que está de pé agora.
  // Cadência por canal, indexada por id, para consultar sem varrer a lista.
  const cadenciaPorCanal = useMemo(() => {
    const m = new Map();
    for (const c of cadencia) m.set(c.canal_id, c);
    return m;
  }, [cadencia]);

  // Por que o motivo mora aqui e não no botão: o mesmo cálculo decide se o
  // canal aparece no seletor da Nova conversa. Duas cópias divergiriam, e o
  // operador veria um número na lista que o backend recusa no envio.
  function motivoSemAbordagem(c) {
    const k = cadenciaPorCanal.get(c.id);
    if (!k) return null;
    if (k.modo === "PAUSADO") return `${c.apelido} está pausado`;
    if (k.modo === "SOMENTE_RESPOSTAS") return `${c.apelido} só responde quem procurou a empresa`;
    if (!k.dentro_da_janela) {
      return `${c.apelido} só inicia conversas entre ${horaSemSegundos(k.janela_inicio)} e ${horaSemSegundos(k.janela_fim)}`;
    }
    if (k.limite_canal != null && k.usadas_canal >= k.limite_canal) {
      return `${c.apelido} atingiu ${k.limite_canal} conversas novas hoje`;
    }
    if (k.limite_operador != null && k.usadas_operador >= k.limite_operador) {
      return `você atingiu ${k.limite_operador} conversas novas hoje em ${c.apelido}`;
    }
    return null;
  }

  const canaisDisponiveis = useMemo(
    () => canais.filter((c) => c.ativo && c.online && !motivoSemAbordagem(c)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canais, cadenciaPorCanal],
  );

  // Só os canais que o operador pode ACIONAR entram no contador da barra.
  const cadenciaAtiva = useMemo(
    () => cadencia.filter((k) => k.modo === "ATIVO_CONTROLADO" && k.limite_operador != null),
    [cadencia],
  );

  const bloqueioNovaConversa = useMemo(() => {
    if (canaisDisponiveis.length) return null;
    const online = canais.filter((c) => c.ativo && c.online);
    if (!online.length) return "Nenhum número conectado — não dá para iniciar conversa agora";
    return online.map(motivoSemAbordagem).filter(Boolean).join("; ");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canais, canaisDisponiveis, cadenciaPorCanal]);

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
            style={canaisDisponiveis.length ? S.botao : S.botaoOff}
            onClick={() => setNovaAberta(true)}
            disabled={!canaisDisponiveis.length}
            title={bloqueioNovaConversa || "Escrever para alguém que ainda não escreveu para nós"}
          >
            Nova conversa
          </button>
          <button
            style={som ? S.botaoSecAtivo : S.botaoSec}
            onClick={() => { setSom((s) => !s); if (!som) tocarAviso(); }}
            title="Aviso sonoro quando chega mensagem nova"
          >
            {som ? "Som ligado" : "Som desligado"}
          </button>
          {gestao ? (
            <>
              <button style={S.botaoSec} onClick={() => setCanaisAberto(true)}>Números</button>
              <button style={S.botaoSec} onClick={() => setVerSupervisao((v) => !v)}>
                {verSupervisao ? "Ocultar supervisão" : "Supervisão"}
              </button>
            </>
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
                  {c.online ? (
                    <button style={S.botaoMini} onClick={() => comando(c, "desconectar")}>
                      Desconectar
                    </button>
                  ) : null}
                  {confirmandoLogout === c.id ? (
                    <>
                      <button
                        style={S.botaoMiniPerigo}
                        onClick={() => { setConfirmandoLogout(null); comando(c, "logout"); }}
                      >
                        Confirmar desvincular
                      </button>
                      <button style={S.botaoMini} onClick={() => setConfirmandoLogout(null)}>
                        Cancelar
                      </button>
                    </>
                  ) : (
                    <button style={S.botaoMini} onClick={() => setConfirmandoLogout(c.id)}>
                      Desvincular
                    </button>
                  )}
                </span>
              ) : null}
            </div>
          ))
        )}
      </div>

      {confirmandoLogout ? (
        <p style={S.avisoPerigo}>
          Desvincular remove este aparelho da conta do WhatsApp. Para voltar a usar o número
          será preciso <strong>ler o QR Code de novo</strong> — e o histórico do aparelho é
          importado só no pareamento. Use isto para trocar de celular, não para resolver
          queda de conexão (para isso, Reconectar).
        </p>
      ) : null}

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
          {cadenciaAtiva.map((k) => {
            const restam = Math.max(0, k.limite_operador - k.usadas_operador);
            const canalCheio = k.limite_canal != null && k.usadas_canal >= k.limite_canal;
            return (
              <div
                key={k.canal_id}
                style={restam === 0 || canalCheio ? S.tileCritico : S.tile}
                title={
                  canalCheio
                    ? `${k.canal_apelido} atingiu o teto do dia: ${k.usadas_canal}/${k.limite_canal}`
                    : `${k.canal_apelido}: ${k.usadas_canal}/${k.limite_canal} no número hoje`
                }
              >
                <span style={S.tileNumero}>
                  {k.usadas_operador}/{k.limite_operador}
                </span>
                <span style={S.tileRotulo}>
                  {canalCheio
                    ? `${k.canal_apelido} no teto do dia`
                    : `Novas abordagens hoje · restam ${restam}`}
                </span>
              </div>
            );
          })}
          {resumo.pendencias_resgate > 0 ? (
            <div
              style={{ ...S.tileResgate, cursor: "pointer" }}
              role="button"
              tabIndex={0}
              title="Abrir as conversas de resgate"
              onClick={() => setFiltroStatus(FILTRO_RESGATE)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") setFiltroStatus(FILTRO_RESGATE);
              }}
            >
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
                {/* Gestao PRECISA ver arquivadas, senao arquivar vira jeito de esconder. */}
                <th style={S.th}>Arquivadas</th>
                <th style={S.th}>Arq. não lidas</th>
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
                  <td style={S.td}>{l.arquivadas}</td>
                  <td style={S.td}>{l.arquivadas_nao_lidas}</td>
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
                  {/* Arquivada nao volta para a fila, mas nao pode ficar muda: o
                      aluno pode ter escrito de novo. Este numero e o aviso. */}
                  {f.valor === FILTRO_ARQUIVADAS && resumo?.arquivadas_nao_lidas > 0
                    ? ` (${resumo.arquivadas_nao_lidas})`
                    : ""}
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
              {/* Tempo sem interação. NÃO é uma ordenação alternativa: a lista
                  continua sempre com a conversa mais recente no topo, dentro da
                  faixa escolhida. */}
              <select
                style={S.select}
                value={filtroTempo}
                onChange={(e) => setFiltroTempo(e.target.value)}
                title="Tempo desde a última mensagem da conversa"
              >
                {TEMPOS_SEM_INTERACAO.map((t) => (
                  <option key={t.valor || "qualquer"} value={t.valor}>
                    {t.valor ? `Sem interação: ${t.rotulo}` : t.rotulo}
                  </option>
                ))}
              </select>
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
                    {formatarTelefone(selecionada.telefone_e164)} ·{" "}
                    {conversaIniciadaPorNos ? "iniciada por" : "recebido em"}{" "}
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
                    onChange={(e) => { if (e.target.value) transferir(e.target.value); }}
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
                    <button
                      style={S.botaoSec}
                      onClick={alternarArquivo}
                      disabled={arquivando}
                      title={selecionada.arquivada_em
                        ? "Volta para as filas conforme o estado real da conversa"
                        : "Sai das filas sem apagar nada. Se o aluno escrever, ela volta sozinha."}
                    >
                      {arquivando ? "…" : selecionada.arquivada_em ? "Desarquivar" : "Arquivar"}
                    </button>
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

              {/* Ficha leve, carregada só agora. A linha fica compacta de
                  propósito: o detalhamento é o popup de resumo, e o pesado
                  (acionar, tabular, histórico) continua na ficha completa. */}
              {ficha ? (
                <div style={S.fichaBox}>
                  <div style={S.fichaLinha}>
                    <strong>{ficha.nome}</strong>
                    {ficha.matricula ? <span style={S.fichaItem}>matrícula {ficha.matricula}</span> : null}
                    {ficha.cpf_mascarado ? <span style={S.fichaItem}>CPF {ficha.cpf_mascarado}</span> : null}
                    <button style={S.botaoMini} onClick={() => setFichaAbertaId(ficha.aluno_id)}>
                      Abrir ficha
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
                          {/* O anexo vem ANTES do texto: quando ha os dois, o texto
                              e a legenda da midia. */}
                          <AnexoWhatsApp mensagem={m} />
                          {m.texto || (m.midia_path || m.midia_erro
                            ? null
                            : <em style={S.midia}>[{m.tipo}]</em>)}
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
                    {/* Anexar PDF. `input` escondido + botão: o input nativo não
                        aceita estilo e mostraria "Nenhum arquivo escolhido" ao
                        lado, que não é informação para quem atende. */}
                    <input
                      ref={seletorArquivoRef}
                      type="file"
                      accept="application/pdf,.pdf"
                      style={{ display: "none" }}
                      data-testid="seletor-pdf"
                      onChange={(e) => anexarPdf(e.target.files?.[0])}
                    />
                    <button
                      type="button"
                      style={enviando ? S.botaoOff : S.botaoSec}
                      disabled={enviando}
                      title="Anexar PDF (até 16 MB)"
                      onClick={() => seletorArquivoRef.current?.click()}
                    >
                      📎 PDF
                    </button>
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
                {anexo ? (
                  <div style={anexo.estado === "ERRO" ? S.anexoErro : S.anexoEstado}>
                    {anexo.estado === "ENVIANDO" ? `Enviando ${anexo.nome}…` : null}
                    {anexo.estado === "ENVIADO" ? `${anexo.nome} enviado` : null}
                    {anexo.estado === "ERRO"
                      ? `${anexo.nome} não foi enviado — ${anexo.erro}`
                      : null}
                  </div>
                ) : null}
              </div>
            </>
          )}
        </section>
      </div>

      {/* ---------------- Nova conversa ---------------- */}
      {novaAberta ? (
        <ModalNovaConversa
          canais={canaisDisponiveis}
          onFechar={() => setNovaAberta(false)}
          onCriada={aoCriarConversa}
        />
      ) : null}

      {/* ---------------- Números cadastrados (gestão) ---------------- */}
      {canaisAberto ? (
        <ModalCanais
          canais={canais}
          cadencia={cadencia}
          onFechar={() => setCanaisAberto(false)}
          onSalvo={() => {
            listarCanais().then(setCanais).catch((e) => setErro(e.message));
            carregarCadencia().then(setCadencia).catch(() => {});
          }}
        />
      ) : null}

      {/* ---------------- Ficha completa do aluno (popup) ---------------- */}
      {fichaAbertaId ? (
        <FichaDoAluno alunoId={fichaAbertaId} onFechar={() => setFichaAbertaId(null)} />
      ) : null}

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
// FICHA COMPLETA DO ALUNO — em cima da conversa, sem sair da Central
//
// POR QUE É POPUP: quem está atendendo precisa da ficha INTEIRA (acionar,
// tabular, ver acordos, links, termos) enquanto lê o que o aluno escreveu.
// Abrir a ficha em outra tela tirava a conversa da frente do operador, e ele
// voltava sem o que ia digitar. Aqui é a MESMA ficha de /aluno, montada por
// cima da conversa: fecha no ESC, no botão ou no clique fora, e a Central fica
// exatamente como estava — sem ida, sem volta, sem perder o lugar na fila.
//
// É o componente REAL da tela /aluno (`fichaEmbedId`), não uma cópia reduzida:
// o que se pode fazer na ficha, se pode fazer daqui. O mesmo padrão já roda na
// Agenda Operacional, na Saúde da Base e nas filas de confirmação.
// ---------------------------------------------------------------------------
function FichaDoAluno({ alunoId, onFechar }) {
  // ESC fecha: o operador está com as mãos no teclado, no meio de uma resposta.
  useEffect(() => {
    function aoTeclar(e) {
      if (e.key === "Escape") onFechar();
    }
    window.addEventListener("keydown", aoTeclar);
    return () => window.removeEventListener("keydown", aoTeclar);
  }, [onFechar]);

  return (
    <div style={S.fichaFundo} onClick={onFechar}>
      <div
        style={S.fichaCaixa}
        role="dialog"
        aria-modal="true"
        aria-label="Ficha do aluno"
        onClick={(e) => e.stopPropagation()}
      >
        {/* O topo NÃO rola junto: a ficha é longa, e o operador tem de poder
            fechar de onde estiver nela. */}
        <div style={S.fichaTopo}>
          <strong>Ficha do aluno</strong>
          <button style={S.botaoMini} onClick={onFechar}>Fechar</button>
        </div>
        <div style={S.fichaCorpo}>
          <Aluno fichaEmbedId={alunoId} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// NÚMEROS CADASTRADOS (gestão)
//
// POR QUE ISTO PRECISA EXISTIR: sem esta tela, cadastrar ou renomear um número
// só era possível escrevendo direto no banco. Isso significa depender de alguém
// com acesso ao SQL para uma tarefa de operação — e é o tipo de dependência que
// trava a equipe num sábado.
//
// A ARMADILHA QUE ESTA TELA PRECISA EVITAR: `sessao_chave` tem que ser
// IDÊNTICA à chave configurada no serviço do WhatsApp. Se divergir, tudo parece
// certo na tela e nada funciona: o número nunca conecta e mensagem nenhuma
// encontra o canal. Por isso o campo vem com aviso, e não com um valor
// adivinhado.
// ---------------------------------------------------------------------------
const MODOS = [
  { valor: "ATIVO_CONTROLADO", rotulo: "Ativo controlado — inicia conversas dentro da cota" },
  { valor: "SOMENTE_RESPOSTAS", rotulo: "Somente respostas — não inicia conversa nenhuma" },
  { valor: "PAUSADO", rotulo: "Pausado — nada sai por este número, nem resposta" },
];

function ModalCanais({ canais, cadencia, onFechar, onSalvo }) {
  const [editando, setEditando] = useState(null);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState("");

  const vazio = { id: null, apelido: "", numero: "", sessaoChave: "", ativo: true };

  const porCanal = useMemo(() => {
    const m = new Map();
    for (const k of cadencia || []) m.set(k.canal_id, k);
    return m;
  }, [cadencia]);

  async function salvar() {
    const f = editando;
    if (!f?.apelido.trim() || !f?.numero.trim() || !f?.sessaoChave.trim()) {
      setErro("Apelido, número e chave da sessão são obrigatórios.");
      return;
    }
    setSalvando(true);
    setErro("");
    try {
      await salvarCanal({
        id: f.id,
        apelido: f.apelido.trim(),
        numero: f.numero.trim(),
        sessaoChave: f.sessaoChave.trim().toLowerCase(),
        ativo: f.ativo,
      });
      // Cadência só para número que já existe: canal recém-criado nasce em
      // SOMENTE_RESPOSTAS pelo banco, e é isso que se quer num número novo.
      if (f.id) {
        await salvarCadenciaCanal({
          canalId: f.id,
          modo: f.modo,
          limiteOperador: f.limiteOperador,
          limiteCanal: f.limiteCanal,
          // Repassa a janela inalterada. A RPC grava os cinco campos de uma vez;
          // omitir aqui apagaria o horário sem ninguém ter pedido.
          janelaInicio: f.janelaInicio,
          janelaFim: f.janelaFim,
        });
      }
      setEditando(null);
      onSalvo();
    } catch (e) {
      setErro(e.message);
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div style={S.modalFundo} onClick={onFechar}>
      <div style={S.modalLargo} onClick={(e) => e.stopPropagation()}>
        <h2 style={S.modalTitulo}>Números da Central</h2>

        {canais.length === 0 ? (
          <p style={S.modalTexto}>Nenhum número cadastrado ainda.</p>
        ) : (
          <div style={S.listaCanais}>
            {canais.map((c) => (
              <div key={c.id} style={S.linhaCanal}>
                <span style={c.online ? S.pontoOk : S.pontoRuim} />
                <div style={S.canalTexto}>
                  <strong>{c.apelido}</strong> · {c.display_phone_number}
                  <div style={S.canalSub}>
                    sessão <code>{c.sessao_chave}</code>
                    {c.ativo ? "" : " · desativado"}
                    {porCanal.get(c.id) ? (
                      <>
                        {" · "}
                        {MODOS.find((m) => m.valor === porCanal.get(c.id).modo)?.valor}
                        {porCanal.get(c.id).modo === "ATIVO_CONTROLADO"
                          ? ` ${porCanal.get(c.id).limite_operador ?? "–"}/operador · ${porCanal.get(c.id).limite_canal ?? "–"}/dia`
                          : ""}
                      </>
                    ) : null}
                  </div>
                </div>
                <button
                  style={S.botaoMini}
                  onClick={() =>
                    setEditando({
                      id: c.id, apelido: c.apelido, numero: c.display_phone_number,
                      sessaoChave: c.sessao_chave, ativo: c.ativo,
                      modo: porCanal.get(c.id)?.modo || "SOMENTE_RESPOSTAS",
                      limiteOperador: porCanal.get(c.id)?.limite_operador ?? "",
                      limiteCanal: porCanal.get(c.id)?.limite_canal ?? "",
                      janelaInicio: porCanal.get(c.id)?.janela_inicio || null,
                      janelaFim: porCanal.get(c.id)?.janela_fim || null,
                    })
                  }
                >
                  Editar
                </button>
              </div>
            ))}
          </div>
        )}

        {editando ? (
          <>
            <label style={S.campoNovo}>
              <span style={S.rotuloNovo}>Apelido</span>
              <input
                style={S.busca}
                placeholder="Cobrança"
                value={editando.apelido}
                onChange={(e) => setEditando({ ...editando, apelido: e.target.value })}
              />
            </label>
            <label style={S.campoNovo}>
              <span style={S.rotuloNovo}>Número exibido</span>
              <input
                style={S.busca}
                placeholder="+55 51 99999-8888"
                value={editando.numero}
                onChange={(e) => setEditando({ ...editando, numero: e.target.value })}
              />
            </label>
            <label style={S.campoNovo}>
              <span style={S.rotuloNovo}>Chave da sessão</span>
              <input
                style={S.busca}
                placeholder="cobranca"
                value={editando.sessaoChave}
                onChange={(e) => setEditando({ ...editando, sessaoChave: e.target.value })}
                disabled={Boolean(editando.id)}
              />
              <span style={S.dicaRuim}>
                Precisa ser idêntica à chave configurada no serviço do WhatsApp. Se divergir,
                o número nunca conecta — e nada na tela avisa o porquê.
                {editando.id ? " Não muda depois de criado: é ela que amarra o histórico." : ""}
              </span>
            </label>

            {/* --------- Cadência: só para número já criado --------- */}
            {editando.id ? (
              <>
                <label style={S.campoNovo}>
                  <span style={S.rotuloNovo}>Modo do número</span>
                  <select
                    style={S.busca}
                    value={editando.modo}
                    onChange={(e) => setEditando({ ...editando, modo: e.target.value })}
                  >
                    {MODOS.map((m) => (
                      <option key={m.valor} value={m.valor}>{m.rotulo}</option>
                    ))}
                  </select>
                </label>

                {editando.modo === "ATIVO_CONTROLADO" ? (
                  <>
                    <label style={S.campoNovo}>
                      <span style={S.rotuloNovo}>Novas abordagens por operador, por dia</span>
                      <input
                        style={S.busca}
                        type="number"
                        min="0"
                        placeholder="10"
                        value={editando.limiteOperador}
                        onChange={(e) => setEditando({ ...editando, limiteOperador: e.target.value })}
                      />
                    </label>
                    <label style={S.campoNovo}>
                      <span style={S.rotuloNovo}>Novas abordagens no número, por dia</span>
                      <input
                        style={S.busca}
                        type="number"
                        min="0"
                        placeholder="100"
                        value={editando.limiteCanal}
                        onChange={(e) => setEditando({ ...editando, limiteCanal: e.target.value })}
                      />
                      <span style={S.dicaRuim}>
                        Os dois valem ao mesmo tempo. Quem atinge o próprio limite para de
                        iniciar conversas; quando o número atinge o dele, ninguém inicia até o
                        dia seguinte. Responder quem procurou a empresa continua liberado nos
                        dois casos.
                        {editando.janelaInicio
                          ? ` Janela atual: ${horaSemSegundos(editando.janelaInicio)} às ${horaSemSegundos(editando.janelaFim)}.`
                          : ""}
                      </span>
                    </label>
                  </>
                ) : (
                  <span style={S.dicaRuim}>
                    {editando.modo === "PAUSADO"
                      ? "Pausado: nenhuma mensagem sai por este número, nem resposta a quem escreveu. As que chegarem continuam sendo guardadas."
                      : "Somente respostas: dá para responder quem procurou a empresa nos últimos 30 dias, e nada mais sai por aqui."}
                  </span>
                )}
              </>
            ) : (
              <span style={S.dicaRuim}>
                Número novo entra em <strong>Somente respostas</strong>. É de propósito: número
                recém-pareado é o mais frágil, e liberar abordagem antes da hora custa bloqueio
                do WhatsApp. Depois de criado, o modo se ajusta aqui mesmo.
              </span>
            )}
            <label style={S.linhaNovo}>
              <input
                type="checkbox"
                checked={editando.ativo}
                onChange={(e) => setEditando({ ...editando, ativo: e.target.checked })}
              />
              <span style={S.rotuloNovo}>Ativo</span>
            </label>

            {erro ? <p style={S.erro}>{erro}</p> : null}

            <div style={S.linhaNovo}>
              <button style={S.botaoSec} onClick={() => { setEditando(null); setErro(""); }}>
                Cancelar
              </button>
              <button style={salvando ? S.botaoOff : S.botao} onClick={salvar} disabled={salvando}>
                {salvando ? "Salvando…" : "Salvar"}
              </button>
            </div>
          </>
        ) : (
          <div style={S.linhaNovo}>
            <button style={S.botaoSec} onClick={onFechar}>Fechar</button>
            <button style={S.botao} onClick={() => { setEditando(vazio); setErro(""); }}>
              Cadastrar número
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// NOVA CONVERSA — o operador escreve primeiro
//
// POR QUE ISTO EXISTE: sem este caminho, iniciar contato obrigava o operador a
// sair da Central para o celular ou o WhatsApp Web. O que sai por fora não tem
// histórico aqui, não tem responsável e não aparece na supervisão — some da
// operação, que é exatamente o problema que este módulo veio resolver.
//
// TRÊS CUIDADOS QUE MUDAM O COMPORTAMENTO:
//
//   1. AVISA ANTES, NÃO DEPOIS. Enquanto o número é digitado, a tela pergunta
//      ao banco se já existe conversa com aquela pessoa. Descobrir isso só
//      depois de escrever a mensagem é como o operador acaba abrindo um
//      atendimento paralelo ao de um colega.
//
//   2. SÓ NÚMERO CONECTADO. A lista de canais já chega filtrada; se nenhum
//      estiver de pé, o formulário nem abre em modo de envio — diz o porquê.
//
//   3. A CONVERSA NASCE NO ENVIO, não ao abrir este formulário. Quem desiste no
//      meio não deixa conversa vazia na caixa de entrada.
// ---------------------------------------------------------------------------
function ModalNovaConversa({ canais, onFechar, onCriada }) {
  const [canalId, setCanalId] = useState(canais[0]?.id || "");
  const [telefone, setTelefone] = useState("");
  const [texto, setTexto] = useState("");
  const [aluno, setAluno] = useState(null);
  const [termo, setTermo] = useState("");
  const [achados, setAchados] = useState([]);
  const [buscando, setBuscando] = useState(false);
  const [existente, setExistente] = useState(null);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState("");

  const e164 = normalizarE164(telefone);
  const canal = canais.find((c) => c.id === canalId) || null;

  // Consulta enquanto digita, com folga para não bater no banco a cada tecla.
  useEffect(() => {
    if (!canalId || !e164) {
      setExistente(null);
      return undefined;
    }
    let vivo = true;
    const t = setTimeout(() => {
      procurarConversaPorTelefone(canalId, e164)
        .then((r) => { if (vivo) setExistente(r); })
        .catch(() => { if (vivo) setExistente(null); });
    }, 400);
    return () => { vivo = false; clearTimeout(t); };
  }, [canalId, e164]);

  async function procurar() {
    const t = termo.trim();
    if (!t) return;
    setBuscando(true);
    setErro("");
    try {
      setAchados(await buscarAluno(t));
    } catch (e) {
      setErro(e.message);
    } finally {
      setBuscando(false);
    }
  }

  function escolher(a) {
    setAluno(a);
    setAchados([]);
    setTermo("");
    // O telefone da ficha é uma sugestão, não uma imposição: dá para corrigir
    // antes de enviar, e aluno sem telefone na base não trava o fluxo.
    if (a.telefone) setTelefone(a.telefone);
  }

  const podeEnviar = Boolean(canalId && e164 && texto.trim() && !enviando);

  async function enviar() {
    if (!podeEnviar) return;
    setEnviando(true);
    setErro("");
    try {
      const r = await iniciarConversa({
        canalId,
        telefone: e164,
        alunoId: aluno?.id || null,
        texto: texto.trim(),
      });
      onCriada(r?.conversa_id);
    } catch (e) {
      setErro(e.message);
      setEnviando(false);
    }
  }

  return (
    <div style={S.modalFundo} onClick={onFechar}>
      <div style={S.modalLargo} onClick={(e) => e.stopPropagation()}>
        <h2 style={S.modalTitulo}>Nova conversa</h2>
        <p style={S.modalTexto}>
          Para escrever a quem ainda não nos procurou. A conversa fica registrada aqui,
          com você como responsável.
        </p>

        {canais.length === 0 ? (
          <p style={S.erro}>
            Nenhum número está conectado agora. Enquanto isso, não é possível iniciar
            conversa — as mensagens que chegarem continuam sendo guardadas normalmente.
          </p>
        ) : (
          <>
            {canais.length > 1 ? (
              <label style={S.campoNovo}>
                <span style={S.rotuloNovo}>Enviar pelo número</span>
                <select style={S.busca} value={canalId} onChange={(e) => setCanalId(e.target.value)}>
                  {canais.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.apelido} · {c.display_phone_number}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <p style={S.modalTexto}>
                Enviando por <strong>{canal?.apelido}</strong> ({canal?.display_phone_number})
              </p>
            )}

            <label style={S.campoNovo}>
              <span style={S.rotuloNovo}>Procurar aluno (opcional)</span>
              <div style={S.linhaNovo}>
                <input
                  style={S.busca}
                  placeholder="Nome, CPF ou matrícula"
                  value={termo}
                  onChange={(e) => setTermo(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); procurar(); } }}
                />
                <button style={S.botaoSec} onClick={procurar} disabled={buscando}>
                  {buscando ? "Procurando…" : "Procurar"}
                </button>
              </div>
              {achados.length > 0 ? (
                <div style={S.achados}>
                  {achados.map((a) => (
                    <button key={a.id} style={S.botaoMini} onClick={() => escolher(a)}>
                      {a.nome}
                      {a.matricula ? ` · ${a.matricula}` : ""}
                      {a.telefone ? ` · ${formatarTelefone(a.telefone)}` : " · sem telefone"}
                    </button>
                  ))}
                </div>
              ) : null}
              {aluno ? (
                <div style={S.alunoEscolhido}>
                  Vinculando a <strong>{aluno.nome}</strong>
                  <button style={S.botaoMini} onClick={() => setAluno(null)}>tirar</button>
                </div>
              ) : null}
            </label>

            <label style={S.campoNovo}>
              <span style={S.rotuloNovo}>Número de destino</span>
              <input
                style={S.busca}
                placeholder="(51) 99999-8888"
                value={telefone}
                onChange={(e) => setTelefone(e.target.value)}
              />
              {telefone && !e164 ? (
                <span style={S.dicaRuim}>Número incompleto — informe DDD e número.</span>
              ) : e164 ? (
                <span style={S.dicaOk}>Vai para {formatarTelefone(e164)}</span>
              ) : null}
            </label>

            {existente ? (
              // O texto MUDA conforme a conversa tenha dono ou não, porque o
              // desfecho é outro. Dizer "sua mensagem entra nessa conversa"
              // quando ela é de um colega é prometer o que o banco vai recusar
              // — e o operador só descobriria depois de escrever tudo.
              <div style={existente.responsavel_nome ? S.jaExisteDeOutro : S.jaExiste}>
                Já existe conversa com este número
                {existente.aluno_nome ? <> — <strong>{existente.aluno_nome}</strong></> : null}.
                {existente.responsavel_nome ? (
                  <>
                    {" "}Em atendimento por <strong>{existente.responsavel_nome}</strong>. Se a
                    conversa não for sua, o envio será recusado: procure {existente.responsavel_nome}{" "}
                    ou peça a transferência, em vez de abrir um atendimento paralelo.
                  </>
                ) : (
                  <> Sem responsável. Sua mensagem entra nessa mesma conversa, sem abrir outra.</>
                )}
              </div>
            ) : null}

            <label style={S.campoNovo}>
              <span style={S.rotuloNovo}>Primeira mensagem</span>
              <textarea
                style={S.textoNovo}
                rows={4}
                placeholder="Escreva a mensagem que abre a conversa"
                value={texto}
                onChange={(e) => setTexto(e.target.value)}
              />
            </label>

            {erro ? <p style={S.erro}>{erro}</p> : null}
          </>
        )}

        <div style={S.linhaNovo}>
          <button style={S.botaoSec} onClick={onFechar}>Cancelar</button>
          {canais.length > 0 ? (
            <button style={podeEnviar ? S.botao : S.botaoOff} onClick={enviar} disabled={!podeEnviar}>
              {enviando ? "Enviando…" : "Enviar e abrir conversa"}
            </button>
          ) : null}
        </div>
      </div>
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
  // Estado do anexo. O erro é VERMELHO e fica na tela: um envio que falhou
  // desaparecendo em silêncio é como o operador acha que mandou o boleto.
  anexoEstado: { marginTop: 8, fontSize: 12.5, color: CINZA },
  anexoErro: {
    marginTop: 8, padding: "8px 10px", borderRadius: 8, background: "#fef2f2",
    border: "1px solid #fecaca", color: "#991b1b", fontSize: 12.5, lineHeight: 1.5,
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
  modalLargo: {
    background: "#fff", borderRadius: 14, padding: 20, width: "min(520px, 94vw)",
    maxHeight: "92vh", overflowY: "auto",
    display: "flex", flexDirection: "column", gap: 14,
    boxShadow: "0 20px 50px rgba(15,23,42,.25)",
  },
  campoNovo: { display: "flex", flexDirection: "column", gap: 6 },
  listaCanais: { display: "flex", flexDirection: "column", gap: 8 },
  linhaCanal: {
    display: "flex", alignItems: "center", gap: 9,
    border: `1px solid ${BORDA}`, borderRadius: 9, padding: "8px 10px",
  },
  canalTexto: { flex: 1, fontSize: 13 },
  canalSub: { fontSize: 11.5, color: CINZA, marginTop: 2 },
  botaoMiniPerigo: {
    ...botaoBase, padding: "4px 9px", fontSize: 12,
    background: VERMELHO, color: "#fff", borderColor: VERMELHO, fontWeight: 600,
  },
  avisoPerigo: {
    margin: "0 0 10px", fontSize: 12, lineHeight: 1.6, color: "#7f1d1d",
    background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 9, padding: "9px 12px",
  },
  rotuloNovo: { fontSize: 12, fontWeight: 600, color: "#334155" },
  linhaNovo: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" },
  achados: { display: "flex", flexDirection: "column", gap: 4, maxHeight: 160, overflowY: "auto" },
  alunoEscolhido: {
    display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#166534",
    background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 8, padding: "6px 9px",
  },
  dicaOk: { fontSize: 11.5, color: VERDE },
  dicaRuim: { fontSize: 11.5, color: VERMELHO },
  jaExiste: {
    fontSize: 12, lineHeight: 1.6, color: "#92400e",
    background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, padding: "9px 11px",
  },
  jaExisteDeOutro: {
    fontSize: 12, lineHeight: 1.6, color: "#7f1d1d",
    background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: "9px 11px",
  },
  textoNovo: {
    padding: "9px 11px", borderRadius: 8, border: `1px solid ${BORDA}`,
    fontSize: 13, fontFamily: "inherit", resize: "vertical", boxSizing: "border-box", width: "100%",
  },
  // ---- ficha do aluno (popup) ----
  // Larga e alta de propósito: é a ficha inteira aí dentro. O topo fica fixo e
  // só o CORPO rola — fechar não pode depender de voltar ao começo da ficha.
  fichaFundo: {
    position: "fixed", inset: 0, background: "rgba(15,23,42,.55)",
    display: "flex", alignItems: "flex-start", justifyContent: "center",
    padding: "3vh 2vw", zIndex: 60,
  },
  fichaCaixa: {
    background: "#fff", borderRadius: 14, width: "min(1100px, 96vw)",
    maxHeight: "94vh", display: "flex", flexDirection: "column", overflow: "hidden",
    boxShadow: "0 20px 50px rgba(15,23,42,.25)",
  },
  fichaTopo: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    gap: 12, padding: "12px 16px", borderBottom: `1px solid ${BORDA}`, background: "#f8fafc",
  },
  fichaCorpo: { flex: 1, overflow: "auto" },

  modalTitulo: { margin: 0, fontSize: 18 },
  modalTexto: { margin: 0, fontSize: 13, color: CINZA },
  qr: { width: 260, height: 260, imageRendering: "pixelated" },
  modalAviso: { margin: 0, fontSize: 11.5, color: CINZA, lineHeight: 1.6 },
};
