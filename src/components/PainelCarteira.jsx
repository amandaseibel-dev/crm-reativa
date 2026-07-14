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
import CadastroNovoAluno from "./CadastroNovoAluno";
import VisaoGeralCarteira from "./VisaoGeralCarteira";
import VisaoGestao360 from "./VisaoGestao360";

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
  "id,nome,nome_aluno,cpf,telefone,valor_em_aberto,status_atual,status_jornada,status_acionamento,nivel_criticidade,data_ultimo_acionamento,ultimo_contato,data_retorno,hora_retorno,responsavel_atual_nome,responsavel_atual_email,observacao,unidade,curso,processo_numero";

// Aba "Solicitacoes" foi removida: Solicitar link / termo / financeiro /
// informar pagamento / anexar comprovante ficam INLINE dentro da Tabulacao
// (aba Negociacao), que e o centro unico do operador.
// Casos nao acionaveis: nao aparecem na lista operacional (continuam
// disponiveis para consulta/historico). Somente status ja existentes.
const STATUS_NAO_ACIONAVEIS = ["JURIDICO", "CANCELAMENTO_COBRANCA", "SUSPENSAO_COBRANCA", "AGUARDANDO_BAIXA"];

function ehNaoAcionavel(a) {
  const s = String(a?.status_atual || "").toUpperCase();
  if (s.startsWith("QUITAD")) return true; // QUITADO / QUITADO_MANUAL / QUITACAO...
  return STATUS_NAO_ACIONAVEIS.includes(a?.status_atual);
}

// Dias de atraso de uma parcela (hoje - vencimento), em dias inteiros.
function diasAtraso(vencimentoISO, hojeISO) {
  if (!vencimentoISO) return null;
  const v = new Date(String(vencimentoISO).slice(0, 10) + "T00:00:00");
  const h = new Date(String(hojeISO).slice(0, 10) + "T00:00:00");
  if (Number.isNaN(v.getTime()) || Number.isNaN(h.getTime())) return null;
  return Math.round((h.getTime() - v.getTime()) / (1000 * 60 * 60 * 24));
}

const CARDS_FINANCEIROS = new Set(["valorBaixadoMes", "recebidosMes", "honorariosBaixadoMes"]);

// Tamanho do lote para consultas .in() consolidadas (evita URL longa e N+1).
const LOTE_IN = 200;

// Tipos de movimentacao que representam uma TABULACAO real do operador.
// Somente a finalizacao de atendimento (o operador tabulou o resultado).
// Nao contam: cargas automaticas, retorno do ADM, alteracao de operador,
// abertura/visualizacao da ficha, correcao de cadastro, observacao etc.
const TIPOS_ACIONAMENTO = ["FINALIZACAO_ATENDIMENTO", "FINALIZACAO"];

// CPF normalizado: so digitos (remove pontos, tracos e espacos).
function normalizarCpf(cpf) {
  return String(cpf || "").replace(/\D/g, "");
}

