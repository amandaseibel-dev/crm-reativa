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
    .replace(/[̀-ͯ]/g, "")
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
    // Ao trocar de aluno, fecha qualquer formulario inline aberto.
    setMostrarContato(false);
    setMostrarRetorno(false);
    if (!a?.id) return;
    const { data: mov } = await supabase
      .from("aluno_movimentacoes")
      .select("id,tipo,descricao,status_novo,registrado_por_nome,registrado_em")
      .eq("aluno_id", String(a.id))
      .order("registrado_em", { ascending: false })
      .limit(8);
    setHistorico(mov || []);

    const cpf = a.cpf;
    if (cpf) {
      const { data: acs } = await supabase
        .from("acordos")
        .select("honorarios_valor")
        .eq("cpf", cpf);
      const total = (acs || []).reduce((s, x) => s + (Number(x.honorarios_valor) || 0), 0);
      setHonorarios(total || 0);
    }
  }

  // Recarrega o aluno selecionado (campos + historico) depois de salvar uma
  // acao inline, mantendo o mesmo aluno selecionado na tela.
  async function recarregarSelecionado(id) {
    if (!id) return;
    const { data: row } = await supabase
      .from("alunos")
      .select(COLUNAS_ALUNO)
      .eq("id", id)
      .single();
    if (row) setSelecionado(row);
    const { data: mov } = await supabase
      .from("aluno_movimentacoes")
      .select("id,tipo,descricao,status_novo,registrado_por_nome,registrado_em")
      .eq("aluno_id", String(id))
      .order("registrado_em", { ascending: false })
      .limit(8);
    setHistorico(mov || []);
  }

  // Registrar contato: grava movimentacao + marca acionamento no aluno, sem
  // abrir a ficha. Reaproveita as MESMAS tabelas ja usadas pela ficha
  // (aluno_movimentacoes e alunos); nao toca em RPC, fidelizacao ou vinculo.
  async function salvarContato() {
    const a = selecionado;
    if (!a?.id || salvandoAcao) return;
    setSalvandoAcao(true);
    try {
      const agora = new Date().toISOString();
      const statusAtual = a.status_atual || a.status_jornada || null;
      await supabase
        .from("alunos")
        .update({ data_ultimo_acionamento: agora, ultimo_contato: agora })
        .eq("id", a.id);
      await supabase.from("aluno_movimentacoes").insert({
        aluno_id: String(a.id),
        tipo: "CONTATO",
        descricao: contatoTexto.trim() || "Contato registrado pela Carteira.",
        status_anterior: statusAtual,
        status_novo: statusAtual,
        registrado_por_nome: nomeOperadorPorEmail(email),
        registrado_em: agora,
      });
      setContatoTexto("");
      setMostrarContato(false);
      await carregar();
      await recarregarSelecionado(a.id);
    } catch (e) {
      console.error("Erro ao registrar contato:", e);
      setErro("Nao foi possivel registrar o contato. " + (e?.message || ""));
    } finally {
      setSalvandoAcao(false);
    }
  }

  // Agendar retorno: grava data/hora de retorno no aluno + movimentacao,
  // tambem sem abrir a ficha.
  async function salvarRetorno() {
    const a = selecionado;
    if (!a?.id || salvandoAcao || !retornoData) return;
    setSalvandoAcao(true);
    try {
      const agora = new Date().toISOString();
      const statusAtual = a.status_atual || a.status_jornada || null;
      await supabase
        .from("alunos")
        .update({
          data_retorno: retornoData,
          hora_retorno: retornoHora || null,
          data_ultimo_acionamento: agora,
          ultimo_contato: agora,
        })
        .eq("id", a.id);
      await supabase.from("aluno_movimentacoes").insert({
        aluno_id: String(a.id),
        tipo: "AGENDAMENTO",
        descricao:
          (retornoTexto.trim() ? retornoTexto.trim() + " " : "") +
          `Retorno agendado para ${formatarData(retornoData)}${retornoHora ? " " + retornoHora : ""}.`,
        status_anterior: statusAtual,
        status_novo: statusAtual,
        registrado_por_nome: nomeOperadorPorEmail(email),
        registrado_em: agora,
      });
      setRetornoData("");
      setRetornoHora("");
      setRetornoTexto("");
      setMostrarRetorno(false);
      await carregar();
      await recarregarSelecionado(a.id);
    } catch (e) {
      console.error("Erro ao agendar retorno:", e);
      setErro("Nao foi possivel agendar o retorno. " + (e?.message || ""));
    } finally {
      setSalvandoAcao(false);
    }
  }

  function abrirFicha(a) {
    if (!a?.id) return;
    navigate(`/aluno?alunoId=${encodeURIComponent(a.id)}&origem=painel`);
  }

  async function abrirEspecial(kpi) {
    if (filtroKpi === kpi) {
      setFiltroKpi(null);
      setCasosEspeciais(null);
      return;
    }
    setFiltroKpi(kpi);
    setSelecionado(null);
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
    { id: "ativos", rot: "Casos ativos", val: kpis.ativos, cor: "#2563eb", icone: "📁" },
    { id: "semContato", rot: "Sem contato +10 dias", val: kpis.semContato, cor: "#f59e0b", icone: "📵" },
    { id: "criticos", rot: "Criticos (9-10 dias)", val: kpis.criticos, cor: "#dc2626", icone: "⚠️" },
    { id: "retornosHoje", rot: "Retornos hoje", val: kpis.retornosHoje, cor: "#0ea5e9", icone: "📅" },
    { id: "acordosQuebrados", rot: "Acordos quebrados", val: kpis.acordosQuebrados, cor: "#e11d48", icone: "💔" },
    { id: "recebidosMes", rot: "Recebidos este mes", val: kpis.recebidosMes, cor: "#16a34a", icone: "💰" },
    { id: "valorBaixadoMes", rot: "Valor baixado este mes", val: formatarMoeda(kpis.valorBaixadoMes), cor: "#16a34a", icone: "💵" },
    { id: "honorariosBaixadoMes", rot: "Honorarios este mes", val: formatarMoeda(kpis.honorariosBaixadoMes), cor: "#0d9488", icone: "🏷️" },
    { id: "quitados", rot: "Quitados", val: kpis.quitados, cor: "#16a34a", icone: "✅" },
    { id: "acordosFechados", rot: "Acordos fechados", val: kpis.acordosFechados, cor: "#0891b2", icone: "🤝" },
    { id: "linksPagos", rot: "Links pagos", val: kpis.linksPagos, cor: "#16a34a", icone: "🔗" },
    { id: "termosAgPgto", rot: "Termos aguard. pgto", val: kpis.termosAgPgto, cor: "#7c3aed", icone: "📄" },
  ];

  // Aba Receptivo: apenas reaproveita os componentes existentes. Container
  // claro e neutro; os widgets mantem seu proprio estilo interno. Ao receber
  // leads, recarrega a carteira para exibir os novos casos (aoReceber).
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
              {veTudo
                ? "Visao completa da base de casos."
                : `Carteira de ${nomeOperadorPorEmail(email)}.`}
            </p>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <div style={S.userChip}>
              <span style={S.userNome}>{nomeOperadorPorEmail(email)}</span>
              <span style={S.userRole}>{veTudo ? "Gestao" : "Operador"}</span>
            </div>
            {veTudo && aba === "carteira" && (
              <select
                style={S.select}
                value={operadorFiltro}
                onChange={(e) => setOperadorFiltro(e.target.value)}
              >
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

        {/* Abas: Carteira (padrao) e Receptivo (widgets existentes) */}
        <div style={S.abas} role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={aba === "carteira"}
            onClick={() => setAba("carteira")}
            style={{ ...S.aba, ...(aba === "carteira" ? S.abaAtiva : {}) }}
          >
            🗂️ Carteira
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={aba === "receptivo"}
            onClick={() => setAba("receptivo")}
            style={{ ...S.aba, ...(aba === "receptivo" ? S.abaAtiva : {}) }}
          >
            📞 Receptivo
          </button>
        </div>

        {erro && <p style={S.erro}>{erro}</p>}

        {aba === "receptivo" ? (
          painelReceptivo
        ) : (
          <>
        {/* KPIs */}
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
                  borderTop: `3px solid ${k.cor}`,
                  cursor: filtravel ? "pointer" : "default",
                  boxShadow: ativoK ? `0 0 0 2px ${k.cor}` : S.kpiCard.boxShadow,
                }}
              >
                <span style={S.kpiIcone}>{k.icone}</span>
                <p style={S.kpiRot}>{k.rot}</p>
                <p style={{ ...S.kpiVal, color: k.cor }}>{k.val}</p>
              </div>
            );
          })}
        </div>

        {/* Corpo: tabela + painel do aluno */}
        <div style={S.corpo} className="pc-corpo">
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
            </div>

            <h2 style={S.tituloSecao}>Casos da carteira</h2>

            {filtroKpi && (
              <div style={S.chipFiltro} onClick={() => { setFiltroKpi(null); setCasosEspeciais(null); }}>
                Mostrando: {kpiCards.find((k) => k.id === filtroKpi)?.rot} ✕
              </div>
            )}

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
                    const ativo = selecionado?.id === a.id;
                    return (
                      <tr
                        key={a.id}
                        style={{ ...S.tr, ...(ativo ? S.trAtivo : {}) }}
                        onClick={() => abrirFicha(a)}
                        onMouseEnter={() => selecionar(a)}
                      >
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
              Mostrando {listaFiltrada.length} de {casos.length} casos carregados.
            </p>
          </div>

          {/* Painel do aluno */}
          <aside style={S.painelAluno}>
            {!selecionado ? (
              <div style={S.semSelecao}>Selecione um caso para ver os detalhes e agir.</div>
            ) : (
              <>
                <div style={S.alunoTopo}>
                  <div style={{ minWidth: 0 }}>
                    <h3 style={S.alunoNome}>{nomeAluno(selecionado)}</h3>
                    {selecionado.telefone && (
                      <div style={S.alunoContato}>📞 {selecionado.telefone}</div>
                    )}
                  </div>
                  <span style={S.badgeSituacao}>{situacaoLabel(selecionado)}</span>
                </div>

                <div style={S.linhaInfo}>
                  <span style={S.rotInfo}>Operador responsavel</span>
                  <span style={S.valInfo}>{selecionado.responsavel_atual_nome || "-"}</span>
                </div>
                <div style={S.linhaInfo}>
                  <span style={S.rotInfo}>Ultimo contato</span>
                  <span style={S.valInfo}>{formatarData(selecionado.data_ultimo_acionamento || selecionado.ultimo_contato)}</span>
                </div>
                <div style={S.linhaInfo}>
                  <span style={S.rotInfo}>Proximo contato</span>
                  <span style={S.valInfo}>
                    {formatarData(selecionado.data_retorno)}
                    {selecionado.hora_retorno ? ` ${selecionado.hora_retorno}` : ""}
                  </span>
                </div>
                <div style={S.linhaInfo}>
                  <span style={S.rotInfo}>Valor em aberto</span>
                  <span style={S.valInfo}>{formatarMoeda(selecionado.valor_em_aberto)}</span>
                </div>
                <div style={S.linhaInfo}>
                  <span style={S.rotInfo}>Honorarios</span>
                  <span style={S.valInfo}>{honorarios === null ? "..." : formatarMoeda(honorarios)}</span>
                </div>
                <div style={S.linhaInfo}>
                  <span style={S.rotInfo}>Status</span>
                  <span style={{ ...S.valInfo, color: statusPrazo(selecionado).cor, fontWeight: "bold" }}>
                    {statusPrazo(selecionado).label}
                  </span>
                </div>

                <div style={S.acoesGrid}>
                  <button
                    style={{ ...S.btnAcao, ...S.acaoAzul }}
                    onClick={() => {
                      setMostrarRetorno(false);
                      setMostrarContato((v) => !v);
                    }}
                  >
                    📞 Registrar contato
                  </button>
                  <button
                    style={{ ...S.btnAcao, ...S.acaoRoxoClaro }}
                    onClick={() => {
                      setMostrarContato(false);
                      setMostrarRetorno((v) => !v);
                    }}
                  >
                    📅 Agendar retorno
                  </button>
                  <button style={{ ...S.btnAcao, ...S.acaoLaranja }} onClick={() => abrirFicha(selecionado)}>
                    💵 Registrar proposta
                  </button>
                  <button style={{ ...S.btnAcao, ...S.acaoVerde }} onClick={() => abrirFicha(selecionado)}>
                    ✔️ Fechar acordo
                  </button>
                  {veTudo ? (
                    <>
                      <button style={{ ...S.btnAcao, ...S.acaoRoxo }} onClick={() => abrirFicha(selecionado)}>
                        ⚖️ Juridico
                      </button>
                      <button style={{ ...S.btnAcao, ...S.acaoVermelho }} onClick={() => abrirFicha(selecionado)}>
                        ✖️ Cancelado
                      </button>
                    </>
                  ) : (
                    <button
                      style={{ ...S.btnAcao, ...S.acaoRoxo, gridColumn: "1 / -1" }}
                      onClick={() => abrirFicha(selecionado)}
                    >
                      ↗️ Encaminhar p/ Amanda
                    </button>
                  )}
                </div>
                {mostrarContato && (
                  <div style={S.formInline}>
                    <div style={S.formTitulo}>📞 Registrar contato</div>
                    <textarea
                      style={S.formTextarea}
                      placeholder="O que foi tratado no contato? (opcional)"
                      value={contatoTexto}
                      onChange={(e) => setContatoTexto(e.target.value)}
                    />
                    <div style={S.formBotoes}>
                      <button style={S.formCancelar} onClick={() => setMostrarContato(false)} disabled={salvandoAcao}>
                        Cancelar
                      </button>
                      <button style={S.formSalvar} onClick={salvarContato} disabled={salvandoAcao}>
                        {salvandoAcao ? "Salvando..." : "Salvar contato"}
                      </button>
                    </div>
                  </div>
                )}

                {mostrarRetorno && (
                  <div style={S.formInline}>
                    <div style={S.formTitulo}>📅 Agendar retorno</div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <input
                        type="date"
                        style={{ ...S.formInput, flex: 1 }}
                        value={retornoData}
                        onChange={(e) => setRetornoData(e.target.value)}
                      />
                      <input
                        type="time"
                        style={{ ...S.formInput, width: 110 }}
                        value={retornoHora}
                        onChange={(e) => setRetornoHora(e.target.value)}
                      />
                    </div>
                    <textarea
                      style={S.formTextarea}
                      placeholder="Observacao do retorno (opcional)"
                      value={retornoTexto}
                      onChange={(e) => setRetornoTexto(e.target.value)}
                    />
                    <div style={S.formBotoes}>
                      <button style={S.formCancelar} onClick={() => setMostrarRetorno(false)} disabled={salvandoAcao}>
                        Cancelar
                      </button>
                      <button
                        style={{ ...S.formSalvar, opacity: retornoData ? 1 : 0.6 }}
                        onClick={salvarRetorno}
                        disabled={salvandoAcao || !retornoData}
                      >
                        {salvandoAcao ? "Salvando..." : "Salvar retorno"}
                      </button>
                    </div>
                  </div>
                )}

                <button style={S.btnFicha} onClick={() => abrirFicha(selecionado)}>
                  Abrir ficha completa do aluno →
                </button>

                <h4 style={S.tituloHist}>Historico de contatos</h4>
                <div style={S.historico}>
                  {historico.length === 0 && <p style={S.subCel}>Sem movimentacoes registradas.</p>}
                  {historico.map((h) => (
                    <div key={h.id} style={S.itemHist}>
                      <div style={S.histData}>{formatarDataHora(h.registrado_em)}</div>
                      <div style={S.histDesc}>{h.descricao || h.tipo || h.status_novo || "Movimentacao"}</div>
                      {h.registrado_por_nome && <div style={S.histAutor}>por {h.registrado_por_nome}</div>}
                    </div>
                  ))}
                </div>
              </>
            )}
          </aside>
        </div>
          </>
        )}
      </div>
  );
  return embedded ? conteudo : <main className="content">{conteudo}</main>;
}

