import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { podeVerTudo, nomeOperadorPorEmail } from "../utils/operadores";
import FilaReceptivo from "./FilaReceptivo";
import ReceberLeads from "./ReceberLeads";
import LinksPagamentoAluno from "./LinksPagamentoAluno";
import FinalizacaoTermo from "./FinalizacaoTermo";
import EnvioFinanceiro from "./EnvioFinanceiro";
import FinanceiroAluno from "./FinanceiroAluno";
import ConfirmarPagamento from "./ConfirmarPagamento";

/*
  PainelCarteira
  --------------
  Espaco operacional completo do operador. A lista de casos abre um MODAL
  sobre a propria carteira (sem navegar para /aluno, sem rota nova). Todas
  as acoes gravam de verdade, reaproveitando os fluxos/componentes ja
  existentes (LinksPagamentoAluno, FinalizacaoTermo, EnvioFinanceiro,
  FinanceiroAluno, ConfirmarPagamento) e as MESMAS tabelas/gravacoes que a
  pagina Aluno usa para tabular/finalizar (alunos + aluno_movimentacoes).
  A pagina Aluno continua intacta, para pesquisa/consulta.

  Aba "Receptivo": incorpora FilaReceptivo + ReceberLeads (rodizio, pausa,
  heartbeat, marcar atendimento, receber_leads). Fidelizacao de 10 dias e
  distribuicao continuam integralmente no servidor.
*/

const OPERADORES = [
  { nome: "Fernanda Supervisora", email: "cobranca04@aelbra.com.br" },
  { nome: "Luana", email: "cobranca05@aelbra.com.br" },
  { nome: "Rafaella", email: "cobranca12@aelbra.com.br" },
  { nome: "Amanda ADM", email: "cobranca07@aelbra.com.br" },
  { nome: "Allan", email: "cobranca11@aelbra.com.br" },
  { nome: "Mauricio", email: "cobranca06@aelbra.com.br" },
  { nome: "Olga", email: "cobranca03@aelbra.com.br" },
  { nome: "Joao", email: "cobranca10@aelbra.com.br" },
  { nome: "Diego", email: "cobranca13@aelbra.com.br" },
  { nome: "Natali", email: "cobranca08@aelbra.com.br" },
  { nome: "Amanda Seibel", email: "amanda.seibel@aelbra.com.br" },
];

// Lista de status de finalizacao -- IDENTICA a usada na pagina Aluno.jsx
// (replicada como referencia; nenhum status novo foi inventado).
const STATUS_FINALIZACAO = [
  "CONTATAR",
  "MENSAGEM_ENVIADA",
  "EM_ATENDIMENTO",
  "ALUNO_EM_NEGOCIACAO_24H",
  "RETORNAR_DEPOIS",
  "SEM_RETORNO",
  "NAO_LOCALIZADO",
  "AGUARDANDO_LINK",
  "SOLICITADO_LINK",
  "LINK_PRONTO_PARA_ENVIO",
  "AGUARDANDO_COMPROVANTE",
  "AGUARDANDO_BAIXA",
  "BAIXA_REALIZADA",
  "BAIXA_DEVOLVIDA",
  "TERMO_ENVIADO_ALUNO",
  "TERMO_ENVIADO_ADM",
  "TERMO_RECEBIDO_LIBERADO",
  "TERMO_REJEITADO",
  "ACORDO_FECHADO",
  "CANCELAMENTO_COBRANCA",
  "SUSPENSAO_COBRANCA",
  "JURIDICO",
];

// Derivacao da proxima acao a partir do status escolhido -- mesma regra do
// Aluno.jsx.
function proximaAcaoDeStatus(statusNovo) {
  if (statusNovo === "RETORNAR_DEPOIS" || statusNovo === "ALUNO_EM_NEGOCIACAO_24H") return "RETORNAR";
  if (statusNovo === "ACORDO_FECHADO") return "ACOMPANHAR_PAGAMENTO";
  if (statusNovo === "NAO_LOCALIZADO") return "TENTAR_NOVO_CONTATO";
  if (statusNovo === "LINK_PRONTO_PARA_ENVIO") return "ENVIAR_LINK_AO_ALUNO";
  return "CONTATAR";
}