// Dias uteis (seg-sex) transcorridos no mes ate a data informada (inclusive).
function diasUteisTranscorridos(hojeISO) {
  const h = new Date(String(hojeISO).slice(0, 10) + "T00:00:00");
  if (Number.isNaN(h.getTime())) return 0;
  let count = 0;
  for (let d = 1; d <= h.getDate(); d++) {
    const wd = new Date(h.getFullYear(), h.getMonth(), d).getDay();
    if (wd !== 0 && wd !== 6) count++;
  }
  return count;
}

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
    semAcionamento10: 0,
    proximosPerder: 0,
    retornosHoje: 0,
    retornosAdm: 0,
    acordoAVencer: 0,
    acordoAtrasado: 0,
    acordoQuebrado: 0,
    recebidosMes: 0,
    valorBaixadoMes: 0,
    honorariosBaixadoMes: 0,
  });

  const [busca, setBusca] = useState("");
  const [filtroStatus, setFiltroStatus] = useState("TODOS");
  const [filtroKpi, setFiltroKpi] = useState(null);
  const [ordenacao, setOrdenacao] = useState("sem_contato_desc");
  const [casosEspeciais, setCasosEspeciais] = useState(null);
  const [carregandoEspecial, setCarregandoEspecial] = useState(false);
  // Ids de alunos por estado de acordo (para clique dos cards operacionais).
  const [acordoBuckets, setAcordoBuckets] = useState({ aVencer: [], atrasado: [], quebrado: [] });
  // Detalhamento de parcelas baixadas no mes (cards financeiros).
  const [detalheParcelas, setDetalheParcelas] = useState([]);
  const [detalheFinanceiro, setDetalheFinanceiro] = useState(null); // { tipo, titulo }
  // Financeiro consolidado por aluno (valor em aberto sem duplicidade).
  // { [aluno_id]: { mensalidades, acordos, total, temDetalhe, temAtraso, acordoResponsavel } }
  const [finAlunos, setFinAlunos] = useState({});
  // Meu desempenho operacional (indicadores pessoais do operador logado).
  const [desempenho, setDesempenho] = useState(null);
  const [acionadosHojeIds, setAcionadosHojeIds] = useState([]);
  const [semPrimeiroIds, setSemPrimeiroIds] = useState([]);

  // ---- Modal operacional ----
  const [modalAberto, setModalAberto] = useState(false);
  const [alunoModal, setAlunoModal] = useState(null);
  const [abaModal, setAbaModal] = useState("resumo");
  const [historico, setHistorico] = useState([]);
  const [honorarios, setHonorarios] = useState(null);
  const [carregandoModal, setCarregandoModal] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [editandoOperador, setEditandoOperador] = useState(false);
  const [novoOperadorEmailModal, setNovoOperadorEmailModal] = useState("");
  const [salvandoOperador, setSalvandoOperador] = useState(false);
  const [feedback, setFeedback] = useState(null); // { tipo: "ok"|"erro", texto }

  // Formulario de tabulacao/finalizacao (Negociacao)
  const [statusNovo, setStatusNovo] = useState("");
  const [resumoConversa, setResumoConversa] = useState("");
  const [retornoData, setRetornoData] = useState("");
  const [retornoHora, setRetornoHora] = useState("");
  const [observacao, setObservacao] = useState("");

  // Acoes inline dentro da Tabulacao (link/termo/financeiro/pagamento).
  const [acaoInline, setAcaoInline] = useState(null);
  // Quando o operador clica na acao (ex.: "Solicitar link"), abre o formulario
  // ja de cara. Quando a acao abre por retorno do ADM, fica false (mostra o
  // estado atual do link, sem novo pedido).
  const [abrirFormInicial, setAbrirFormInicial] = useState(false);
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
      let ativosCanonico = null;
      try {
        let __qCanon = supabase.from("casos").select("id", { count: "exact", head: true });
        if (alvoEscopo) __qCanon = __qCanon.eq("operador_email", alvoEscopo);
        const { count: __cc } = await __qCanon;
        ativosCanonico = __cc;
      } catch (e) { ativosCanonico = null; }
      try {
        const { data: __vv } = await supabase.rpc("valor_carteira_operador", { p_email: alvoEscopo });
        setValorCarteira(Number(__vv) || 0);
      } catch (e) { ativosCanonico = null; }
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
      // Lista operacional: fora quitados e demais nao-acionaveis (status
      // existentes). Casos continuam no banco para consulta/historico.
      const listaAtiva = todas.filter((a) => !ehQuitado(a) && !ehNaoAcionavel(a));
      setCasos(listaAtiva);

      // Contagens por data (usam a mesma base escopada).
      const cRetHoje = aplicarEscopo(
        supabase.from("alunos").select("id,status_atual,status_jornada,status_acionamento").eq("data_retorno", hoje).limit(5000)
      );
      const cSemAcion10 = aplicarEscopo(
        supabase.from("alunos").select("id,status_atual,status_jornada,status_acionamento").lte("data_ultimo_acionamento", corte(10)).limit(5000)
      );
      const cProx = aplicarEscopo(
        supabase.from("alunos").select("id,status_atual,status_jornada,status_acionamento").lte("data_ultimo_acionamento", corte(9)).gt("data_ultimo_acionamento", corte(11)).limit(5000)
      );

      const [rRetHoje, rSemAcion10, rProx] = await Promise.all([cRetHoje, cSemAcion10, cProx]);
      const soAcionaveis = (r) => (r?.data || []).filter((a) => !ehQuitado(a) && !ehNaoAcionavel(a));
      const nRetHoje = soAcionaveis(rRetHoje).length;
      const nSemAcion10 = soAcionaveis(rSemAcion10).length;
      const nProx = soAcionaveis(rProx).length;

      // Acordos do operador -> parcelas -> classificacao por vencimento.
      let qAcordos = supabase.from("acordos").select("id,cpf,aluno_id,operador_responsavel_email,status");
      const alvo = emailEscopo();
      if (alvo) qAcordos = qAcordos.eq("operador_responsavel_email", alvo);
      const { data: acordos } = await qAcordos;
      const acordoIds = (acordos || []).map((a) => a.id);
      const acordoById = new Map((acordos || []).map((a) => [a.id, a]));

      let parcelas = [];
      if (acordoIds.length) {
        const { data: parc } = await supabase
          .from("parcelas")
          .select("acordo_id,numero,status,vencimento,pago_em,valor,honorarios")
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

      // Mapa aluno_id -> {nome, cpf} para o detalhamento financeiro.
      const alunoInfo = new Map(todas.map((a) => [String(a.id), a]));

      // Detalhamento das parcelas baixadas no mes (soma bate com os cards).
      const detalhe = parcelasPagasMes.map((p) => {
        const ac = acordoById.get(p.acordo_id) || {};
        const al = alunoInfo.get(String(ac.aluno_id)) || {};
        return {
          aluno_id: ac.aluno_id || null,
          aluno_nome: nomeAluno(al) !== "Aluno sem nome" ? nomeAluno(al) : (al.nome || "-"),
          cpf: al.cpf || ac.cpf || "-",
          acordo_id: p.acordo_id,
          parcela: p.numero,
          data_baixa: p.pago_em,
          valor: Number(p.valor || 0),
          honorarios: Number(p.honorarios || 0),
          operador: ac.operador_responsavel_email || "-",
        };
      });
      setDetalheParcelas(detalhe);

      // Estados de acordo (parcelas nao pagas de acordos ATIVOS), por aluno unico.
      const setAVencer = new Set();
      const setAtrasado = new Set();
      const setQuebrado = new Set();
      for (const p of parcelas) {
        if (p.status === "PAGO") continue;
        const ac = acordoById.get(p.acordo_id);
        if (!ac || ac.status !== "ATIVO" || !ac.aluno_id) continue;
        const d = diasAtraso(p.vencimento, hoje);
        if (d === null) continue;
        const aid = String(ac.aluno_id);
        if (d <= 0) setAVencer.add(aid); // vencimento futuro
        else if (d >= 1 && d <= 30) setAtrasado.add(aid);
        else if (d >= 31) setQuebrado.add(aid);
      }
      setAcordoBuckets({
        aVencer: [...setAVencer],
        atrasado: [...setAtrasado],
        quebrado: [...setQuebrado],
      });

      setKpis({
        ativos: ativosCanonico ?? listaAtiva.length,
        semAcionamento10: nSemAcion10,
        proximosPerder: nProx,
        retornosHoje: nRetHoje,
        retornosAdm: retornosPendentes.length,
        acordoAVencer: setAVencer.size,
        acordoAtrasado: setAtrasado.size,
        acordoQuebrado: setQuebrado.size,
        recebidosMes,
        valorBaixadoMes,
        honorariosBaixadoMes,
      });

      // ---- Valor em aberto consolidado por aluno (sem duplicidade) ----
      // Regra: (1) parcelas A_VENCER/VENCIDA de acordos ATIVO +
      // (2) titulos/mensalidades importados em_aberto (nao vinculados a acordo;
      // status 'vinculada'/'quitada' ficam de fora, ja representados nas parcelas).
      // Sem N+1: consultas consolidadas em lote sobre os alunos da carteira.
      try {
        const idsCarteira = listaAtiva.map((a) => String(a.id));
        const fin = {};
        for (const id of idsCarteira) {
          fin[id] = {
            mensalidades: 0,
            acordos: 0,
            total: 0,
            temDetalhe: false,
            temAtraso: false,
            temAVencer: false,
            acordoResponsavel: null,
          };
        }

        // 1) Acordos ATIVO dos alunos da carteira (qualquer responsavel do acordo).
        const acAluno = [];
        for (let i = 0; i < idsCarteira.length; i += LOTE_IN) {
          const lote = idsCarteira.slice(i, i + LOTE_IN);
          const { data } = await supabase
            .from("acordos")
            .select("id,aluno_id,operador_responsavel_email,status")
            .in("aluno_id", lote)
            .eq("status", "ATIVO");
          if (data) acAluno.push(...data);
        }
        const acAlunoById = new Map(acAluno.map((a) => [a.id, a]));
        const acAlunoIds = acAluno.map((a) => a.id);

        // Parcelas em aberto desses acordos.
        for (let i = 0; i < acAlunoIds.length; i += LOTE_IN) {
          const lote = acAlunoIds.slice(i, i + LOTE_IN);
          if (!lote.length) continue;
          const { data } = await supabase
            .from("parcelas")
            .select("acordo_id,status,valor,vencimento")
            .in("acordo_id", lote)
            .in("status", ["A_VENCER", "VENCIDA"]);
          for (const p of data || []) {
            const ac = acAlunoById.get(p.acordo_id);
            if (!ac || !ac.aluno_id) continue;
            const id = String(ac.aluno_id);
            if (!fin[id]) continue;
            fin[id].acordos += Number(p.valor || 0);
            fin[id].temDetalhe = true;
            fin[id].acordoResponsavel = ac.operador_responsavel_email || fin[id].acordoResponsavel;
            if (p.status === "VENCIDA") fin[id].temAtraso = true;
            else fin[id].temAVencer = true;
          }
        }

        // 2) Titulos/mensalidades importados em aberto (borderos ja normalizados aqui).
        for (let i = 0; i < idsCarteira.length; i += LOTE_IN) {
          const lote = idsCarteira.slice(i, i + LOTE_IN);
          const { data } = await supabase
            .from("acordos_titulos")
            .select("aluno_id,status,valor_em_aberto,saldo_corrigido,valor_original,vencimento")
            .in("aluno_id", lote)
            .eq("status", "em_aberto");
          for (const t of data || []) {
            const id = String(t.aluno_id);
            if (!fin[id]) continue;
            const v = Number(t.valor_em_aberto ?? t.saldo_corrigido ?? t.valor_original ?? 0);
            fin[id].mensalidades += v;
            fin[id].temDetalhe = true;
            const d = diasAtraso(t.vencimento, hoje);
            if (d !== null && d > 0) fin[id].temAtraso = true;
            else if (d !== null) fin[id].temAVencer = true;
          }
        }

        for (const id of idsCarteira) {
          fin[id].total = fin[id].mensalidades + fin[id].acordos;
        }
        setFinAlunos(fin);
      } catch (eFin) {
        console.error("Erro ao consolidar valor em aberto:", eFin);
      }

      // ---- Meu desempenho operacional (do operador logado) ----
      // Acionamento valido = tabulacao real (FINALIZACAO_ATENDIMENTO) feita
      // pelo operador. Conta por CPF NORMALIZADO unico (fallback aluno_id
      // quando nao ha CPF). Duas fichas com o mesmo CPF contam uma vez por dia.
      try {
        const inicioMesTS = `${hoje.slice(0, 7)}-01T00:00:00`;
        const { data: movMes } = await supabase
          .from("aluno_movimentacoes")
          .select("aluno_id,registrado_em")
          .eq("registrado_por_email", email)
          .in("tipo", TIPOS_ACIONAMENTO)
          .gte("registrado_em", inicioMesTS);

        // Mapa aluno_id -> cpf para deduplicar por CPF (em lote, sem N+1).
        const movAlunoIds = [...new Set((movMes || []).map((m) => String(m.aluno_id)).filter(Boolean))];
        const cpfPorAluno = {};
        for (let i = 0; i < movAlunoIds.length; i += LOTE_IN) {
          const lote = movAlunoIds.slice(i, i + LOTE_IN);
          const { data } = await supabase.from("alunos").select("id,cpf").in("id", lote);
          for (const a of data || []) cpfPorAluno[String(a.id)] = a.cpf;
        }
        // Chave unica: CPF normalizado quando existir; senao o proprio aluno_id.
        const chaveCpf = (alunoId) => {
          const c = normalizarCpf(cpfPorAluno[String(alunoId)]);
          return c ? "C:" + c : "A:" + String(alunoId);
        };

        const setHoje = new Set(); // chaves de CPF acionadas hoje
        const setMes = new Set(); // chaves de CPF acionadas no mes
        const acionadosHojeAlunos = new Set(); // ids de ficha p/ a listagem clicavel
        for (const m of movMes || []) {
          if (!m.aluno_id) continue;
          const k = chaveCpf(m.aluno_id);
          setMes.add(k);
          if (String(m.registrado_em).slice(0, 10) === hoje) {
            setHoje.add(k);
            acionadosHojeAlunos.add(String(m.aluno_id));
          }
        }

        // Casos ativos/acionaveis sem NENHUMA tabulacao valida (de qualquer
        // operador). Em lote sobre os alunos da carteira, sem N+1.
        const idsCarteira = listaAtiva.map((a) => String(a.id));
        const acionadosSet = new Set();
        for (let i = 0; i < idsCarteira.length; i += LOTE_IN) {
          const lote = idsCarteira.slice(i, i + LOTE_IN);
          const { data } = await supabase
            .from("aluno_movimentacoes")
            .select("aluno_id")
            .in("aluno_id", lote)
            .in("tipo", TIPOS_ACIONAMENTO);
          for (const m of data || []) if (m.aluno_id) acionadosSet.add(String(m.aluno_id));
        }
        const semPrimeiroLista = idsCarteira.filter((id) => !acionadosSet.has(id));

        const diasUteis = diasUteisTranscorridos(hoje);
        const totalMes = setMes.size;
        const mediaDia = diasUteis > 0 ? totalMes / diasUteis : 0;
        const estimativaDias = mediaDia > 0 ? Math.ceil(listaAtiva.length / mediaDia) : null;

        setAcionadosHojeIds([...acionadosHojeAlunos]);
        setSemPrimeiroIds(semPrimeiroLista);
        setDesempenho({
          ativos: ativosCanonico ?? listaAtiva.length,
          acionadosHoje: setHoje.size,
          acionadosMes: totalMes,
          semPrimeiro: semPrimeiroLista.length,
          diasUteis,
          mediaDia,
          estimativaDias,
        });
      } catch (eDes) {
        console.error("Erro ao calcular desempenho operacional:", eDes);
      }
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
    setAbrirFormInicial(false);
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

  // Troca rapida do operador responsavel direto no modal, sem sair da
  // Minha Carteira. So quem ve tudo (Amanda e Fernanda) tem esse controle.
  async function salvarOperadorModal() {
    if (!alunoModal?.id || !novoOperadorEmailModal) return;

    const novoOperador = OPERADORES.find((op) => op.email === novoOperadorEmailModal);
    if (!novoOperador) return;

    setSalvandoOperador(true);

    const anteriorNome = alunoModal.responsavel_atual_nome || "Sem responsável anterior";
    const anteriorEmail = alunoModal.responsavel_atual_email || null;
    const agora = new Date().toISOString();

    const { error } = await supabase
      .from("alunos")
      .update({
        responsavel_atual_nome: novoOperador.nome,
        responsavel_atual_email: novoOperador.email,
        responsavel_atual_em: agora,
        registrado_por_nome: usuarioLogado?.nome || nomeOperadorPorEmail(email),
        registrado_por_email: email,
        registrado_em: agora,
      })
      .eq("id", alunoModal.id);

    if (error) {
      alert("Erro ao alterar operador responsável: " + error.message);
      setSalvandoOperador(false);
      return;
    }

    await supabase.from("aluno_movimentacoes").insert({
      aluno_id: String(alunoModal.id),
      tipo: "ALTERACAO_OPERADOR",
      descricao: `Operador responsável alterado de ${anteriorNome} para ${novoOperador.nome} direto na Minha Carteira.`,
      registrado_por_nome: usuarioLogado?.nome || nomeOperadorPorEmail(email),
      registrado_por_email: email,
      registrado_em: agora,
      operador_anterior_nome: anteriorNome,
      operador_anterior_email: anteriorEmail,
      operador_novo_nome: novoOperador.nome,
      operador_novo_email: novoOperador.email,
    });

    setEditandoOperador(false);
    setNovoOperadorEmailModal("");
    setSalvandoOperador(false);
    atualizarTudo(alunoModal.id);
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
        registrado_por_email: email,
        registrado_em: agora,
      });
      if (erroMov) throw erroMov;

      // Tabulou como "aguardando baixa" (pago) direto no modal da carteira,
      // sem passar pelo card dedicado "Confirmar pagamento" -- sem isso o
      // aluno ficava com o status de pago mas nunca aparecia na fila de
      // Confirmação de Pagamento. Criamos a solicitação aqui pra garantir
      // que todo "pago" realmente cai na fila de confirmação.
      if (statusNovo === "AGUARDANDO_BAIXA") {
        const { data: pendenteExistente } = await supabase
          .from("solicitacoes_confirmacao_pagamento")
          .select("id")
          .eq("aluno_id", String(a.id))
          .eq("status", "AGUARDANDO_CONFIRMACAO")
          .maybeSingle();

        if (!pendenteExistente) {
          const { error: erroSolicitacao } = await supabase
            .from("solicitacoes_confirmacao_pagamento")
            .insert({
              aluno_id: String(a.id),
              aluno_nome: nomeAluno(a),
              aluno_cpf: a.cpf || null,
              operador_email: email,
              operador_nome: usuarioLogado?.nome || nomeOperadorPorEmail(email),
              motivo: resumoConversa.trim() || "Tabulado como aguardando baixa direto na Minha Carteira.",
              status: "AGUARDANDO_CONFIRMACAO",
            });

          if (erroSolicitacao) {
            console.error("Erro ao criar solicitação de confirmação de pagamento:", erroSolicitacao);
            setFeedback({
              tipo: "erro",
              texto: "Status salvo, mas houve erro ao mandar pra fila de Confirmação de Pagamento: " + erroSolicitacao.message,
            });
          }
        }
      }

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

  // Data de corte (agora - n dias), mesma logica usada nas contagens dos KPIs.
  function corteDias(n) {
    const d = new Date();
    d.setHours(23, 59, 59, 999);
    d.setDate(d.getDate() - n);
    return d.toISOString();
  }

  // Carrega os registros (alunos unicos) que compoem o indicador OPERACIONAL
  // clicado, com a mesma definicao da contagem e respeitando o escopo/permissao
  // do usuario. Cards financeiros nao passam por aqui (abrem o detalhamento).
  async function abrirKpi(kpi) {
    if (filtroKpi === kpi) {
      setFiltroKpi(null);
      setCasosEspeciais(null);
      return;
    }
    setFiltroKpi(kpi);
    setCarregandoEspecial(true);
    try {
      const hoje = hojeLocalBR();
      const base = () => aplicarEscopo(supabase.from("alunos").select(COLUNAS_ALUNO));
      let dados = [];

      if (kpi === "ativos") {
        // Lista operacional ja carregada (exclui quitados/nao-acionaveis).
        dados = casos;
      } else if (kpi === "acionadosHoje") {
        // Alunos que EU tabulei hoje (ids ja calculados no desempenho).
        const ids = acionadosHojeIds;
        if (ids.length) {
          const { data } = await supabase.from("alunos").select(COLUNAS_ALUNO).in("id", ids).limit(5000);
          dados = data || [];
        }
      } else if (kpi === "semPrimeiroAcionamento") {
        // Casos ativos/acionaveis da carteira sem tabulacao valida (ja na lista).
        const idset = new Set(semPrimeiroIds);
        dados = casos.filter((a) => idset.has(String(a.id)));
      } else if (kpi === "retornosHoje") {
        const { data } = await base().eq("data_retorno", hoje).limit(5000);
        dados = (data || []).filter((a) => !ehQuitado(a) && !ehNaoAcionavel(a));
      } else if (kpi === "semAcionamento10") {
        const { data } = await base().lte("data_ultimo_acionamento", corteDias(10)).limit(5000);
        dados = (data || []).filter((a) => !ehQuitado(a) && !ehNaoAcionavel(a));
      } else if (kpi === "proximosPerder") {
        // 9 ou 10 dias sem acionamento (no 11o dia ficam elegiveis ao Receptivo).
        const { data } = await base()
          .lte("data_ultimo_acionamento", corteDias(9))
          .gt("data_ultimo_acionamento", corteDias(11))
          .limit(5000);
        dados = (data || []).filter((a) => !ehQuitado(a) && !ehNaoAcionavel(a));
      } else if (kpi === "retornosAdm") {
        const ids = [...new Set(retornosPendentes.map((r) => r.aluno_id).filter(Boolean))];
        if (ids.length) {
          const { data } = await supabase.from("alunos").select(COLUNAS_ALUNO).in("id", ids).limit(5000);
          dados = data || [];
        }
      } else if (kpi === "acordoAVencer" || kpi === "acordoAtrasado" || kpi === "acordoQuebrado") {
        const chave = kpi === "acordoAVencer" ? "aVencer" : kpi === "acordoAtrasado" ? "atrasado" : "quebrado";
        const ids = acordoBuckets[chave] || [];
        if (ids.length) {
          const { data } = await supabase.from("alunos").select(COLUNAS_ALUNO).in("id", ids).limit(5000);
          dados = data || [];
        }
      }

      setCasosEspeciais(dados);
    } catch (e) {
      console.error("Erro ao carregar registros do indicador:", e);
      setCasosEspeciais([]);
    } finally {
      setCarregandoEspecial(false);
    }
  }

  function onKpiClick(id) {
    if (CARDS_FINANCEIROS.has(id)) {
      // Cards financeiros abrem o detalhamento das parcelas baixadas.
      const titulo =
        id === "valorBaixadoMes"
          ? "Valor baixado no mes"
          : id === "honorariosBaixadoMes"
          ? "Honorarios no mes"
          : "Recebidos no mes";
      setDetalheFinanceiro({ tipo: id, titulo });
      return;
    }
    abrirKpi(id);
  }

  const [saldoView, setSaldoView] = useState({});
  const [valorCarteira, setValorCarteira] = useState(0);
  const normCpf = (c) => String(c || "").replace(/\D/g, "").padStart(11, "0");
  useEffect(() => {
    let ativo = true;
    (async () => {
      const alvo = operadorFiltro && operadorFiltro !== "TODOS" ? operadorFiltro : (veTudo ? null : email);
      let query = supabase.from("vw_carteira_operador").select("cpf_limpo, saldo_mensalidades_aberto, qtd_titulos_abertos");
      if (alvo) query = query.eq("operador_email", alvo);
      const { data } = await query;
      if (!ativo) return;
      const m = {};
      (data || []).forEach((r) => { m[normCpf(r.cpf_limpo)] = { saldo: Number(r.saldo_mensalidades_aberto) || 0, qtd: Number(r.qtd_titulos_abertos) || 0 }; });
      setSaldoView(m);
    })();
    return () => { ativo = false; };
  }, [casos, email, veTudo, operadorFiltro]);
  const saldoDe = (a) => (saldoView[normCpf(a && a.cpf)] ? saldoView[normCpf(a && a.cpf)].saldo : 0);
  const qtdTitulosDe = (a) => (saldoView[normCpf(a && a.cpf)] ? saldoView[normCpf(a && a.cpf)].qtd : 0);
  const listaFiltrada = useMemo(() => {
    // Com um card selecionado, a lista vem dos registros carregados do
    // indicador; sem card, mostra a carteira normal. Busca/status/ordenacao
    // continuam aplicando por cima.
    let l = filtroKpi ? casosEspeciais || [] : casos;
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
    else if (ordenacao === "valor_desc") arr.sort((a, b) => saldoDe(b) - saldoDe(a));
    else if (ordenacao === "valor_asc") arr.sort((a, b) => saldoDe(a) - saldoDe(b));
    return arr;
  }, [casos, casosEspeciais, filtroStatus, busca, filtroKpi, ordenacao, saldoView]);

  // Cards operacionais (abrem a tabela) + financeiros (abrem detalhamento).
  // Todos permanecem visiveis mesmo zerados.
  const kpiCards = [
    { id: "ativos", rot: "Casos ativos • " + formatarMoeda(valorCarteira) + " em aberto", val: kpis.ativos, cor: "#2563eb", icone: "📁" },
    { id: "retornosHoje", rot: "Retornos de hoje", val: kpis.retornosHoje, cor: "#0ea5e9", icone: "🔁" },
    { id: "semAcionamento10", rot: "Sem acionamento ha 10 dias", val: kpis.semAcionamento10, cor: "#f59e0b", icone: "⏳" },
    { id: "proximosPerder", rot: "Proximos de perder a carteira", val: kpis.proximosPerder, cor: "#dc2626", icone: "⚠️", urgente: true },
    { id: "acordoAVencer", rot: "Acordos a vencer", val: kpis.acordoAVencer, cor: "#0891b2", icone: "📄" },
    { id: "acordoAtrasado", rot: "Acordos atrasados", val: kpis.acordoAtrasado, cor: "#f97316", icone: "⏰" },
    { id: "acordoQuebrado", rot: "Acordos quebrados", val: kpis.acordoQuebrado, cor: "#e11d48", icone: "💥" },
    { id: "retornosAdm", rot: "Retornos do ADM", val: retornosPendentes.length, cor: "#c2410c", icone: "📌" },
    { id: "valorBaixadoMes", rot: "Valor baixado no mes", val: formatarMoeda(kpis.valorBaixadoMes), cor: "#16a34a", financeiro: true, icone: "✅" },
    { id: "recebidosMes", rot: "Recebidos no mes", val: kpis.recebidosMes, cor: "#16a34a", financeiro: true, icone: "💰" },
    { id: "honorariosBaixadoMes", rot: "Honorarios no mes", val: formatarMoeda(kpis.honorariosBaixadoMes), cor: "#0d9488", financeiro: true, icone: "🧾" },
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
          {/* Reutiliza o fluxo existente de inclusao de aluno (mesmo componente
              do Dashboard/Fila Operacional). Ao concluir, recarrega a carteira
              e os indicadores. */}
          {aba === "carteira" && <CadastroNovoAluno onSucesso={() => carregar()} />}
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

          {desempenho && (
            <div style={S.desWrap}>
              <div style={S.desHeader}>Meu desempenho operacional</div>
              <div style={S.desRow}>
                <button type="button" style={{ ...S.desItem, ...(filtroKpi === "ativos" ? S.desItemAtivo : {}) }} onClick={() => onKpiClick("ativos")} title="Ver casos ativos">
                  <span style={S.desNum}>{desempenho.ativos}</span>
                  <span style={S.desRot}>Casos ativos</span>
                </button>
                <button type="button" style={{ ...S.desItem, ...(filtroKpi === "acionadosHoje" ? S.desItemAtivo : {}) }} onClick={() => onKpiClick("acionadosHoje")} title="CPFs que voce tabulou hoje">
                  <span style={S.desNum}>{desempenho.acionadosHoje}</span>
                  <span style={S.desRot}>CPFs acionados hoje</span>
                </button>
                <button type="button" style={{ ...S.desItem, ...(filtroKpi === "semPrimeiroAcionamento" ? S.desItemAtivo : {}) }} onClick={() => onKpiClick("semPrimeiroAcionamento")} title="Casos ativos sem primeira tabulacao">
                  <span style={S.desNum}>{desempenho.semPrimeiro}</span>
                  <span style={S.desRot}>Sem 1o acionamento</span>
                </button>
                <div style={S.desItemInfo}>
                  <span style={S.desNum}>{desempenho.mediaDia.toFixed(1)}</span>
                  <span style={S.desRot}>Media/dia · {desempenho.acionadosMes} no mes / {desempenho.diasUteis} dias uteis</span>
                </div>
                <div style={S.desItemInfo}>
                  <span style={S.desNum}>{desempenho.estimativaDias ?? "-"}</span>
                  <span style={S.desRot}>Dias úteis estimados</span>
                </div>
              </div>
            </div>
          )}

          {veTudo && (
            <>
              <VisaoGeralCarteira email={emailEscopo()} />
              <VisaoGestao360 />
            </>
          )}
          <div style={S.kpiGrid} className="pc-kpis">
            {kpiCards.map((k) => {
              // Todos os cards sao clicaveis e abrem a listagem filtrada.
              const filtravel = true;
              const ativoK = filtroKpi === k.id;
              return (
                <div
                  key={k.id}
                  onClick={filtravel ? () => onKpiClick(k.id) : undefined}
                  style={{
                    ...S.kpiCard,
                    cursor: filtravel ? "pointer" : "default",
                    boxShadow: ativoK ? `0 0 0 2px ${k.cor}, ${S.kpiCard.boxShadow}` : S.kpiCard.boxShadow,
                    borderColor: ativoK ? k.cor : S.kpiCard.border,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ ...S.kpiIconChip, background: k.cor + "1a", color: k.cor }}>{k.icone}</span>
                    {k.urgente && k.val > 0 && <span style={S.kpiPulso} />}
                  </div>
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
                <option value="valor_desc">Maior valor primeiro</option>
                <option value="valor_asc">Menor valor primeiro</option>
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
                    const fa = finAlunos[String(a.id)];
                    const temDet = !!(fa && fa.temDetalhe);
                    const fallback = Number(a.valor_em_aberto || 0);
                    const respCaso = a.responsavel_atual_nome || nomeOperadorPorEmail(a.responsavel_atual_email);
                    const respAcordo = fa && fa.acordoResponsavel ? nomeOperadorPorEmail(fa.acordoResponsavel) : null;
                    const corTotal = temDet
                      ? (fa.temAtraso ? "#b42318" : fa.temAVencer ? "#b54708" : "#101828")
                      : "#101828";
                    return (
                      <tr key={a.id} style={S.tr} onClick={() => abrirModal(a)}>
                        <td style={S.td}>
                          <div style={S.nomeCel}>{nomeAluno(a)}</div>
                          <div style={S.subCel}>
                            {[a.telefone, a.unidade, a.curso].filter(Boolean).join(" · ") || "-"}
                          </div>
                          {String(a.status_atual) === "JURIDICO" && (
                            <div style={{ ...S.subCel, color: "#7c3aed", fontWeight: 600 }}>
                              {a.processo_numero && String(a.processo_numero).trim()
                                ? `Jurídico · Processo nº ${a.processo_numero}`
                                : "Jurídico · Processo não informado"}
                            </div>
                          )}
                        </td>
                        <td style={S.td}>{a.cpf || "-"}</td>
                        <td style={S.td}>
                          <span style={S.badgeSituacao}>{situacaoLabel(a)}</span>
                        </td>
                        <td style={S.td}>{formatarData(a.data_ultimo_acionamento || a.ultimo_contato)}</td>
                        <td style={S.td}>{formatarData(a.data_retorno)}</td>
                        <td style={S.tdValor}>
                          {temDet ? (
                            <div style={S.emAbertoBox}>
                              <div style={{ ...S.emAbertoTotal, color: corTotal }}>
                                Em aberto: {formatarMoeda(fa.total)}
                              </div>
                              <div style={S.emAbertoSub}>Mensalidades: {formatarMoeda(fa.mensalidades)}</div>
                            <div style={S.emAbertoSub}>Mensalidades (originais): {formatarMoeda(saldoDe(a))}</div>
                            <div style={S.emAbertoSub}>Titulos em aberto: {qtdTitulosDe(a)}</div>
                              <div style={S.emAbertoSub}>Acordos: {formatarMoeda(fa.acordos)}</div>
                              <div style={S.emAbertoSub}>Responsavel: {respCaso || "-"}</div>
                              {respAcordo && respAcordo !== respCaso && (
                                <div style={S.emAbertoSub}>Acordo: {respAcordo}</div>
                              )}
                            </div>
                          ) : fallback > 0 ? (
                            <div style={S.emAbertoBox}>
                              <div style={{ ...S.emAbertoTotal, color: "#101828" }}>
                                Em aberto: {formatarMoeda(fallback)}
                              </div>
                              <div style={S.emAbertoSub}>estimado (sem detalhamento)</div>
                              <div style={S.emAbertoSub}>Responsavel: {respCaso || "-"}</div>
                            </div>
                          ) : (
                            <div style={S.emAbertoBox}>
                              <div style={{ ...S.emAbertoTotal, color: "#98a2b3" }}>Valor nao informado</div>
                              <div style={S.tagRevisar}>Revisar valor</div>
                              <div style={S.emAbertoSub}>Responsavel: {respCaso || "-"}</div>
                            </div>
                          )}
                        </td>
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
                        {carregando || carregandoEspecial ? "Carregando..." : "Nenhum caso encontrado"}
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
                    {!editandoOperador ? (
                      <div style={S.infoBox}>
                        <div style={S.infoRot}>Operador responsavel</div>
                        <div style={S.infoVal}>
                          {alunoModal.responsavel_atual_nome || "-"}
                          {veTudo && (
                            <button
                              type="button"
                              style={S.btnEditarOperador}
                              onClick={() => {
                                setNovoOperadorEmailModal(alunoModal.responsavel_atual_email || "");
                                setEditandoOperador(true);
                              }}
                            >
                              ✏️
                            </button>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div style={S.infoBox}>
                        <div style={S.infoRot}>Operador responsavel</div>
                        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                          <select
                            style={S.selectOperadorFicha}
                            value={novoOperadorEmailModal}
                            onChange={(e) => setNovoOperadorEmailModal(e.target.value)}
                          >
                            <option value="">Selecione</option>
                            {OPERADORES.map((op) => (
                              <option key={op.email} value={op.email}>
                                {op.nome}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            style={S.btnSalvarOperador}
                            disabled={salvandoOperador || !novoOperadorEmailModal}
                            onClick={salvarOperadorModal}
                          >
                            {salvandoOperador ? "..." : "Salvar"}
                          </button>
                          <button
                            type="button"
                            style={S.btnCancelarOperador}
                            onClick={() => {
                              setEditandoOperador(false);
                              setNovoOperadorEmailModal("");
                            }}
                          >
                            Cancelar
                          </button>
                        </div>
                      </div>
                    )}
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
                    <button style={S.btnAcaoInline} onClick={() => { const abrir = acaoInline !== "link"; setAcaoInline(abrir ? "link" : null); setAbrirFormInicial(abrir); iniciarRetorno(); }}>🔗 Solicitar link</button>
                    <button style={S.btnAcaoInline} onClick={() => { const abrir = acaoInline !== "termo"; setAcaoInline(abrir ? "termo" : null); setAbrirFormInicial(abrir); iniciarRetorno(); }}>📄 Solicitar termo</button>
                    <button style={S.btnAcaoInline} onClick={() => { const abrir = acaoInline !== "financeiro"; setAcaoInline(abrir ? "financeiro" : null); setAbrirFormInicial(false); iniciarRetorno(); }}>💰 Enviar ao financeiro</button>
                    <button style={S.btnAcaoInline} onClick={() => { const abrir = acaoInline !== "pagamento"; setAcaoInline(abrir ? "pagamento" : null); setAbrirFormInicial(false); iniciarRetorno(); }}>🧾 Informar pagamento</button>
                  </div>

                  {acaoInline === "link" && (
                    <div style={S.blocoInline}>
                      <LinksPagamentoAluno aluno={alunoModal} usuarioLogado={usuarioLogado} onAtualizar={() => atualizarTudo(alunoModal.id)} abrirFormularioInicial={abrirFormInicial} />
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

      {/* Detalhamento financeiro (parcelas baixadas no mes) — soma bate com o card */}
      {detalheFinanceiro && (
        <div style={S.overlay} onClick={() => setDetalheFinanceiro(null)}>
          <div style={{ ...S.modal, maxWidth: 980 }} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <div style={S.modalHeader}>
              <div style={{ minWidth: 0 }}>
                <h2 style={S.modalNome}>{detalheFinanceiro.titulo}</h2>
                <div style={S.modalSub}>
                  {detalheParcelas.length} baixa(s) no mes ·{" "}
                  {detalheFinanceiro.tipo === "recebidosMes"
                    ? `${detalheParcelas.length} parcela(s)`
                    : detalheFinanceiro.tipo === "honorariosBaixadoMes"
                    ? `Total honorarios: ${formatarMoeda(detalheParcelas.reduce((s, r) => s + r.honorarios, 0))}`
                    : `Total baixado: ${formatarMoeda(detalheParcelas.reduce((s, r) => s + r.valor, 0))}`}
                </div>
              </div>
              <button style={S.btnFechar} onClick={() => setDetalheFinanceiro(null)} aria-label="Fechar">✕</button>
            </div>
            <div style={S.modalBody}>
              <div style={S.tabelaWrap}>
                <table style={S.tabela}>
                  <thead>
                    <tr>
                      <th style={S.th}>Aluno</th>
                      <th style={S.th}>CPF</th>
                      <th style={S.th}>Acordo</th>
                      <th style={S.th}>Parcela</th>
                      <th style={S.th}>Data da baixa</th>
                      <th style={S.thNum}>Valor baixado</th>
                      <th style={S.thNum}>Honorarios</th>
                      <th style={S.th}>Operador</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detalheParcelas.map((r, i) => (
                      <tr key={`${r.acordo_id}-${r.parcela}-${i}`} style={S.tr}>
                        <td style={S.td}>{r.aluno_nome || "-"}</td>
                        <td style={S.td}>{r.cpf || "-"}</td>
                        <td style={S.td}>{String(r.acordo_id || "-").slice(0, 8)}</td>
                        <td style={S.td}>{r.parcela ?? "-"}</td>
                        <td style={S.td}>{formatarData(r.data_baixa)}</td>
                        <td style={S.tdNum}>{formatarMoeda(r.valor)}</td>
                        <td style={S.tdNum}>{formatarMoeda(r.honorarios)}</td>
                        <td style={S.td}>{nomeOperadorPorEmail(r.operador)}</td>
                      </tr>
                    ))}
                    {detalheParcelas.length === 0 && (
                      <tr><td style={S.vazio} colSpan={8}>Nenhuma baixa no mes.</td></tr>
                    )}
                  </tbody>
                  {detalheParcelas.length > 0 && (
                    <tfoot>
                      <tr>
                        <td style={S.tdTotal} colSpan={5}>Total</td>
                        <td style={S.tdNumTotal}>{formatarMoeda(detalheParcelas.reduce((s, r) => s + r.valor, 0))}</td>
                        <td style={S.tdNumTotal}>{formatarMoeda(detalheParcelas.reduce((s, r) => s + r.honorarios, 0))}</td>
                        <td style={S.td}></td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
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
  .pc-root { --pc-brand: #0f9d6b; --pc-ink: #101828; }
  .pc-root tbody tr { transition: background 0.15s ease; }
  .pc-root tbody tr:hover { background: #f6fbf9; }
  .pc-root .pc-kpis > div { transition: box-shadow 0.16s ease, transform 0.16s ease, border-color 0.16s ease; }
  .pc-root .pc-kpis > div:hover { box-shadow: 0 10px 24px rgba(16,24,40,0.10); transform: translateY(-2px); }
  .pc-root ::placeholder { color: #a6adba; }
  @keyframes pc-pulso {
    0% { box-shadow: 0 0 0 0 rgba(220,38,38,0.45); }
    70% { box-shadow: 0 0 0 7px rgba(220,38,38,0); }
    100% { box-shadow: 0 0 0 0 rgba(220,38,38,0); }
  }
  @media (max-width: 640px) {
    .pc-kpis { grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)) !important; }
    .pc-root { padding: 16px !important; }
  }
`;

const COR_BORDA = "#e3e7ee";
const COR_BORDA_SUAVE = "#edf0f5";
const FONTE_TITULO = "'Sora', 'Inter', system-ui, sans-serif";
const FONTE_BASE = "'Inter', system-ui, -apple-system, sans-serif";
const SOMBRA_CARD = "0 1px 2px rgba(16,24,40,0.04), 0 1px 3px rgba(16,24,40,0.05)";
const SOMBRA_ELEVADA = "0 20px 48px rgba(16,24,40,0.16), 0 4px 12px rgba(16,24,40,0.06)";

const S = {
  pagina: { padding: "30px 32px 44px", fontFamily: FONTE_BASE, background: "#f4f6fa", minHeight: "100%", color: "#344054" },
  cabecalho: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, marginBottom: 22, flexWrap: "wrap" },
  titulo: { margin: 0, marginBottom: 3, color: "#0d1321", fontSize: 26, fontWeight: 800, letterSpacing: "-0.03em", fontFamily: FONTE_TITULO },
  subtitulo: { margin: 0, color: "#8a93a3", fontSize: 13.5 },
  userChip: { display: "flex", flexDirection: "column", alignItems: "flex-end", lineHeight: 1.2, padding: "6px 14px", background: "#fff", border: `1px solid ${COR_BORDA}`, borderRadius: 12, boxShadow: SOMBRA_CARD },
  userNome: { fontWeight: 700, color: "#101828", fontSize: 13 },
  userRole: { fontSize: 10, color: "#0f9d6b", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" },
  select: { padding: "9px 12px", borderRadius: 10, border: `1px solid ${COR_BORDA}`, background: "#fff", fontSize: 13, color: "#344054", fontWeight: 500 },
  btnAtualizar: { background: "#fff", color: "#475569", border: `1px solid ${COR_BORDA}`, padding: "9px 16px", borderRadius: 10, cursor: "pointer", fontWeight: 700, fontSize: 13 },
  erro: { color: "#b91c1c", fontWeight: 600, fontSize: 13 },

  abas: { display: "flex", gap: 4, marginBottom: 20, borderBottom: `1px solid ${COR_BORDA}` },
  aba: { background: "transparent", border: "1px solid transparent", borderBottom: "none", borderTopLeftRadius: 10, borderTopRightRadius: 10, padding: "9px 18px", fontSize: 13.5, fontWeight: 700, color: "#98a2b3", cursor: "pointer", marginBottom: -1 },
  abaAtiva: { background: "#fff", color: "#0d1321", border: `1px solid ${COR_BORDA}`, borderBottom: "1px solid #fff" },

  receptivoWrap: { display: "flex", flexDirection: "column", gap: 12, maxWidth: 720 },
  receptivoInfo: { background: "#fff", border: `1px solid ${COR_BORDA}`, borderRadius: 14, padding: "12px 16px", fontSize: 12.5, color: "#8a93a3", lineHeight: 1.55 },

  desWrap: { background: "linear-gradient(180deg, #ffffff 0%, #fbfdfc 100%)", border: `1px solid ${COR_BORDA_SUAVE}`, borderRadius: 16, padding: "16px 18px", marginBottom: 18, boxShadow: SOMBRA_CARD },
  desHeader: { fontSize: 11.5, fontWeight: 800, color: "#667085", textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 12 },
  desRow: { display: "flex", flexWrap: "wrap", gap: 10, alignItems: "stretch" },
  desItem: { display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 3, background: "#f8faf9", border: `1px solid ${COR_BORDA_SUAVE}`, borderRadius: 12, padding: "11px 16px", cursor: "pointer", minWidth: 128, textAlign: "left", transition: "border-color 0.14s ease, background 0.14s ease" },
  desItemAtivo: { borderColor: "#0f9d6b", background: "#ecfaf3", boxShadow: "0 0 0 2px rgba(15,157,107,0.14)" },
  desItemInfo: { display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 3, background: "transparent", borderRadius: 12, padding: "11px 16px", minWidth: 128 },
  desNum: { fontSize: 22, fontWeight: 800, color: "#0d1321", lineHeight: 1, fontFamily: FONTE_TITULO },
  desRot: { fontSize: 11, color: "#98a2b3", fontWeight: 600 },
  kpiGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(172px, 1fr))", gap: 14, marginBottom: 22 },
  kpiCard: { background: "#fff", borderRadius: 16, padding: "16px 18px", border: `1px solid ${COR_BORDA_SUAVE}`, boxShadow: SOMBRA_CARD, cursor: "pointer" },
  kpiIconChip: { display: "inline-flex", alignItems: "center", justifyContent: "center", width: 32, height: 32, borderRadius: 10, fontSize: 15, marginBottom: 12 },
  kpiPulso: { width: 9, height: 9, borderRadius: "50%", background: "#dc2626", animation: "pc-pulso 1.8s ease-in-out infinite", marginTop: 2 },
  kpiRot: { margin: "0 0 6px 0", fontSize: 11.5, color: "#8a93a3", fontWeight: 600, lineHeight: 1.35 },
  kpiVal: { margin: 0, fontSize: 25, fontWeight: 800, letterSpacing: "-0.02em", fontFamily: FONTE_TITULO },

  painelTabela: { background: "#fff", borderRadius: 18, padding: 20, border: `1px solid ${COR_BORDA_SUAVE}`, boxShadow: SOMBRA_CARD },
  filtros: { display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 18, alignItems: "center" },
  inputBusca: { flex: 1, minWidth: 220, padding: "11px 14px", borderRadius: 12, border: `1px solid ${COR_BORDA}`, fontSize: 13, color: "#344054", background: "#f8fafc" },
  chipFiltro: { display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", background: "#e9f9f1", color: "#0f9d6b", border: "1px solid #bdeed4", borderRadius: 999, padding: "6px 13px", fontSize: 11.5, fontWeight: 700 },
  tabelaWrap: { overflowX: "auto", borderRadius: 12 },
  tabela: { width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 13 },
  th: { textAlign: "left", padding: "11px 12px", color: "#8a93a3", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", background: "#f8fafc", borderBottom: `1px solid ${COR_BORDA}`, whiteSpace: "nowrap" },
  thNum: { textAlign: "right", padding: "11px 12px", color: "#8a93a3", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", background: "#f8fafc", borderBottom: `1px solid ${COR_BORDA}`, whiteSpace: "nowrap" },
  tr: { cursor: "pointer", borderBottom: `1px solid ${COR_BORDA_SUAVE}` },
  td: { padding: "13px 12px", color: "#475569", verticalAlign: "middle" },
  tdNum: { padding: "11px 10px", color: "#1e293b", textAlign: "right", whiteSpace: "nowrap", fontWeight: 600 },
  tdTotal: { padding: "11px 10px", color: "#1e293b", fontWeight: 700, borderTop: `2px solid ${COR_BORDA}`, textAlign: "right" },
  tdNumTotal: { padding: "11px 10px", color: "#0f9d6b", textAlign: "right", whiteSpace: "nowrap", fontWeight: 800, borderTop: `2px solid ${COR_BORDA}` },
  nomeCel: { fontWeight: 700, color: "#101828", fontSize: 13.5 },
  subCel: { fontSize: 11.5, color: "#98a2b3", marginTop: 2 },
  tdValor: { padding: "11px 10px", textAlign: "right", whiteSpace: "nowrap", verticalAlign: "middle" },
  emAbertoBox: { display: "inline-flex", flexDirection: "column", alignItems: "flex-end", gap: 1 },
  emAbertoTotal: { fontWeight: 800, fontSize: 13.5, fontFamily: FONTE_TITULO },
  emAbertoSub: { fontSize: 11, color: "#98a2b3" },
  tagRevisar: { fontSize: 10.5, fontWeight: 700, color: "#b54708", background: "#fff4e6", border: "1px solid #f5c98a", borderRadius: 6, padding: "1px 7px", marginTop: 2 },
  badgeSituacao: { display: "inline-block", padding: "4px 10px", borderRadius: 999, background: "#eef1ff", color: "#4f46e5", fontSize: 10.5, fontWeight: 700, whiteSpace: "nowrap", letterSpacing: "0.01em" },
  badgeStatus: { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, fontWeight: 700, whiteSpace: "nowrap" },
  bolinha: { width: 7, height: 7, borderRadius: "50%", display: "inline-block" },
  vazio: { padding: 28, textAlign: "center", color: "#98a2b3" },
  rodapeTabela: { margin: "12px 0 0 0", fontSize: 11.5, color: "#98a2b3" },

  // Modal
  overlay: { position: "fixed", inset: 0, background: "rgba(13,19,33,0.55)", backdropFilter: "blur(2px)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "40px 16px", zIndex: 1000, overflowY: "auto" },
  modal: { width: "100%", maxWidth: 880, background: "#fff", borderRadius: 20, boxShadow: SOMBRA_ELEVADA, overflow: "hidden" },
  modalHeader: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, padding: "22px 24px", borderBottom: `1px solid ${COR_BORDA_SUAVE}`, background: "linear-gradient(180deg, #fbfdfc 0%, #ffffff 100%)" },
  modalNome: { margin: 0, fontSize: 19, fontWeight: 800, color: "#101828", fontFamily: FONTE_TITULO },
  modalSub: { fontSize: 12.5, color: "#8a93a3", marginTop: 5 },
  btnFechar: { background: "#f1f5f9", border: "none", borderRadius: 10, width: 34, height: 34, cursor: "pointer", color: "#475569", fontSize: 14, flexShrink: 0 },
  modalAbas: { display: "flex", gap: 4, padding: "0 22px", borderBottom: `1px solid ${COR_BORDA_SUAVE}`, flexWrap: "wrap" },
  modalAba: { background: "transparent", border: "none", borderBottom: "2px solid transparent", padding: "11px 13px", fontSize: 13, fontWeight: 700, color: "#98a2b3", cursor: "pointer" },
  modalAbaAtiva: { color: "#0f9d6b", borderBottom: "2px solid #0f9d6b" },
  feedbackOk: { margin: "14px 22px 0", padding: "9px 13px", borderRadius: 10, background: "#eafaf1", color: "#0f7a4f", fontSize: 12.5, fontWeight: 700 },
  feedbackErro: { margin: "14px 22px 0", padding: "9px 13px", borderRadius: 10, background: "#fef2f2", color: "#b91c1c", fontSize: 12.5, fontWeight: 700 },
  modalBody: { padding: 22, maxHeight: "62vh", overflowY: "auto" },
  secao: { display: "flex", flexDirection: "column", gap: 12 },
  gridInfo: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 },
  infoBox: { background: "#f9fafc", border: `1px solid ${COR_BORDA_SUAVE}`, borderRadius: 12, padding: "9px 13px" },
  infoRot: { fontSize: 11, color: "#98a2b3", marginBottom: 3, fontWeight: 600 },
  infoVal: { fontSize: 13.5, color: "#101828", fontWeight: 700 },
  btnEditarOperador: { marginLeft: 6, border: "none", background: "transparent", cursor: "pointer", fontSize: 13 },
  selectOperadorFicha: { padding: "5px 7px", borderRadius: 8, border: "1px solid #cbd5e1", fontSize: 12, maxWidth: 160 },
  btnSalvarOperador: { border: "none", background: "#0f9d6b", color: "#fff", borderRadius: 8, padding: "5px 9px", fontSize: 12, fontWeight: 700, cursor: "pointer" },
  btnCancelarOperador: { border: "1px solid #cbd5e1", background: "#fff", color: "#475569", borderRadius: 8, padding: "5px 9px", fontSize: 12, cursor: "pointer" },
  label: { fontSize: 12, fontWeight: 700, color: "#475569", marginTop: 4 },
  input: { padding: "10px 12px", borderRadius: 10, border: `1px solid ${COR_BORDA}`, fontSize: 13, background: "#fff", color: "#344054" },
  textarea: { padding: "10px 12px", borderRadius: 10, border: `1px solid ${COR_BORDA}`, fontSize: 13, minHeight: 70, resize: "vertical", fontFamily: "inherit", background: "#fff", color: "#344054" },
  proximaAcao: { fontSize: 12.5, color: "#667085", background: "#f9fafc", border: `1px solid ${COR_BORDA_SUAVE}`, borderRadius: 10, padding: "9px 13px" },
  acoesLinha: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 },
  btnPrimario: { background: "#0f9d6b", color: "#fff", border: "none", borderRadius: 10, padding: "10px 18px", fontSize: 13, fontWeight: 700, cursor: "pointer" },
  btnSecundario: { background: "#eef2f6", color: "#475569", border: "none", borderRadius: 10, padding: "10px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer" },
  timeline: { display: "flex", flexDirection: "column", gap: 11 },
  itemHist: { borderLeft: `2px solid ${COR_BORDA}`, paddingLeft: 13 },
  histData: { fontSize: 11, color: "#98a2b3" },
  histDesc: { fontSize: 13, color: "#344054" },
  histStatus: { fontSize: 11.5, color: "#6366f1", fontWeight: 700 },
  histAutor: { fontSize: 11, color: "#98a2b3" },

  // Retorno do ADM — bloco na Tabulacao
  retornoBox: { background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 14, padding: 13, display: "flex", flexDirection: "column", gap: 4 },
  retornoTop: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  retornoBadge: { fontSize: 12.5, fontWeight: 700, color: "#c2410c" },
  retornoStatus: { fontSize: 11, fontWeight: 700, color: "#9a3412", background: "#ffedd5", borderRadius: 999, padding: "2px 8px" },
  retornoLinha: { fontSize: 12.5, color: "#7c2d12" },
  retornoDica: { fontSize: 11.5, color: "#9a3412", marginTop: 2, fontStyle: "italic" },
  acoesInlineTitulo: { fontSize: 12, fontWeight: 700, color: "#475569", marginTop: 6 },
  acoesInlineBotoes: { display: "flex", flexWrap: "wrap", gap: 8 },
  btnAcaoInline: { background: "#eef2f6", color: "#344054", border: `1px solid ${COR_BORDA}`, borderRadius: 10, padding: "8px 13px", fontSize: 12.5, fontWeight: 700, cursor: "pointer" },
  blocoInline: { border: `1px solid ${COR_BORDA_SUAVE}`, borderRadius: 12, padding: 4, background: "#fbfcfe" },

  // Retorno do ADM — bloco na Carteira
  retornoCarteira: { background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 14, padding: "11px 15px", marginBottom: 16 },
  retornoCarteiraTopo: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 9 },
  retornoCarteiraBadge: { fontSize: 13, fontWeight: 700, color: "#c2410c" },
  retornoCarteiraCont: { fontSize: 12, fontWeight: 700, color: "#9a3412", background: "#ffedd5", borderRadius: 999, padding: "2px 10px" },
  retornoCarteiraLista: { display: "flex", flexDirection: "column", gap: 6 },
  retornoCarteiraItem: { display: "flex", alignItems: "center", gap: 10, cursor: "pointer", background: "#fff", border: `1px solid ${COR_BORDA_SUAVE}`, borderRadius: 10, padding: "8px 11px" },
  retornoCarteiraNome: { flex: 1, fontWeight: 700, color: "#101828", fontSize: 13 },
  retornoCarteiraTag: { fontSize: 11, fontWeight: 700, color: "#c2410c", background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 6, padding: "2px 8px" },
  retornoCarteiraStatus: { fontSize: 11, color: "#98a2b3" },
};
