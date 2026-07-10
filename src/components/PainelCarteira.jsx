import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../services/supabase";
import { podeVerTudo, nomeOperadorPorEmail } from "../utils/operadores";
import FilaReceptivo from "./FilaReceptivo";
import ReceberLeads from "./ReceberLeads";

/*
  PainelCarteira
  --------------
  Novo painel no formato "Minha Carteira": KPIs no topo, tabela de casos e
  painel do aluno com acoes e historico. Um so componente, com escopo por
  perfil: gestao (podeVerTudo) enxerga a base completa e pode filtrar por
  operador; operador enxerga apenas a propria carteira.

  Aba "Receptivo" (opcao A): apenas incorpora, dentro deste painel, os
  componentes JA existentes FilaReceptivo (rodizio de operadores online:
  heartbeat, pausa, marcar atendimento, saida da fila) e ReceberLeads
  (RPC receber_leads, que so distribui casos SEM responsavel). Nenhuma
  fila de alunos nova, nenhuma tabela/RPC/trigger novo, nenhum vinculo
  paralelo operador<->aluno. A fidelizacao de 10 dias e a distribuicao
  continuam integralmente no servidor, intocadas. Ao receber leads, a
  carteira e recarregada para exibir os novos casos.

  Regra de prazo (dias desde o ultimo contato / acionamento):
    0 a 7  -> Normal (dentro do prazo)
    8      -> Atencao
    9 a 10 -> Critico
    11+    -> Passivel de perda (o operador pode perder o caso)
  Por enquanto so sinaliza; nada e removido automaticamente.

  As acoes (registrar contato, agendar retorno, fechar acordo, juridico,
  cancelar) abrem a ficha existente (/aluno?alunoId=...), que ja executa
  todos esses fluxos. Assim reaproveitamos o que ja funciona.
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
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
  return texto.includes("QUITAD") || texto.includes("QUITACAO");
}

// Dias desde o ultimo contato/acionamento. Retorna null se nunca acionado.
function diasSemContato(a) {
  const base = a?.data_ultimo_acionamento || a?.ultimo_contato || a?.responsavel_atual_em || null;
  if (!base) return null;
  const d = new Date(base);
  if (Number.isNaN(d.getTime())) return null;
  const ms = Date.now() - d.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

// Situacao operacional (badge azul/claro) a partir do status_atual/jornada.
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
  LINK_ENVIADO_AO_ALUNO: "Link enviado",
  AGUARDANDO_COMPROVANTE: "Aguardando comprovante",
  AGUARDANDO_BAIXA: "Aguardando baixa",
  BAIXA_REALIZADA: "Pago",
  ACORDO_FECHADO: "Acordo fechado",
  TERMO_ENVIADO_ALUNO: "Termo enviado",
  TERMO_ENVIADO_ADM: "Termo no ADM",
  JURIDICO: "Juridico",
  CANCELAMENTO_COBRANCA: "Cancelado",
  SUSPENSAO_COBRANCA: "Suspenso",
};

function situacaoLabel(a) {
  const s = a?.status_atual || a?.status_jornada || "";
  if (MAPA_SITUACAO[s]) return MAPA_SITUACAO[s];
  if (!s || s === "Novo caso") return "Sem contato";
  return s;
}

// Status de saude do caso (badge com bolinha), pela regra de prazo.
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


// Predicado: o caso pertence ao KPI clicado? (filtros aplicaveis sobre a
// lista ja carregada). Alguns KPIs -- quitados, recebidos, quebrados --
// nao sao isolaveis da lista, entao nao filtram.
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

export default function PainelCarteira({ embedded = false }) {
  const navigate = useNavigate();
  const [email, setEmail] = useState(null);
  const [veTudo, setVeTudo] = useState(false);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");

  // Aba ativa do painel: "carteira" (padrao) ou "receptivo".
  const [aba, setAba] = useState("carteira");

  const [operadorFiltro, setOperadorFiltro] = useState("TODOS"); // so gestao usa
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
  const [selecionado, setSelecionado] = useState(null);
  const [historico, setHistorico] = useState([]);
  const [honorarios, setHonorarios] = useState(null);

  // Formularios inline da propria Carteira (nao abrem a ficha do aluno).
  const [mostrarContato, setMostrarContato] = useState(false);
  const [contatoTexto, setContatoTexto] = useState("");
  const [mostrarRetorno, setMostrarRetorno] = useState(false);
  const [retornoData, setRetornoData] = useState("");
  const [retornoHora, setRetornoHora] = useState("");
  const [retornoTexto, setRetornoTexto] = useState("");
  const [salvandoAcao, setSalvandoAcao] = useState(false);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getUser();
      const mail = data?.user?.email || null;
      setEmail(mail);
      setVeTudo(podeVerTudo(mail));
    })();
  }, []);

  useEffect(() => {
    if (email === null) return;
    carregar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email, veTudo, operadorFiltro]);

  // Objeto minimo esperado por FilaReceptivo (usa .email) e ReceberLeads
  // (usa .email e .nome). Sem consultas novas: o nome vem do util existente.
  const usuarioLogado = useMemo(
    () => (email ? { email, nome: nomeOperadorPorEmail(email) } : null),
    [email]
  );

  // email de escopo: operador -> ele mesmo; gestao -> filtro escolhido (ou todos)
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

      // Tabela de casos (limite de exibicao)
      const colunas = COLUNAS_ALUNO;
      // Carrega a carteira inteira, paginando (Supabase limita 1000 por
      // requisicao). Para um operador (ou gestao filtrando um operador)
      // puxa tudo; para "todos os operadores" da gestao aplica um teto
      // pra nao travar o navegador com a base inteira.
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

      // KPIs por contagem (head:true), escopados
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

      // Acordos quebrados e recebidos no mes: a base de acordos e pequena,
      // entao carregamos e calculamos no cliente.
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

      // Produtividade (calculada sobre a carteira inteira ja carregada,
      // pelo status do caso -- assim fica escopada por operador).
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

  async function selecionar(a) {
    if (a?.id && selecionado?.id === a.id) return;
    setSelecionado(a);
    setHistorico([]);
    setHonorarios(null);
    // Ao trocar de aluno, fecha qualquer formulario