function formatarMoeda(valor) {
  const n = Number(valor) || 0;
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function nomeAluno(a) {
  return a?.nome || a?.nome_aluno || a?.aluno || "Aluno sem nome";
}

function hojeLocalBR() {
  const d = new Date();
  const ano = d.getFullYear();
  const mes = String(d.getMonth() + 1).padStart(2, "0");
  const dia = String(d.getDate()).padStart(2, "0");
  return `${ano}-${mes}-${dia}`;
}

function formatarData(data) {
  if (!data) return "-";
  if (/^\d{4}-\d{2}-\d{2}$/.test(data)) {
    const [ano, mes, dia] = data.split("-");
    return `${dia}/${mes}/${ano}`;
  }
  try {
    return new Date(data).toLocaleDateString("pt-BR");
  } catch {
    return "-";
  }
}

function formatarDataHora(data) {
  if (!data) return "-";
  try {
    return new Date(data).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
  } catch {
    return "-";
  }
}

function ehQuitado(a) {
  const texto = [a?.status_acionamento, a?.status_jornada, a?.status_atual]
    .filter(Boolean)
    .join(" ")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase();
  return texto.includes("QUITAD") || texto.includes("QUITACAO");
}

function diasSemContato(a) {
  const base = a?.data_ultimo_acionamento || a?.ultimo_contato || a?.responsavel_atual_em || null;
  if (!base) return null;
  const d = new Date(base);
  if (Number.isNaN(d.getTime())) return null;
  const ms = Date.now() - d.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

const MAPA_SITUACAO = {
  CONTATAR: "A contatar",
  MENSAGEM_ENVIADA: "Mensagem enviada",
  EM_ATENDIMENTO: "Em atendimento",
  ALUNO_EM_NEGOCIACAO_24H: "Em negociacao",
  RETORNAR_DEPOIS: "Retornar depois",
  SEM_RETORNO: "Sem retorno",
  NAO_LOCALIZADO: "Nao localizado",
  AGUARDANDO_LINK: "Aguardando link",
  SOLICITADO_LINK: "Link solicitado",
  LINK_PRONTO_PARA_ENVIO: "Link pronto p/ envio",
  LINK_ENVIADO_AO_ALUNO: "Link enviado",
  AGUARDANDO_COMPROVANTE: "Aguardando comprovante",
  AGUARDANDO_BAIXA: "Aguardando baixa",
  BAIXA_REALIZADA: "Pago",
  BAIXA_DEVOLVIDA: "Baixa devolvida",
  ACORDO_FECHADO: "Acordo fechado",
  TERMO_ENVIADO_ALUNO: "Termo enviado",
  TERMO_ENVIADO_ADM: "Termo no ADM",
  TERMO_RECEBIDO_LIBERADO: "Termo liberado",
  TERMO_REJEITADO: "Termo rejeitado",
  JURIDICO: "Juridico",
  CANCELAMENTO_COBRANCA: "Cancelado",
  SUSPENSAO_COBRANCA: "Suspenso",
};

function labelStatus(s) {
  return MAPA_SITUACAO[s] || s;
}

function situacaoLabel(a) {
  const s = a?.status_atual || a?.status_jornada || "";
  if (MAPA_SITUACAO[s]) return MAPA_SITUACAO[s];
  if (!s || s === "Novo caso") return "Sem contato";
  return s;
}

function statusPrazo(a) {
  const sit = a?.status_atual || "";
  if (sit === "JURIDICO") return { label: "Juridico", cor: "#7c3aed" };
  if (["ACORDO_FECHADO", "AGUARDANDO_BAIXA", "AGUARDANDO_COMPROVANTE", "SOLICITADO_LINK", "LINK_ENVIADO_AO_ALUNO"].includes(sit))
    return { label: "Aguardando pgto", cor: "#2563eb" };
  if (sit === "BAIXA_REALIZADA") return { label: "Pago", cor: "#16a34a" };
  if (["CANCELAMENTO_COBRANCA", "SUSPENSAO_COBRANCA"].includes(sit))
    return { label: "Cancelado", cor: "#6b7280" };

  const dias = diasSemContato(a);
  if (dias === null) return { label: "Novo", cor: "#94a3b8" };
  if (dias <= 7) return { label: "Dentro do prazo", cor: "#16a34a" };
  if (dias === 8) return { label: "Atencao", cor: "#f59e0b" };
  if (dias <= 10) return { label: "Critico", cor: "#dc2626" };
  return { label: "Perdendo o caso", cor: "#991b1b" };
}

function casoNoKpi(a, kpi) {
  if (!kpi || kpi === "ativos") return true;
  const t = `${a.status_atual || ""} ${a.status_jornada || ""} ${a.status_acionamento || ""}`.toUpperCase();
  const dias = diasSemContato(a);
  switch (kpi) {
    case "semContato":
      return dias !== null && dias >= 10;
    case "criticos":
      return statusPrazo(a).label === "Critico";
    case "retornosHoje":
      return a.data_retorno === hojeLocalBR();
    case "acordosFechados":
      return t.includes("ACORDO_FECHADO");
    case "linksPagos":
      return t.includes("BAIXA_REALIZADA");
    case "termosAgPgto":
      return t.includes("TERMO") && (t.includes("RECEBIDO") || t.includes("LIBERADO") || t.includes("ADM"));
    default:
      return true;
  }
}

const KPIS_FILTRAVEIS = new Set([
  "ativos",
  "semContato",
  "criticos",
  "retornosHoje",
  "acordosFechados",
  "linksPagos",
  "termosAgPgto",
]);

const KPIS_ESPECIAIS = new Set(["quitados", "recebidosMes", "acordosQuebrados"]);

const COLUNAS_ALUNO =
  "id,nome,nome_aluno,cpf,telefone,valor_em_aberto,status_atual,status_jornada,status_acionamento,nivel_criticidade,data_ultimo_acionamento,ultimo_contato,data_retorno,hora_retorno,responsavel_atual_nome,responsavel_atual_email,observacao";

// Aba "Solicitacoes" foi removida: Solicitar link / termo / financeiro /
// informar pagamento / anexar comprovante ficam INLINE dentro da Tabulacao
// (aba Negociacao), que e o centro unico do operador.
const ABAS_MODAL = [
  { id: "resumo", label: "Resumo" },
  { id: "negociacao", label: "Tabulacao" },
  { id: "financeiro", label: "Financeiro" },
  { id: "historico", label: "Historico" },
];

// Mapeia o resultado do retorno ADM -> acao inline que deve abrir
// automaticamente dentro da Tabulacao.
const RETORNO_ABRE_ACAO = {
  LINK_PRONTO_PARA_ENVIO: "link",
  BAIXA_DEVOLVIDA: "link",
  TERMO_RECEBIDO_LIBERADO: "termo",
  TERMO_REJEITADO: "termo",
  FINANCEIRO_DEVOLVIDO: "financeiro",
  PAGAMENTO_REJEITADO: "pagamento",
};

export default function PainelCarteira({ embedded = false }) {
  const [email, setEmail] = useState(null);
  const [usuarioPerfil, setUsuarioPerfil] = useState(null);
  const [veTudo, setVeTudo] = useState(false);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");

  const [aba, setAba] = useState("carteira");

  const [operadorFiltro, setOperadorFiltro] = useState("TODOS");
  const [casos, setCasos] = useState([]);
  const [kpis, setKpis] = useState({
    ativos: 0,
    semContato: 0,
    criticos: 0,
    retornosHoje: 0,
    acordosQuebrados: 0,
    recebidosMes: 0,
    valorBaixadoMes: 0,
    honorariosBaixadoMes: 0,
    quitados: 0,
    acordosFechados: 0,
    linksPagos: 0,
    termosAgPgto: 0,
  });

  const [busca, setBusca] = useState("");
  const [filtroStatus, setFiltroStatus] = useState("TODOS");
  const [filtroKpi, setFiltroKpi] = useState(null);
  const [ordenacao, setOrdenacao] = useState("sem_contato_desc");
  const [casosEspeciais, setCasosEspeciais] = useState(null);
  const [carregandoEspecial, setCarregandoEspecial] = useState(false);
  const [quebradosCpfs, setQuebradosCpfs] = useState([]);
  const [recebidosCpfs, setRecebidosCpfs] = useState([]);

  // ---- Modal operacional ----
  const [modalAberto, setModalAberto] = useState(false);
  const [alunoModal, setAlunoModal] = useState(null);
  const [abaModal, setAbaModal] = useState("resumo");
  const [historico, setHistorico] = useState([]);
  const [honorarios, setHonorarios] = useState(null);
  const [carregandoModal, setCarregandoModal] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [feedback, setFeedback] = useState(null); // { tipo: "ok"|"erro", texto }

  // Formulario de tabulacao/finalizacao (Negociacao)
  const [statusNovo, setStatusNovo] = useState("");
  const [resumoConversa, setResumoConversa] = useState("");
  const [retornoData, setRetornoData] = useState("");
  const [retornoHora, setRetornoHora] = useState("");
  const [observacao, setObservacao] = useState("");

  // Acoes inline dentro da Tabulacao (link/termo/financeiro/pagamento).
  const [acaoInline, setAcaoInline] = useState(null);
  // Retorno ADM acionavel do aluno aberto + contador da carteira.
  const [retornoAluno, setRetornoAluno] = useState(null);
  const [retornosPendentes, setRetornosPendentes] = useState([]);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getUser();
      const mail = data?.user?.email || null;
      setEmail(mail);
      setVeTudo(podeVerTudo(mail));
      if (mail) {
        const { data: perfil } = await supabase
          .from("usuarios")
          .select("*")
          .eq("email", mail)
          .single();
        setUsuarioPerfil(perfil || { email: mail, nome: nomeOperadorPorEmail(mail) });
      }
    })();
  }, []);

  useEffect(() => {
    if (email === null) return;
    carregar();
    carregarRetornosPendentes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email, veTudo, operadorFiltro]);

  const usuarioLogado = useMemo(
    () => usuarioPerfil || (email ? { email, nome: nomeOperadorPorEmail(email) } : null),
    [usuarioPerfil, email]
  );

  function emailEscopo() {
    if (!veTudo) return email;
    return operadorFiltro === "TODOS" ? null : operadorFiltro;
  }

  function aplicarEscopo(query) {
    const alvo = emailEscopo();
    if (alvo) return query.eq("responsavel_atual_email", alvo);
    return query;
  }

  async function carregar() {
    setCarregando(true);
    setErro("");
    try {
      const hoje = hojeLocalBR();
      const corte = (n) => {
        const d = new Date();
        d.setHours(23, 59, 59, 999);
        d.setDate(d.getDate() - n);
        return d.toISOString();
      };

      const colunas = COLUNAS_ALUNO;
      const alvoEscopo = emailEscopo();
      const TETO = alvoEscopo ? 50000 : 3000;
      const PAGINA = 1000;
      let todas = [];
      let inicio = 0;
      while (true) {
        let q = supabase
          .from("alunos")
          .select(colunas)
          .order("data_ultimo_acionamento", { ascending: true, nullsFirst: false })
          .range(inicio, inicio + PAGINA - 1);
        q = aplicarEscopo(q);
        const { data: parte, error: erroParte } = await q;
        if (erroParte) throw erroParte;
        todas = todas.concat(parte || []);
        if (!parte || parte.length < PAGINA || todas.length >= TETO) break;
        inicio += PAGINA;
      }
      const listaAtiva = todas.filter((a) => !ehQuitado(a));
      setCasos(listaAtiva);

      const cAtivos = aplicarEscopo(
        supabase.from("alunos").select("id", { count: "exact", head: true })
      ).not("status_atual", "ilike", "%QUITAD%");
      const cRetHoje = aplicarEscopo(
        supabase.from("alunos").select("id", { count: "exact", head: true }).eq("data_retorno", hoje)
      );
      const cSemContato = aplicarEscopo(
        supabase.from("alunos").select("id", { count: "exact", head: true }).lte("data_ultimo_acionamento", corte(10))
      );
      const c9 = aplicarEscopo(
        supabase.from("alunos").select("id", { count: "exact", head: true }).lte("data_ultimo_acionamento", corte(9))
      );
      const c11 = aplicarEscopo(
        supabase.from("alunos").select("id", { count: "exact", head: true }).lte("data_ultimo_acionamento", corte(11))
      );
      const cQuitados = aplicarEscopo(
        supabase
          .from("alunos")
          .select("id", { count: "exact", head: true })
          .or("status_atual.ilike.%QUITAD%,status_jornada.ilike.%QUITAD%,status_acionamento.ilike.%QUITAD%")
      );

      const [rAtivos, rRetHoje, rSemContato, r9, r11, rQuitados] = await Promise.all([
        cAtivos,
        cRetHoje,
        cSemContato,
        c9,
        c11,
        cQuitados,
      ]);

      let qAcordos = supabase.from("acordos").select("id,cpf,aluno_id,operador_responsavel_email,status,honorarios_valor");
      const alvo = emailEscopo();
      if (alvo) qAcordos = qAcordos.eq("operador_responsavel_email", alvo);
      const { data: acordos } = await qAcordos;
      const acordoIds = (acordos || []).map((a) => a.id);

      let parcelas = [];
      if (acordoIds.length) {
        const { data: parc } = await supabase
          .from("parcelas")
          .select("acordo_id,status,vencimento,pago_em,valor,honorarios")
          .in("acordo_id", acordoIds);
        parcelas = parc || [];
      }

      const inicioMes = `${hoje.slice(0, 7)}-01`;
      const parcelasPagasMes = parcelas.filter(
        (p) => p.status === "PAGO" && p.pago_em && p.pago_em >= inicioMes
      );
      const recebidosMes = parcelasPagasMes.length;
      const valorBaixadoMes = parcelasPagasMes.reduce((soma, p) => soma + Number(p.valor || 0), 0);
      const honorariosBaixadoMes = parcelasPagasMes.reduce((soma, p) => soma + Number(p.honorarios || 0), 0);

      const acordosComAtraso = new Set(
        parcelas
          .filter((p) => p.status !== "PAGO" && p.vencimento && p.vencimento < hoje)
          .map((p) => p.acordo_id)
      );
      const acordosAtivos = new Set((acordos || []).filter((a) => a.status === "ATIVO").map((a) => a.id));
      const acordosQuebrados = [...acordosComAtraso].filter((id) => acordosAtivos.has(id)).length;
      const acordoById = new Map((acordos || []).map((a) => [a.id, a]));
      const quebCpfs = [
        ...new Set(
          [...acordosComAtraso]
            .filter((id) => acordosAtivos.has(id))
            .map((id) => acordoById.get(id)?.cpf)
            .filter(Boolean)
        ),
      ];
      const recCpfs = [
        ...new Set(
          parcelas
            .filter((pp) => pp.status === "PAGO" && pp.pago_em && pp.pago_em >= inicioMes)
            .map((pp) => acordoById.get(pp.acordo_id)?.cpf)
            .filter(Boolean)
        ),
      ];
      setQuebradosCpfs(quebCpfs);
      setRecebidosCpfs(recCpfs);

      const up = (a) =>
        `${a.status_atual || ""} ${a.status_jornada || ""} ${a.status_acionamento || ""}`.toUpperCase();
      const acordosFechados = listaAtiva.filter((a) => up(a).includes("ACORDO_FECHADO")).length;
      const linksPagos = listaAtiva.filter((a) => up(a).includes("BAIXA_REALIZADA")).length;
      const termosAgPgto = listaAtiva.filter((a) => {
        const t = up(a);
        return t.includes("TERMO") && (t.includes("RECEBIDO") || t.includes("LIBERADO") || t.includes("ADM"));
      }).length;

      setKpis({
        ativos: rAtivos.count || 0,
        semContato: rSemContato.count || 0,
        criticos: Math.max(0, (r9.count || 0) - (r11.count || 0)),
        retornosHoje: rRetHoje.count || 0,
        acordosQuebrados,
        recebidosMes,
        valorBaixadoMes,
        honorariosBaixadoMes,
        quitados: rQuitados.count || 0,
        acordosFechados,
        linksPagos,
        termosAgPgto,
      });
    } catch (e) {
      console.error("Erro no PainelCarteira:", e);
      setErro("Nao foi possivel carregar todos os dados. " + (e?.message || ""));
    } finally {
      setCarregando(false);
    }
  }

  async function carregarDadosModal(id, cpf) {
    setCarregandoModal(true);
    try {
      const { data: mov } = await supabase
        .from("aluno_movimentacoes")
        .select("id,tipo,descricao,status_anterior,status_novo,registrado_por_nome,registrado_em")
        .eq("aluno_id", String(id))
        .order("registrado_em", { ascending: false })
        .limit(30);
      setHistorico(mov || []);

      if (cpf) {
        const { data: acs } = await supabase.from("acordos").select("honorarios_valor").eq("cpf", cpf);
        const total = (acs || []).reduce((s, x) => s + (Number(x.honorarios_valor) || 0), 0);
        setHonorarios(total || 0);
      } else {
        setHonorarios(0);
      }
    } finally {
      setCarregandoModal(false);
    }
  }

  // Carrega retornos ADM pendentes/em tratamento do operador (contador +
  // bloco no topo da carteira). RLS ja limita ao proprio operador.
  async function carregarRetornosPendentes() {
    const { data } = await supabase
      .from("retornos_adm")
      .select("id, aluno_id, resultado_adm, motivo, proximo_passo, status_tratamento, criado_em, operador_destino_nome")
      .in("status_tratamento", ["PENDENTE", "EM_TRATAMENTO"])
      .order("status_tratamento", { ascending: true })
      .order("criado_em", { ascending: true });
    setRetornosPendentes(data || []);
  }

  // Abre o modal (nao navega). Preserva a lista/filtros/paginacao atras.
  async function abrirModal(a) {
    if (!a?.id) return;
    setAlunoModal(a);
    setModalAberto(true);
    setAbaModal("resumo");
    setFeedback(null);
    setAcaoInline(null);
    setRetornoAluno(null);
    setStatusNovo(a.status_atual || "");
    setResumoConversa("");
    setRetornoData(a.data_retorno || "");
    setRetornoHora(a.hora_retorno || "");
    setObservacao(a.observacao || "");
    carregarDadosModal(a.id, a.cpf);

    // Retorno ADM acionavel deste aluno: abre a Tabulacao na acao certa.
    const { data: rets } = await supabase
      .from("retornos_adm")
      .select("*")
      .eq("aluno_id", a.id)
      .in("status_tratamento", ["PENDENTE", "EM_TRATAMENTO"])
      .order("criado_em", { ascending: true })
      .limit(1);
    const ret = rets && rets[0];
    if (ret) {
      setRetornoAluno(ret);
      setAbaModal("negociacao");
      const acao = RETORNO_ABRE_ACAO[ret.resultado_adm] || null;
      if (acao) setAcaoInline(acao);
      // Abrir o aluno = apenas marca visualizado (nao conclui).
      try { await supabase.rpc("retorno_adm_visualizar", { p_id: ret.id }); } catch (e) { /* silencioso */ }
    }
  }

  // Inicia o tratamento do retorno (PENDENTE -> EM_TRATAMENTO) ao abrir a acao.
  async function iniciarRetorno() {
    if (!retornoAluno || retornoAluno.status_tratamento !== "PENDENTE") return;
    try {
      await supabase.rpc("retorno_adm_iniciar", { p_id: retornoAluno.id });
      setRetornoAluno((r) => (r ? { ...r, status_tratamento: "EM_TRATAMENTO" } : r));
      carregarRetornosPendentes();
    } catch (e) { /* silencioso */ }
  }

  function fecharModal() {
    setModalAberto(false);
    setAlunoModal(null);
    setFeedback(null);
    setAcaoInline(null);
    setRetornoAluno(null);
    // A conclusao do retorno e feita pelo gatilho quando a acao real ocorre;
    // atualiza contador ao fechar.
    carregarRetornosPendentes();
  }

  // Recarrega o aluno atual (linha da carteira + modal) apos uma acao.
  async function atualizarTudo(id) {
    const { data: row } = await supabase.from("alunos").select(COLUNAS_ALUNO).eq("id", id).single();
    if (row) {
      setAlunoModal(row);
      setObservacao(row.observacao || "");
      setStatusNovo(row.status_atual || "");
      setRetornoData(row.data_retorno || "");
      setRetornoHora(row.hora_retorno || "");
      // Atualiza a linha correspondente na carteira sem recarregar tudo.
      setCasos((prev) => prev.map((c) => (c.id === id ? { ...c, ...row } : c)));
    }
    await carregarDadosModal(id, alunoModal?.cpf || row?.cpf);
    // Atualiza KPIs em segundo plano.
    carregar();
  }

  // Tabular / finalizar atendimento -- replica fielmente a gravacao do Aluno.
  async function finalizarAtendimento() {
    const a = alunoModal;
    if (!a?.id || salvando) return;
    if (!statusNovo) {
      setFeedback({ tipo: "erro", texto: "Selecione o status do atendimento." });
      return;
    }
    setSalvando(true);
    setFeedback(null);
    try {
      const agora = new Date().toISOString();
      const statusAntigo = a.status_atual || a.status_jornada || null;
      const atualizacaoAluno = {
        status_jornada: statusNovo,
        status_atual: statusNovo,
        proxima_acao: proximaAcaoDeStatus(statusNovo),
        data_ultimo_acionamento: agora,
        ultimo_contato: agora,
        registrado_por_nome: usuarioLogado?.nome || nomeOperadorPorEmail(email),
        registrado_por_email: email,
        registrado_em: agora,
      };
      if (retornoData) {
        atualizacaoAluno.data_retorno = retornoData;
        atualizacaoAluno.hora_retorno = retornoHora || null;
      }
      if (observacao !== (a.observacao || "")) {
        atualizacaoAluno.observacao = observacao;
      }

      const { error: erroUp } = await supabase.from("alunos").update(atualizacaoAluno).eq("id", a.id);
      if (erroUp) throw erroUp;

      const { error: erroMov } = await supabase.from("aluno_movimentacoes").insert({
        aluno_id: String(a.id),
        tipo: "FINALIZACAO_ATENDIMENTO",
        descricao:
          (resumoConversa.trim() ? resumoConversa.trim() + " " : "") +
          `Atendimento finalizado como "${labelStatus(statusNovo)}".` +
          (retornoData ? ` Retorno: ${formatarData(retornoData)}${retornoHora ? " " + retornoHora : ""}.` : ""),
        status_anterior: statusAntigo,
        status_novo: statusNovo,
        registrado_por_nome: usuarioLogado?.nome || nomeOperadorPorEmail(email),
        registrado_em: agora,
      });
      if (erroMov) throw erroMov;

      setResumoConversa("");
      setFeedback({ tipo: "ok", texto: "Atendimento salvo com sucesso." });
      await atualizarTudo(a.id);
    } catch (e) {
      console.error("Erro ao finalizar atendimento:", e);
      setFeedback({ tipo: "erro", texto: "Nao foi possivel salvar. " + (e?.message || "") });
    } finally {
      setSalvando(false);
    }
  }

  // Registrar apenas o resumo da conversa (movimentacao), sem trocar status.
  async function registrarResumo() {
    const a = alunoModal;
    if (!a?.id || salvando) return;
    if (!resumoConversa.trim()) {
      setFeedback({ tipo: "erro", texto: "Escreva o resumo da conversa." });
      return;
    }
    setSalvando(true);
    setFeedback(null);
    try {
      const agora = new Date().toISOString();
      const statusAtual = a.status_atual || a.status_jornada || null;
      const { error: erroUp } = await supabase
        .from("alunos")
        .update({ data_ultimo_acionamento: agora, ultimo_contato: agora })
        .eq("id", a.id);
      if (erroUp) throw erroUp;
      const { error: erroMov } = await supabase.from("aluno_movimentacoes").insert({
        aluno_id: String(a.id),
        tipo: "CONTATO",
        descricao: resumoConversa.trim(),
        status_anterior: statusAtual,
        status_novo: statusAtual,
        registrado_por_nome: usuarioLogado?.nome || nomeOperadorPorEmail(email),
        registrado_em: agora,
      });
      if (erroMov) throw erroMov;
      setResumoConversa("");
      setFeedback({ tipo: "ok", texto: "Resumo registrado." });
      await atualizarTudo(a.id);
    } catch (e) {
      console.error("Erro ao registrar resumo:", e);
      setFeedback({ tipo: "erro", texto: "Nao foi possivel registrar. " + (e?.message || "") });
    } finally {
      setSalvando(false);
    }
  }

  // Salvar observacoes (Resumo).
  async function salvarObservacao() {
    const a = alunoModal;
    if (!a?.id || salvando) return;
    setSalvando(true);
    setFeedback(null);
    try {
      const { error } = await supabase.from("alunos").update({ observacao }).eq("id", a.id);
      if (error) throw error;
      setFeedback({ tipo: "ok", texto: "Observacoes salvas." });
      await atualizarTudo(a.id);
    } catch (e) {
      console.error("Erro ao salvar observacao:", e);
      setFeedback({ tipo: "erro", texto: "Nao foi possivel salvar. " + (e?.message || "") });
    } finally {
      setSalvando(false);
    }
  }

  async function abrirEspecial(kpi) {
    if (filtroKpi === kpi) {
      setFiltroKpi(null);
      setCasosEspeciais(null);
      return;
    }
    setFiltroKpi(kpi);
    setCarregandoEspecial(true);
    try {
      let dados = [];
      if (kpi === "quitados") {
        let q = aplicarEscopo(supabase.from("alunos").select(COLUNAS_ALUNO))
          .or("status_atual.ilike.%QUITAD%,status_jornada.ilike.%QUITAD%,status_acionamento.ilike.%QUITAD%")
          .limit(1000);
        const { data } = await q;
        dados = data || [];
      } else {
        const cpfs = kpi === "acordosQuebrados" ? quebradosCpfs : recebidosCpfs;
        if (cpfs.length) {
          const { data } = await supabase.from("alunos").select(COLUNAS_ALUNO).in("cpf", cpfs).limit(1000);
          dados = data || [];
        }
      }
      setCasosEspeciais(dados);
    } catch (e) {
      console.error("Erro ao carregar lista especial:", e);
      setCasosEspeciais([]);
    } finally {
      setCarregandoEspecial(false);
    }
  }

  function onKpiClick(id) {
    if (KPIS_ESPECIAIS.has(id)) {
      abrirEspecial(id);
      return;
    }
    setCasosEspeciais(null);
    setFiltroKpi(filtroKpi === id ? null : id);
  }

  const listaFiltrada = useMemo(() => {
    const especialAtivo = filtroKpi && KPIS_ESPECIAIS.has(filtroKpi);
    let l = especialAtivo ? casosEspeciais || [] : casos;
    if (filtroKpi && !especialAtivo) {
      l = l.filter((a) => casoNoKpi(a, filtroKpi));
    }
    if (filtroStatus !== "TODOS") {
      l = l.filter((a) => statusPrazo(a).label === filtroStatus);
    }
    if (busca.trim()) {
      const t = busca.toLowerCase().trim();
      l = l.filter((a) =>
        [nomeAluno(a), a.cpf, a.telefone, a.responsavel_atual_nome, situacaoLabel(a)]
          .filter(Boolean)
          .some((c) => String(c).toLowerCase().includes(t))
      );
    }
    const keyDias = (a) => {
      const d = diasSemContato(a);
      return d === null ? Infinity : d;
    };
    const arr = [...l];
    if (ordenacao === "sem_contato_desc") arr.sort((a, b) => keyDias(b) - keyDias(a));
    else if (ordenacao === "sem_contato_asc") arr.sort((a, b) => keyDias(a) - keyDias(b));
    else if (ordenacao === "valor_desc") arr.sort((a, b) => (Number(b.valor_em_aberto) || 0) - (Number(a.valor_em_aberto) || 0));
    return arr;
  }, [casos, casosEspeciais, filtroStatus, busca, filtroKpi, ordenacao]);

  const kpiCards = [
    { id: "ativos", rot: "Casos ativos", val: kpis.ativos, cor: "#2563eb" },
    { id: "semContato", rot: "Sem contato +10 dias", val: kpis.semContato, cor: "#f59e0b" },
    { id: "criticos", rot: "Criticos (9-10 dias)", val: kpis.criticos, cor: "#dc2626" },
    { id: "retornosHoje", rot: "Retornos hoje", val: kpis.retornosHoje, cor: "#0ea5e9" },
    { id: "acordosQuebrados", rot: "Acordos quebrados", val: kpis.acordosQuebrados, cor: "#e11d48" },
    { id: "recebidosMes", rot: "Recebidos este mes", val: kpis.recebidosMes, cor: "#16a34a" },
    { id: "valorBaixadoMes", rot: "Valor baixado este mes", val: formatarMoeda(kpis.valorBaixadoMes), cor: "#16a34a" },
    { id: "honorariosBaixadoMes", rot: "Honorarios este mes", val: formatarMoeda(kpis.honorariosBaixadoMes), cor: "#0d9488" },
    { id: "quitados", rot: "Quitados", val: kpis.quitados, cor: "#16a34a" },
    { id: "acordosFechados", rot: "Acordos fechados", val: kpis.acordosFechados, cor: "#0891b2" },
    { id: "linksPagos", rot: "Links pagos", val: kpis.linksPagos, cor: "#16a34a" },
    { id: "termosAgPgto", rot: "Termos aguard. pgto", val: kpis.termosAgPgto, cor: "#7c3aed" },
  ];

  const painelReceptivo = (
    <div style={S.receptivoWrap}>
      <div style={S.receptivoInfo}>
        Rodizio de operadores online, pausa, atendimento e recebimento de leads.
        A distribuicao continua so para casos sem responsavel e a fidelizacao
        de 10 dias e mantida integralmente pelo servidor.
      </div>
      <ReceberLeads usuarioLogado={usuarioLogado} aoReceber={carregar} />
      <FilaReceptivo usuarioLogado={usuarioLogado} />
    </div>
  );

  const conteudo = (
    <div style={S.pagina} className="pc-root">
      <style>{CSS_RESPONSIVO}</style>
      <div style={S.cabecalho}>
        <div>
          <h1 style={S.titulo}>Minha Carteira</h1>
          <p style={S.subtitulo}>
            {veTudo ? "Visao completa da base de casos." : `Carteira de ${nomeOperadorPorEmail(email)}.`}
          </p>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <div style={S.userChip}>
            <span style={S.userNome}>{nomeOperadorPorEmail(email)}</span>
            <span style={S.userRole}>{veTudo ? "Gestao" : "Operador"}</span>
          </div>
          {veTudo && aba === "carteira" && (
            <select style={S.select} value={operadorFiltro} onChange={(e) => setOperadorFiltro(e.target.value)}>
              <option value="TODOS">Todos os operadores</option>
              {OPERADORES.map((o) => (
                <option key={o.email} value={o.email}>
                  {o.nome}
                </option>
              ))}
            </select>
          )}
          {aba === "carteira" && (
            <button style={S.btnAtualizar} onClick={carregar} disabled={carregando}>
              {carregando ? "Atualizando..." : "Atualizar"}
            </button>
          )}
        </div>
      </div>

      <div style={S.abas} role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={aba === "carteira"}
          onClick={() => setAba("carteira")}
          style={{ ...S.aba, ...(aba === "carteira" ? S.abaAtiva : {}) }}
        >
          Carteira
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={aba === "receptivo"}
          onClick={() => setAba("receptivo")}
          style={{ ...S.aba, ...(aba === "receptivo" ? S.abaAtiva : {}) }}
        >
          Receptivo
        </button>
      </div>

      {erro && <p style={S.erro}>{erro}</p>}

      {aba === "receptivo" ? (
        painelReceptivo
      ) : (
        <>
          {retornosPendentes.length > 0 && (
            <div style={S.retornoCarteira}>
              <div style={S.retornoCarteiraTopo}>
                <span style={S.retornoCarteiraBadge}>📌 Retornos do ADM</span>
                <span style={S.retornoCarteiraCont}>{retornosPendentes.length} pendente(s)</span>
              </div>
              <div style={S.retornoCarteiraLista}>
                {retornosPendentes.slice(0, 6).map((r) => {
                  const caso = casos.find((c) => c.id === r.aluno_id);
                  return (
                    <div
                      key={r.id}
                      style={S.retornoCarteiraItem}
                      onClick={() => caso && abrirModal(caso)}
                      title="Abrir atendimento"
                    >
                      <span style={S.retornoCarteiraNome}>{caso ? nomeAluno(caso) : "Aluno"}</span>
                      <span style={S.retornoCarteiraTag}>{labelStatus(r.resultado_adm)}</span>
                      <span style={S.retornoCarteiraStatus}>{r.status_tratamento}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div style={S.kpiGrid} className="pc-kpis">
            {kpiCards.map((k) => {
              const filtravel = KPIS_FILTRAVEIS.has(k.id) || KPIS_ESPECIAIS.has(k.id);
              const ativoK = filtroKpi === k.id;
              return (
                <div
                  key={k.id}
                  onClick={filtravel ? () => onKpiClick(k.id) : undefined}
                  style={{
                    ...S.kpiCard,
                    borderLeft: `3px solid ${k.cor}`,
                    cursor: filtravel ? "pointer" : "default",
                    boxShadow: ativoK ? `0 0 0 2px ${k.cor}` : S.kpiCard.boxShadow,
                  }}
                >
                  <p style={S.kpiRot}>{k.rot}</p>
                  <p style={{ ...S.kpiVal, color: k.cor }}>{k.val}</p>
                </div>
              );
            })}
          </div>

          <div style={S.painelTabela}>
            <div style={S.filtros}>
              <input
                style={S.inputBusca}
                placeholder="Pesquisar por CPF, nome ou telefone..."
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
              />
              <select style={S.select} value={filtroStatus} onChange={(e) => setFiltroStatus(e.target.value)}>
                <option value="TODOS">Todos os status</option>
                <option value="Dentro do prazo">Dentro do prazo</option>
                <option value="Atencao">Atencao</option>
                <option value="Critico">Critico</option>
                <option value="Perdendo o caso">Perdendo o caso</option>
                <option value="Aguardando pgto">Aguardando pgto</option>
                <option value="Juridico">Juridico</option>
              </select>
              <select style={S.select} value={ordenacao} onChange={(e) => setOrdenacao(e.target.value)}>
                <option value="sem_contato_desc">Mais antigo sem contato</option>
                <option value="sem_contato_asc">Mais recente sem contato</option>
                <option value="valor_desc">Maior valor em aberto</option>
              </select>
              {filtroKpi && (
                <div style={S.chipFiltro} onClick={() => { setFiltroKpi(null); setCasosEspeciais(null); }}>
                  {kpiCards.find((k) => k.id === filtroKpi)?.rot} ✕
                </div>
              )}
            </div>

            <div style={S.tabelaWrap}>
              <table style={S.tabela}>
                <thead>
                  <tr>
                    <th style={S.th}>Nome</th>
                    <th style={S.th}>CPF</th>
                    <th style={S.th}>Situacao</th>
                    <th style={S.th}>Ult. contato</th>
                    <th style={S.th}>Prox. contato</th>
                    <th style={S.thNum}>Valor aberto</th>
                    <th style={S.th}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {listaFiltrada.map((a) => {
                    const sp = statusPrazo(a);
                    return (
                      <tr key={a.id} style={S.tr} onClick={() => abrirModal(a)}>
                        <td style={S.td}>
                          <div style={S.nomeCel}>{nomeAluno(a)}</div>
                          <div style={S.subCel}>{a.telefone || "-"}</div>
                        </td>
                        <td style={S.td}>{a.cpf || "-"}</td>
                        <td style={S.td}>
                          <span style={S.badgeSituacao}>{situacaoLabel(a)}</span>
                        </td>
                        <td style={S.td}>{formatarData(a.data_ultimo_acionamento || a.ultimo_contato)}</td>
                        <td style={S.td}>{formatarData(a.data_retorno)}</td>
                        <td style={S.tdNum}>{formatarMoeda(a.valor_em_aberto)}</td>
                        <td style={S.td}>
                          <span style={{ ...S.badgeStatus, color: sp.cor }}>
                            <span style={{ ...S.bolinha, background: sp.cor }} />
                            {sp.label}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                  {listaFiltrada.length === 0 && (
                    <tr>
                      <td style={S.vazio} colSpan={7}>
                        {carregando || carregandoEspecial ? "Carregando..." : "Nenhum caso neste filtro."}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <p style={S.rodapeTabela}>
              Mostrando {listaFiltrada.length} de {casos.length} casos carregados. Clique numa linha para abrir o atendimento.
            </p>
          </div>
        </>
      )}

      {/* ---- Modal operacional ---- */}
      {modalAberto && alunoModal && (
        <div style={S.overlay} onClick={fecharModal}>
          <div style={S.modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <div style={S.modalHeader}>
              <div style={{ minWidth: 0 }}>
                <h2 style={S.modalNome}>{nomeAluno(alunoModal)}</h2>
                <div style={S.modalSub}>
                  {alunoModal.cpf || "-"} · {alunoModal.telefone || "sem telefone"} ·{" "}
                  <span style={{ color: statusPrazo(alunoModal).cor, fontWeight: 700 }}>
                    {statusPrazo(alunoModal).label}
                  </span>
                </div>
              </div>
              <button style={S.btnFechar} onClick={fecharModal} aria-label="Fechar">✕</button>
            </div>

            <div style={S.modalAbas} role="tablist">
              {ABAS_MODAL.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={abaModal === t.id}
                  onClick={() => setAbaModal(t.id)}
                  style={{ ...S.modalAba, ...(abaModal === t.id ? S.modalAbaAtiva : {}) }}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {feedback && (
              <div style={feedback.tipo === "ok" ? S.feedbackOk : S.feedbackErro}>{feedback.texto}</div>
            )}

            <div style={S.modalBody}>
              {abaModal === "resumo" && (
                <div style={S.secao}>
                  <div style={S.gridInfo}>
                    <Info rot="Operador responsavel" val={alunoModal.responsavel_atual_nome || "-"} />
                    <Info rot="Situacao" val={situacaoLabel(alunoModal)} />
                    <Info rot="Ultimo contato" val={formatarData(alunoModal.data_ultimo_acionamento || alunoModal.ultimo_contato)} />
                    <Info rot="Proximo contato" val={`${formatarData(alunoModal.data_retorno)}${alunoModal.hora_retorno ? " " + alunoModal.hora_retorno : ""}`} />
                    <Info rot="Valor em aberto" val={formatarMoeda(alunoModal.valor_em_aberto)} />
                    <Info rot="Honorarios" val={honorarios === null ? "..." : formatarMoeda(honorarios)} />
                  </div>
                  <label style={S.label}>Observacoes</label>
                  <textarea
                    style={S.textarea}
                    value={observacao}
                    onChange={(e) => setObservacao(e.target.value)}
                    placeholder="Observacoes internas sobre o aluno..."
                  />
                  <div style={S.acoesLinha}>
                    <button style={S.btnPrimario} onClick={salvarObservacao} disabled={salvando}>
                      {salvando ? "Salvando..." : "Salvar observacoes"}
                    </button>
                  </div>
                </div>
              )}

              {abaModal === "negociacao" && (
                <div style={S.secao}>
                  {/* Retorno do ADM (acionavel) aberto dentro da propria Tabulacao */}
                  {retornoAluno && (
                    <div style={S.retornoBox}>
                      <div style={S.retornoTop}>
                        <span style={S.retornoBadge}>📌 Retorno do ADM</span>
                        <span style={S.retornoStatus}>{retornoAluno.status_tratamento}</span>
                      </div>
                      <div style={S.retornoLinha}><strong>Resultado:</strong> {labelStatus(retornoAluno.resultado_adm)}</div>
                      {retornoAluno.motivo && <div style={S.retornoLinha}><strong>Motivo:</strong> {retornoAluno.motivo}</div>}
                      <div style={S.retornoLinha}><strong>Proximo passo:</strong> {retornoAluno.proximo_passo || "-"}</div>
                      <div style={S.retornoLinha}><strong>Recebido em:</strong> {formatarDataHora(retornoAluno.criado_em)}</div>
                      <div style={S.retornoDica}>Trate a acao abaixo. O alerta so encerra quando a acao real for executada.</div>
                    </div>
                  )}

                  <label style={S.label}>Tabular atendimento (status)</label>
                  <select style={S.select} value={statusNovo} onChange={(e) => setStatusNovo(e.target.value)}>
                    <option value="">Selecione o status...</option>
                    {STATUS_FINALIZACAO.map((s) => (
                      <option key={s} value={s}>{labelStatus(s)}</option>
                    ))}
                  </select>

                  <div style={S.proximaAcao}>
                    Proxima acao: <strong>{statusNovo ? proximaAcaoDeStatus(statusNovo) : "-"}</strong>
                  </div>

                  <label style={S.label}>Resumo da conversa</label>
                  <textarea
                    style={S.textarea}
                    value={resumoConversa}
                    onChange={(e) => setResumoConversa(e.target.value)}
                    placeholder="O que foi tratado no atendimento..."
                  />

                  <label style={S.label}>Agendar retorno</label>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input type="date" style={{ ...S.input, flex: 1 }} value={retornoData} onChange={(e) => setRetornoData(e.target.value)} />
                    <input type="time" style={{ ...S.input, width: 120 }} value={retornoHora} onChange={(e) => setRetornoHora(e.target.value)} />
                  </div>

                  <div style={S.acoesLinha}>
                    <button style={S.btnSecundario} onClick={registrarResumo} disabled={salvando}>
                      {salvando ? "..." : "Registrar resumo"}
                    </button>
                    <button style={S.btnPrimario} onClick={finalizarAtendimento} disabled={salvando}>
                      {salvando ? "Salvando..." : "Finalizar atendimento"}
                    </button>
                  </div>

                  {/* Acoes operacionais INLINE (nao ha aba Solicitacoes) */}
                  <div style={S.acoesInlineTitulo}>Acoes</div>
                  <div style={S.acoesInlineBotoes}>
                    <button style={S.btnAcaoInline} onClick={() => { setAcaoInline(acaoInline === "link" ? null : "link"); iniciarRetorno(); }}>🔗 Solicitar link</button>
                    <button style={S.btnAcaoInline} onClick={() => { setAcaoInline(acaoInline === "termo" ? null : "termo"); iniciarRetorno(); }}>📄 Solicitar termo</button>
                    <button style={S.btnAcaoInline} onClick={() => { setAcaoInline(acaoInline === "financeiro" ? null : "financeiro"); iniciarRetorno(); }}>💰 Enviar ao financeiro</button>
                    <button style={S.btnAcaoInline} onClick={() => { setAcaoInline(acaoInline === "pagamento" ? null : "pagamento"); iniciarRetorno(); }}>🧾 Informar pagamento</button>
                  </div>

                  {acaoInline === "link" && (
                    <div style={S.blocoInline}>
                      <LinksPagamentoAluno aluno={alunoModal} usuarioLogado={usuarioLogado} onAtualizar={() => atualizarTudo(alunoModal.id)} />
                    </div>
                  )}
                  {acaoInline === "termo" && (
                    <div style={S.blocoInline}>
                      <FinalizacaoTermo aluno={alunoModal} />
                    </div>
                  )}
                  {acaoInline === "financeiro" && (
                    <div style={S.blocoInline}>
                      <EnvioFinanceiro aluno={alunoModal} />
                    </div>
                  )}
                  {acaoInline === "pagamento" && (
                    <div style={S.blocoInline}>
                      <ConfirmarPagamento aluno={alunoModal} />
                    </div>
                  )}
                </div>
              )}

              {abaModal === "financeiro" && (
                <div style={S.secao}>
                  <FinanceiroAluno aluno={alunoModal} />
                </div>
              )}

              {abaModal === "historico" && (
                <div style={S.secao}>
                  {carregandoModal && historico.length === 0 && <p style={S.subCel}>Carregando...</p>}
                  {!carregandoModal && historico.length === 0 && <p style={S.subCel}>Sem movimentacoes registradas.</p>}
                  <div style={S.timeline}>
                    {historico.map((h) => (
                      <div key={h.id} style={S.itemHist}>
                        <div style={S.histData}>{formatarDataHora(h.registrado_em)}</div>
                        <div style={S.histDesc}>{h.descricao || h.tipo || h.status_novo || "Movimentacao"}</div>
                        {(h.status_anterior || h.status_novo) && (
                          <div style={S.histStatus}>
                            {labelStatus(h.status_anterior)} → {labelStatus(h.status_novo)}
                          </div>
                        )}
                        {h.registrado_por_nome && <div style={S.histAutor}>por {h.registrado_por_nome}</div>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

            </div>
          </div>
        </div>
      )}
    </div>
  );
  return embedded ? conteudo : <main className="content">{conteudo}</main>;
}

function Info({ rot, val }) {
  return (
    <div style={S.infoBox}>
      <div style={S.infoRot}>{rot}</div>
      <div style={S.infoVal}>{val}</div>
    </div>
  );
}

const CSS_RESPONSIVO = `
  @media (max-width: 640px) {
    .pc-kpis { grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)) !important; }
    .pc-root { padding: 16px !important; }
  }
`;

const COR_BORDA = "#e6eaf0";
const COR_BORDA_SUAVE = "#eef2f6";

const S = {
  pagina: { padding: "24px", fontFamily: "Inter, Arial, sans-serif", background: "#f6f8fb", minHeight: "100%", color: "#334155" },
  cabecalho: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, marginBottom: 14, flexWrap: "wrap" },
  titulo: { margin: 0, marginBottom: 2, color: "#1e293b", fontSize: 22, fontWeight: 700, letterSpacing: "-0.01em" },
  subtitulo: { margin: 0, color: "#94a3b8", fontSize: 13 },
  userChip: { display: "flex", flexDirection: "column", alignItems: "flex-end", lineHeight: 1.15, padding: "4px 12px", background: "#fff", border: `1px solid ${COR_BORDA}`, borderRadius: 10 },
  userNome: { fontWeight: 600, color: "#1e293b", fontSize: 13 },
  userRole: { fontSize: 10.5, color: "#8b5cf6", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em" },
  select: { padding: "8px 11px", borderRadius: 8, border: `1px solid ${COR_BORDA}`, background: "#fff", fontSize: 13, color: "#334155" },
  btnAtualizar: { background: "#fff", color: "#475569", border: `1px solid ${COR_BORDA}`, padding: "8px 15px", borderRadius: 8, cursor: "pointer", fontWeight: 600, fontSize: 13 },
  erro: { color: "#b91c1c", fontWeight: 600, fontSize: 13 },

  abas: { display: "flex", gap: 4, marginBottom: 18, borderBottom: `1px solid ${COR_BORDA}` },
  aba: { background: "transparent", border: "1px solid transparent", borderBottom: "none", borderTopLeftRadius: 8, borderTopRightRadius: 8, padding: "8px 16px", fontSize: 13.5, fontWeight: 600, color: "#94a3b8", cursor: "pointer", marginBottom: -1 },
  abaAtiva: { background: "#fff", color: "#1e293b", border: `1px solid ${COR_BORDA}`, borderBottom: "1px solid #fff" },

  receptivoWrap: { display: "flex", flexDirection: "column", gap: 12, maxWidth: 720 },
  receptivoInfo: { background: "#fff", border: `1px solid ${COR_BORDA}`, borderRadius: 12, padding: "10px 14px", fontSize: 12.5, color: "#94a3b8", lineHeight: 1.5 },

  kpiGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 18 },
  kpiCard: { background: "#fff", borderRadius: 12, padding: "11px 14px", border: `1px solid ${COR_BORDA_SUAVE}`, boxShadow: "0 1px 2px rgba(15,23,42,0.04)" },
  kpiRot: { margin: "0 0 4px 0", fontSize: 11.5, color: "#94a3b8", fontWeight: 500 },
  kpiVal: { margin: 0, fontSize: 21, fontWeight: 700, letterSpacing: "-0.01em" },

  painelTabela: { background: "#fff", borderRadius: 14, padding: 16, border: `1px solid ${COR_BORDA_SUAVE}`, boxShadow: "0 1px 2px rgba(15,23,42,0.04)" },
  filtros: { display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14, alignItems: "center" },
  inputBusca: { flex: 1, minWidth: 200, padding: "9px 12px", borderRadius: 8, border: `1px solid ${COR_BORDA}`, fontSize: 13, color: "#334155" },
  chipFiltro: { display: "inline-block", cursor: "pointer", background: "#f1f5f9", color: "#475569", border: `1px solid ${COR_BORDA}`, borderRadius: 999, padding: "5px 11px", fontSize: 11.5, fontWeight: 600 },
  tabelaWrap: { overflowX: "auto" },
  tabela: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", padding: "9px 8px", color: "#94a3b8", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.03em", borderBottom: `1px solid ${COR_BORDA}`, whiteSpace: "nowrap" },
  thNum: { textAlign: "right", padding: "9px 8px", color: "#94a3b8", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.03em", borderBottom: `1px solid ${COR_BORDA}`, whiteSpace: "nowrap" },
  tr: { cursor: "pointer", borderBottom: `1px solid ${COR_BORDA_SUAVE}` },
  td: { padding: "10px 8px", color: "#475569", verticalAlign: "middle" },
  tdNum: { padding: "10px 8px", color: "#1e293b", textAlign: "right", whiteSpace: "nowrap", fontWeight: 600 },
  nomeCel: { fontWeight: 600, color: "#1e293b" },
  subCel: { fontSize: 11.5, color: "#a3adba" },
  badgeSituacao: { display: "inline-block", padding: "2px 8px", borderRadius: 6, background: "#eef2ff", color: "#4f46e5", fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" },
  badgeStatus: { display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, fontWeight: 600, whiteSpace: "nowrap" },
  bolinha: { width: 7, height: 7, borderRadius: "50%", display: "inline-block" },
  vazio: { padding: 24, textAlign: "center", color: "#a3adba" },
  rodapeTabela: { margin: "10px 0 0 0", fontSize: 11.5, color: "#a3adba" },

  // Modal
  overlay: { position: "fixed", inset: 0, background: "rgba(15,23,42,0.45)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "40px 16px", zIndex: 1000, overflowY: "auto" },
  modal: { width: "100%", maxWidth: 860, background: "#fff", borderRadius: 16, boxShadow: "0 20px 50px rgba(15,23,42,0.25)", overflow: "hidden" },
  modalHeader: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, padding: "18px 20px", borderBottom: `1px solid ${COR_BORDA_SUAVE}` },
  modalNome: { margin: 0, fontSize: 18, fontWeight: 700, color: "#1e293b" },
  modalSub: { fontSize: 12.5, color: "#94a3b8", marginTop: 4 },
  btnFechar: { background: "#f1f5f9", border: "none", borderRadius: 8, width: 32, height: 32, cursor: "pointer", color: "#475569", fontSize: 14, flexShrink: 0 },
  modalAbas: { display: "flex", gap: 2, padding: "0 20px", borderBottom: `1px solid ${COR_BORDA_SUAVE}`, flexWrap: "wrap" },
  modalAba: { background: "transparent", border: "none", borderBottom: "2px solid transparent", padding: "10px 12px", fontSize: 13, fontWeight: 600, color: "#94a3b8", cursor: "pointer" },
  modalAbaAtiva: { color: "#2563eb", borderBottom: "2px solid #2563eb" },
  feedbackOk: { margin: "12px 20px 0", padding: "8px 12px", borderRadius: 8, background: "#eefbf3", color: "#15803d", fontSize: 12.5, fontWeight: 600 },
  feedbackErro: { margin: "12px 20px 0", padding: "8px 12px", borderRadius: 8, background: "#fef2f2", color: "#b91c1c", fontSize: 12.5, fontWeight: 600 },
  modalBody: { padding: 20, maxHeight: "62vh", overflowY: "auto" },
  secao: { display: "flex", flexDirection: "column", gap: 12 },
  gridInfo: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 },
  infoBox: { background: "#f9fafc", border: `1px solid ${COR_BORDA_SUAVE}`, borderRadius: 10, padding: "8px 12px" },
  infoRot: { fontSize: 11, color: "#94a3b8", marginBottom: 2 },
  infoVal: { fontSize: 13.5, color: "#1e293b", fontWeight: 600 },
  label: { fontSize: 12, fontWeight: 600, color: "#475569", marginTop: 4 },
  input: { padding: "9px 11px", borderRadius: 8, border: `1px solid ${COR_BORDA}`, fontSize: 13, background: "#fff", color: "#334155" },
  textarea: { padding: "9px 11px", borderRadius: 8, border: `1px solid ${COR_BORDA}`, fontSize: 13, minHeight: 70, resize: "vertical", fontFamily: "inherit", background: "#fff", color: "#334155" },
  proximaAcao: { fontSize: 12.5, color: "#64748b", background: "#f9fafc", border: `1px solid ${COR_BORDA_SUAVE}`, borderRadius: 8, padding: "8px 12px" },
  acoesLinha: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 },
  btnPrimario: { background: "#2563eb", color: "#fff", border: "none", borderRadius: 8, padding: "9px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer" },
  btnSecundario: { background: "#eef2f6", color: "#475569", border: "none", borderRadius: 8, padding: "9px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer" },
  timeline: { display: "flex", flexDirection: "column", gap: 10 },
  itemHist: { borderLeft: `2px solid ${COR_BORDA}`, paddingLeft: 12 },
  histData: { fontSize: 11, color: "#a3adba" },
  histDesc: { fontSize: 13, color: "#334155" },
  histStatus: { fontSize: 11.5, color: "#6366f1", fontWeight: 600 },
  histAutor: { fontSize: 11, color: "#a3adba" },

  // Retorno do ADM — bloco na Tabulacao
  retornoBox: { background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 12, padding: 12, display: "flex", flexDirection: "column", gap: 4 },
  retornoTop: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  retornoBadge: { fontSize: 12.5, fontWeight: 700, color: "#c2410c" },
  retornoStatus: { fontSize: 11, fontWeight: 700, color: "#9a3412", background: "#ffedd5", borderRadius: 999, padding: "2px 8px" },
  retornoLinha: { fontSize: 12.5, color: "#7c2d12" },
  retornoDica: { fontSize: 11.5, color: "#9a3412", marginTop: 2, fontStyle: "italic" },
  acoesInlineTitulo: { fontSize: 12, fontWeight: 700, color: "#475569", marginTop: 6 },
  acoesInlineBotoes: { display: "flex", flexWrap: "wrap", gap: 8 },
  btnAcaoInline: { background: "#eef2f6", color: "#334155", border: `1px solid ${COR_BORDA}`, borderRadius: 8, padding: "8px 12px", fontSize: 12.5, fontWeight: 600, cursor: "pointer" },
  blocoInline: { border: `1px solid ${COR_BORDA_SUAVE}`, borderRadius: 10, padding: 4, background: "#fbfcfe" },

  // Retorno do ADM — bloco na Carteira
  retornoCarteira: { background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 12, padding: "10px 14px", marginBottom: 14 },
  retornoCarteiraTopo: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  retornoCarteiraBadge: { fontSize: 13, fontWeight: 700, color: "#c2410c" },
  retornoCarteiraCont: { fontSize: 12, fontWeight: 700, color: "#9a3412", background: "#ffedd5", borderRadius: 999, padding: "2px 10px" },
  retornoCarteiraLista: { display: "flex", flexDirection: "column", gap: 6 },
  retornoCarteiraItem: { display: "flex", alignItems: "center", gap: 10, cursor: "pointer", background: "#fff", border: `1px solid ${COR_BORDA_SUAVE}`, borderRadius: 8, padding: "7px 10px" },
  retornoCarteiraNome: { flex: 1, fontWeight: 600, color: "#1e293b", fontSize: 13 },
  retornoCarteiraTag: { fontSize: 11, fontWeight: 600, color: "#c2410c", background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 6, padding: "2px 8px" },
  retornoCarteiraStatus: { fontSize: 11, color: "#94a3b8" },
};