// CSS somente para responsividade (media queries nao existem em estilo
// inline). Nao altera comportamento -- so reflui o grid em telas menores.
const CSS_RESPONSIVO = `
  .pc-root { --pc-borda: #eef2f6; }
  @media (max-width: 1024px) {
    .pc-corpo { grid-template-columns: 1fr !important; }
    .pc-root aside { position: static !important; }
  }
  @media (max-width: 640px) {
    .pc-kpis { grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)) !important; }
    .pc-root { padding: 16px !important; }
  }
`;

// Paleta clara e neutra: fundo levemente cinza, cartoes brancos, bordas
// finas (#eef2f6/#e6eaf0), sombras discretas e badges pequenos. Nenhuma
// mudanca de estrutura -- so aparencia.
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

  // Abas: destaque discreto, linha inferior suave.
  abas: { display: "flex", gap: 4, marginBottom: 18, borderBottom: `1px solid ${COR_BORDA}` },
  aba: {
    background: "transparent",
    border: "1px solid transparent",
    borderBottom: "none",
    borderTopLeftRadius: 8,
    borderTopRightRadius: 8,
    padding: "8px 16px",
    fontSize: 13.5,
    fontWeight: 600,
    color: "#94a3b8",
    cursor: "pointer",
    marginBottom: -1,
  },
  abaAtiva: {
    background: "#fff",
    color: "#1e293b",
    border: `1px solid ${COR_BORDA}`,
    borderBottom: "1px solid #fff",
  },

  // Aba Receptivo
  receptivoWrap: { display: "flex", flexDirection: "column", gap: 12, maxWidth: 720 },
  receptivoInfo: {
    background: "#fff",
    border: `1px solid ${COR_BORDA}`,
    borderRadius: 12,
    padding: "10px 14px",
    fontSize: 12.5,
    color: "#94a3b8",
    lineHeight: 1.5,
  },

  kpiGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(134px, 1fr))", gap: 10, marginBottom: 18 },
  kpiCard: { background: "#fff", borderRadius: 12, padding: "11px 13px", border: `1px solid ${COR_BORDA_SUAVE}`, boxShadow: "0 1px 2px rgba(15,23,42,0.04)" },
  kpiIcone: { fontSize: 15, opacity: 0.9 },
  kpiRot: { margin: "5px 0 3px 0", fontSize: 11.5, color: "#94a3b8", fontWeight: 500 },
  kpiVal: { margin: 0, fontSize: 21, fontWeight: 700, letterSpacing: "-0.01em" },

  corpo: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) 340px", gap: 16, alignItems: "start" },
  painelTabela: { background: "#fff", borderRadius: 14, padding: 16, border: `1px solid ${COR_BORDA_SUAVE}`, boxShadow: "0 1px 2px rgba(15,23,42,0.04)" },
  filtros: { display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 },
  inputBusca: { flex: 1, minWidth: 200, padding: "9px 12px", borderRadius: 8, border: `1px solid ${COR_BORDA}`, fontSize: 13, color: "#334155" },
  chipFiltro: { display: "inline-block", cursor: "pointer", background: "#f1f5f9", color: "#475569", border: `1px solid ${COR_BORDA}`, borderRadius: 999, padding: "3px 11px", fontSize: 11.5, fontWeight: 600, marginBottom: 10 },
  tituloSecao: { margin: "2px 0 12px 0", color: "#1e293b", fontSize: 14, fontWeight: 600 },
  tabelaWrap: { overflowX: "auto" },
  tabela: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", padding: "9px 8px", color: "#94a3b8", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.03em", borderBottom: `1px solid ${COR_BORDA}`, whiteSpace: "nowrap" },
  thNum: { textAlign: "right", padding: "9px 8px", color: "#94a3b8", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.03em", borderBottom: `1px solid ${COR_BORDA}`, whiteSpace: "nowrap" },
  tr: { cursor: "pointer", borderBottom: `1px solid ${COR_BORDA_SUAVE}` },
  trAtivo: { background: "#f5f8ff", boxShadow: "inset 2px 0 0 #6366f1" },
  td: { padding: "10px 8px", color: "#475569", verticalAlign: "middle" },
  tdNum: { padding: "10px 8px", color: "#1e293b", textAlign: "right", whiteSpace: "nowrap", fontWeight: 600 },
  nomeCel: { fontWeight: 600, color: "#1e293b" },
  subCel: { fontSize: 11.5, color: "#a3adba" },
  badgeSituacao: { display: "inline-block", padding: "2px 8px", borderRadius: 6, background: "#eef2ff", color: "#4f46e5", fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" },
  badgeStatus: { display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, fontWeight: 600, whiteSpace: "nowrap" },
  bolinha: { width: 7, height: 7, borderRadius: "50%", display: "inline-block" },
  vazio: { padding: 24, textAlign: "center", color: "#a3adba" },
  rodapeTabela: { margin: "10px 0 0 0", fontSize: 11.5, color: "#a3adba" },

  painelAluno: { background: "#fff", borderRadius: 14, padding: 16, border: `1px solid ${COR_BORDA_SUAVE}`, boxShadow: "0 1px 2px rgba(15,23,42,0.04)", position: "sticky", top: 16 },
  semSelecao: { color: "#a3adba", fontSize: 13, padding: "20px 4px", textAlign: "center" },
  alunoTopo: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 14, borderBottom: `1px solid ${COR_BORDA_SUAVE}`, paddingBottom: 12 },
  alunoNome: { margin: 0, fontSize: 16, color: "#1e293b", fontWeight: 600 },
  alunoContato: { fontSize: 12, color: "#94a3b8", marginTop: 3 },
  linhaInfo: { display: "flex", justifyContent: "space-between", gap: 10, padding: "5px 0", fontSize: 13 },
  rotInfo: { color: "#94a3b8" },
  valInfo: { color: "#1e293b", fontWeight: 600, textAlign: "right" },
  acoesGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7, margin: "14px 0 10px 0" },
  btnAcao: { border: "none", borderRadius: 8, padding: "9px 8px", fontSize: 12, fontWeight: 600, cursor: "pointer" },
  acaoAzul: { background: "#eff4ff", color: "#2563eb" },
  acaoRoxoClaro: { background: "#f4f0ff", color: "#7c3aed" },
  acaoLaranja: { background: "#fff5eb", color: "#d97706" },
  acaoVerde: { background: "#eefbf3", color: "#16a34a" },
  acaoRoxo: { background: "#f2effe", color: "#6d28d9" },
  acaoVermelho: { background: "#fef2f2", color: "#dc2626" },
  btnFicha: { width: "100%", background: "#1e293b", color: "#fff", border: "none", borderRadius: 8, padding: "10px", fontWeight: 600, fontSize: 13, cursor: "pointer", marginBottom: 14 },

  formInline: { background: "#f9fafc", border: `1px solid ${COR_BORDA}`, borderRadius: 10, padding: 12, margin: "0 0 12px 0", display: "flex", flexDirection: "column", gap: 8 },
  formTitulo: { fontSize: 12.5, fontWeight: 600, color: "#1e293b" },
  formInput: { padding: "8px 10px", borderRadius: 8, border: `1px solid ${COR_BORDA}`, fontSize: 13, background: "#fff", color: "#334155" },
  formTextarea: { padding: "8px 10px", borderRadius: 8, border: `1px solid ${COR_BORDA}`, fontSize: 13, minHeight: 58, resize: "vertical", fontFamily: "inherit", background: "#fff", color: "#334155" },
  formBotoes: { display: "flex", justifyContent: "flex-end", gap: 8 },
  formCancelar: { background: "#eef2f6", color: "#475569", border: "none", borderRadius: 8, padding: "8px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer" },
  formSalvar: { background: "#2563eb", color: "#fff", border: "none", borderRadius: 8, padding: "8px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer" },
  tituloHist: { margin: "6px 0 8px 0", fontSize: 13, color: "#1e293b", fontWeight: 600 },
  historico: { display: "flex", flexDirection: "column", gap: 8, maxHeight: 260, overflowY: "auto" },
  itemHist: { borderLeft: `2px solid ${COR_BORDA}`, paddingLeft: 10 },
  histData: { fontSize: 11, color: "#a3adba" },
  histDesc: { fontSize: 12.5, color: "#475569" },
  histAutor: { fontSize: 11, color: "#a3adba" },
};
