import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../services/supabase";
import { analiticasSuspensas } from "../config/modoContencao";
import EmailAlunoUnificado from "./EmailAlunoUnificado";
import { podeVerTudo, nomeOperadorPorEmail } from "../utils/operadores";
import FilaReceptivo from "./FilaReceptivo";
import jsPDF from "jspdf";
import ReceberLeads from "./ReceberLeads";
import LinksPagamentoAluno from "./LinksPagamentoAluno";
import FinalizacaoTermo from "./FinalizacaoTermo";
import EnvioFinanceiro from "./EnvioFinanceiro";
import FinanceiroAluno from "./FinanceiroAluno";
import DadosAcademicos from "./DadosAcademicos";
import ConfirmarPagamento from "./ConfirmarPagamento";
import CadastroNovoAluno from "./CadastroNovoAluno";
import PainelDesfazer from "./PainelDesfazer";
import { listarDesfazer, desfazerAcao, explicarBloqueio } from "../utils/desfazer";
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
  "LEMBRETE_PARCELA",
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

// Auto-retorno por status (prazos definidos com a gestao). Retorna uma data
// "YYYY-MM-DD" sugerida a partir do status tabulado, ou null quando o retorno
// deve ser manual. O operador sempre pode sobrescrever no formulario.
function adicionarDiasUteisData(base, n) {
  const d = new Date(base);
  let add = 0;
  while (add < n) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) add += 1;
  }
  return d;
}

function retornoAutomaticoDeStatus(statusNovo) {
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  const uteis = {
    MENSAGEM_ENVIADA: 2,
    SOLICITADO_LINK: 1,
    AGUARDANDO_LINK: 1,
    LINK_PRONTO_PARA_ENVIO: 1,
    TERMO_ENVIADO_ALUNO: 2,
    NAO_LOCALIZADO: 1,
    AGUARDANDO_COMPROVANTE: 3,
    ACORDO_FECHADO: 2,
  };
  if (!(statusNovo in uteis)) return null; // RETORNAR_DEPOIS/NEGOCIACAO_24H = manual
  const d = adicionarDiasUteisData(hoje, uteis[statusNovo]);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// Diferenca em dias entre "hoje" e uma data "YYYY-MM-DD" (alvo - hoje).
function diasParaData(hojeStr, alvoStr) {
  const a = new Date(`${String(hojeStr).slice(0, 10)}T00:00:00`);
  const b = new Date(`${String(alvoStr).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

// Sugestao de proxima acao para o card, cruzando retorno agendado + vencimento
// do boleto. Retorna {emoji,texto,bg,cor} ou null.
function sugestaoDoCaso(a, menorVencimento, hojeStr) {
  const ret = a && a.data_retorno ? String(a.data_retorno).slice(0, 10) : null;
  if (ret) {
    const d = diasParaData(hojeStr, ret);
    if (d === 0) return { emoji: "↩️", texto: "Retornar hoje", bg: "#155e75", cor: "#cffafe" };
    if (d !== null && d < 0) return { emoji: "↩️", texto: `Retorno atrasado ${Math.abs(d)}d`, bg: "#7c2d12", cor: "#fed7aa" };
  }
  if (menorVencimento) {
    const d = diasParaData(hojeStr, menorVencimento);
    if (d !== null) {
      if (d < 0) return { emoji: "🔴", texto: `Vencido há ${Math.abs(d)}d — cobrar`, bg: "#7f1d1d", cor: "#fecaca" };
      if (d === 0) return { emoji: "⏰", texto: "Vence hoje — enviar lembrete", bg: "#78350f", cor: "#fde68a" };
      if (d === 1) return { emoji: "📅", texto: "Vence amanhã — enviar lembrete", bg: "#713f12", cor: "#fef08a" };
      if (d <= 3) return { emoji: "📩", texto: `Vence em ${d}d — enviar lembrete`, bg: "#1e3a5f", cor: "#bfdbfe" };
    }
  }
  return null;
}

function formatarMoeda(valor) {
  const n = Number(valor) || 0;
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

// Remove acentos pra busca funcionar independente de como a pessoa digitou
// (ex: "Joao" precisa achar "João").
function semAcento(texto) {
  return String(texto || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
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

// Azul claro da linha ja trabalhada no dia (e o tom do hover em cima dela).
const COR_TRABALHADO_HOJE = "#e0f2fe";
const COR_TRABALHADO_HOJE_HOVER = "#bae6fd";

// Data local (fuso do operador) de um timestamp. Nao da pra fatiar o ISO
// direto: uma tabulacao das 22h vira o dia seguinte em UTC e a linha
// deixaria de contar como trabalhada hoje.
function dataLocalDe(valor) {
  if (!valor) return null;
  const bruto = String(valor);
  if (/^\d{4}-\d{2}-\d{2}$/.test(bruto)) return bruto;
  const d = new Date(bruto);
  if (Number.isNaN(d.getTime())) return bruto.slice(0, 10) || null;
  const ano = d.getFullYear();
  const mes = String(d.getMonth() + 1).padStart(2, "0");
  const dia = String(d.getDate()).padStart(2, "0");
  return `${ano}-${mes}-${dia}`;
}

// Caso ja acionado hoje. So marca visualmente -- nao altera fila, filtro nem
// ordenacao: o caso continua saindo de "sem acionamento" como sempre.
function trabalhadoHoje(a) {
  return dataLocalDe(a?.data_ultimo_acionamento) === hojeLocalBR();
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

// Rotulo amigavel da origem da quitacao (arquivo de quitados, so gestao).
function labelOrigemQuitacao(c) {
  const o = String(c?.origem_quitacao || "").toUpperCase();
  const sf = String(c?.status_financeiro || "").toUpperCase();
  const chave = o || sf;
  if (chave.includes("PLANILHA")) return "Planilha";
  if (chave.includes("LINK")) return "Link de pagamento";
  if (chave.includes("AUTOMAT")) return "Automatica (saldo zero)";
  if (chave.includes("CONFIRMACAO") || chave.includes("MANUAL")) return "Manual / confirmacao";
  return chave ? chave.charAt(0) + chave.slice(1).toLowerCase().replace(/_/g, " ") : "-";
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
  LEMBRETE_PARCELA: "Lembrete de parcela feito",
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
  // Mesma premissa do statusPrazo: baixa realizada que ainda carrega saldo
  // vencido e pagamento PARCIAL -- a tabulacao nao pode se ler como "Pago".
  if (s === "BAIXA_REALIZADA" && !semSaldoVencido(a)) return "Pago parcial";
  if (MAPA_SITUACAO[s]) return MAPA_SITUACAO[s];
  if (!s || s === "Novo caso") return "Sem contato";
  return s;
}

// Tabulacao (desfecho do acionamento) canonica do aluno -- mesma precedencia
// usada no resto da tela: status_atual > status_jornada > status_acionamento.
function tabulacaoDoAluno(a) {
  return a?.status_atual || a?.status_jornada || a?.status_acionamento || "";
}

// Opcoes do filtro por tabulacao na Minha Carteira. Pedido operacional: dar aos
// operadores controle de RETORNO dos termos e links enviados -- por isso esse
// grupo vem primeiro. Nenhum status novo: todos ja existem em STATUS_FINALIZACAO.
const OPCOES_TABULACAO = [
  {
    grupo: "Termos e links (retorno)",
    itens: [
      "SOLICITADO_LINK",
      "LINK_PRONTO_PARA_ENVIO",
      "LINK_ENVIADO_AO_ALUNO",
      "AGUARDANDO_COMPROVANTE",
      "AGUARDANDO_BAIXA",
      "BAIXA_REALIZADA",
      "TERMO_ENVIADO_ALUNO",
      "TERMO_ENVIADO_ADM",
      "TERMO_RECEBIDO_LIBERADO",
      "TERMO_REJEITADO",
    ],
  },
  {
    grupo: "Financeiro",
    itens: [
      "Aguardando envio financeiro",
      "Enviado ao financeiro",
      "Retorno do financeiro recebido",
    ],
  },
  {
    grupo: "Acionamento",
    itens: [
      "CONTATAR",
      "MENSAGEM_ENVIADA",
      "EM_ATENDIMENTO",
      "ALUNO_EM_NEGOCIACAO_24H",
      "RETORNAR_DEPOIS",
      "SEM_RETORNO",
      "NAO_LOCALIZADO",
      "ACORDO_FECHADO",
      "CANCELAMENTO_COBRANCA",
      "SUSPENSAO_COBRANCA",
      "JURIDICO",
    ],
  },
];

// Selo discreto na coluna Nome para o operador bater o olho e ver quem tem
// termo/link enviado pendente de retorno, sem abrir a ficha.
function seloTermoLink(a) {
  const s = tabulacaoDoAluno(a);
  if (["TERMO_ENVIADO_ALUNO", "TERMO_ENVIADO_ADM", "TERMO_RECEBIDO_LIBERADO"].includes(s))
    return { emoji: "📄", texto: MAPA_SITUACAO[s] || "Termo enviado", bg: "#eef2ff", cor: "#4338ca" };
  if (["SOLICITADO_LINK", "LINK_PRONTO_PARA_ENVIO", "LINK_ENVIADO_AO_ALUNO"].includes(s))
    return { emoji: "🔗", texto: MAPA_SITUACAO[s] || "Link enviado", bg: "#ecfeff", cor: "#0e7490" };
  if (["Aguardando envio financeiro", "Enviado ao financeiro"].includes(s))
    return { emoji: "💰", texto: "No financeiro — aguardando retorno", bg: "#fff7ed", cor: "#b45309" };
  if (s === "Retorno do financeiro recebido")
    return { emoji: "📩", texto: "Retorno do financeiro recebido", bg: "#ecfdf5", cor: "#047857" };
  return null;
}

function statusPrazo(a) {
  const sit = a?.status_atual || "";
  if (sit === "JURIDICO") return { label: "Juridico", cor: "#7c3aed" };
  if (["ACORDO_FECHADO", "AGUARDANDO_BAIXA", "AGUARDANDO_COMPROVANTE", "SOLICITADO_LINK", "LINK_ENVIADO_AO_ALUNO"].includes(sit))
    return { label: "Aguardando pgto", cor: "#2563eb" };
  // PREMISSA DO SISTEMA: "Pago" so existe com SALDO ZERADO. Caso com baixa
  // realizada que ainda carrega saldo vencido e pagamento PARCIAL -- nao pode
  // se apresentar como pago, senao a operadora para de cobrar o que sobrou
  // (a confirmacao de pagamento so quita quando o saldo total zera; sobrando
  // saldo, o caso segue com o operador de proposito).
  if (sit === "BAIXA_REALIZADA")
    return semSaldoVencido(a)
      ? { label: "Pago", cor: "#16a34a" }
      : { label: "Pago parcial", cor: "#f97316" };
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
      return critAlta(a);
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
  "id,nome,nome_aluno,cpf,telefone,email,valor_em_aberto,status_atual,status_jornada,status_acionamento,nivel_criticidade,situacao_operacional,saldo_vencido,saldo_total,proxima_acao,data_ultimo_acionamento,ultimo_contato,data_retorno,hora_retorno,retorno_confirmado_em,responsavel_atual_nome,responsavel_atual_email,observacao,unidade,curso,processo_numero";

// Rotulo amigavel da situacao operacional (recalcular_situacao_aluno).
const SITUACAO_OPERACIONAL_LABEL = {
  ACORDO_EM_DIA: { texto: "Acordo em dia", bg: "rgba(29,158,117,0.18)", cor: "#6fd7b6" },
  COBRANCA_VENCIDA: { texto: "Saldo vencido", bg: "rgba(220,38,38,0.18)", cor: "#fca5a5" },
  AGUARDANDO_CONFIRMACAO: { texto: "Aguardando confirmação", bg: "rgba(37,99,235,0.18)", cor: "#93c5fd" },
  QUITADO_AGUARDANDO_BAIXA: { texto: "Quitado — concluir baixa", bg: "rgba(37,99,235,0.18)", cor: "#93c5fd" },
  QUITADO: { texto: "Quitado", bg: "rgba(29,158,117,0.18)", cor: "#6fd7b6" },
  SEM_PENDENCIA: { texto: "Sem pendência", bg: "rgba(100,116,139,0.18)", cor: "#cbd5e1" },
};

// Criticidade CANONICA do backend (recalcular_situacao_aluno): combina saldo
// vencido, dias sem acionamento, valor, termo pendente e fim de mes. E a fonte
// da verdade -- NAO reinventar por dias sem contato. Ordem de severidade usada
// para priorizar "o que acionar".
const CRITICIDADE_LABEL = {
  CRITICO: { texto: "Crítico", bg: "rgba(220,38,38,0.20)", cor: "#fca5a5", rank: 0 },
  URGENTE: { texto: "Urgente", bg: "rgba(234,88,12,0.20)", cor: "#fdba74", rank: 1 },
  ATENCAO: { texto: "Atenção", bg: "rgba(245,158,11,0.18)", cor: "#fcd34d", rank: 2 },
  NORMAL: { texto: "Normal", bg: "rgba(100,116,139,0.16)", cor: "#cbd5e1", rank: 3 },
};

function critCanon(a) {
  const n = String(a?.nivel_criticidade || "").toUpperCase();
  return CRITICIDADE_LABEL[n] ? n : "NORMAL";
}
function critRank(a) {
  return CRITICIDADE_LABEL[critCanon(a)].rank;
}
function critAlta(a) {
  const n = critCanon(a);
  return n === "CRITICO" || n === "URGENTE";
}

// ---- Fila inteligente ----
// Dias decorridos desde o ultimo acionamento (ou ultimo contato). null = nunca
// acionado. Ancora da fidelizacao de 10 dias (data_ultimo_acionamento + 10).
function diasSemAcionar(a, hojeStr) {
  const base = a?.data_ultimo_acionamento || a?.ultimo_contato || null;
  if (!base) return null;
  const d = diasParaData(String(base).slice(0, 10), hojeStr);
  return d === null ? null : Math.max(0, d);
}
// Selo que explica a posicao na fila inteligente (urgencia de fidelizacao).
// Retorna {emoji,texto,bg,cor} ou null. Retorno devido ja e coberto por
// sugestaoDoCaso, entao aqui focamos em "nunca acionado" e "perto de soltar".
// Quem esta dentro do prazo (menos de 8 dias) nao recebe selo -- o alerta so
// aparece a 2 dias de soltar, junto com a subida na fila.
function seloFila(a, hojeStr) {
  const ret = a?.data_retorno ? String(a.data_retorno).slice(0, 10) : null;
  if (ret && ret <= hojeStr) return null; // retorno devido: sugestaoDoCaso ja mostra
  const d = diasSemAcionar(a, hojeStr);
  if (d === null) return { emoji: "🆕", texto: "Nunca acionado", bg: "#1e3a8a", cor: "#bfdbfe" };
  const faltam = 10 - d; // fidelizacao solta o caso em +10 dias
  if (d >= 11) return { emoji: "🚨", texto: `Perdendo o caso (${d}d)`, bg: "#7f1d1d", cor: "#fecaca" };
  if (faltam <= 2) return { emoji: "⏳", texto: `Solta em ${Math.max(0, faltam)}d`, bg: "#7f1d1d", cor: "#fecaca" };
  return null;
}

// Selo financeiro (Critico/Urgente) e decidido pelo SALDO VENCIDO CANONICO -- nao
// apenas pela situacao operacional nem pelo nivel_criticidade armazenado. Regra:
//   - saldo vencido > 0  -> mostra o selo (inclusive AGUARDANDO_CONFIRMACAO com vencido);
//   - saldo vencido = 0  -> nao mostra selo vermelho vindo de valor antigo armazenado.
// Fonte primaria: alunos.saldo_vencido, persistido por recalcular_situacao_aluno
// (ja aplica supersessao de mensalidades). Fallback canonico quando ainda nao
// populado: a situacao operacional so vale como "sem vencido" nos estados que o
// backend so atribui com saldo vencido = 0. QUITADO/baixa nunca mostram selo.
const SITUACAO_QUITACAO = new Set(["QUITADO", "QUITADO_AGUARDANDO_BAIXA"]);
const SITUACAO_CANONICA_SEM_VENCIDO = new Set([
  "ACORDO_EM_DIA",
  "AGUARDANDO_CONFIRMACAO",
  "QUITADO",
  "QUITADO_AGUARDANDO_BAIXA",
  "SEM_PENDENCIA",
]);
function semSaldoVencido(a) {
  const sv = Number(a?.saldo_vencido);
  if (Number.isFinite(sv)) return sv <= 0.005; // sinal canonico primario
  // fallback (saldo_vencido ainda nao persistido): confia so nos estados que o
  // backend atribui exclusivamente quando o saldo vencido e zero.
  return SITUACAO_CANONICA_SEM_VENCIDO.has(String(a?.situacao_operacional || "").toUpperCase());
}
// Lembrete de parcela devido: acordo em dia com retorno automatico (D-2, dia
// util) ja vencido ou hoje. E o backend (recalcular_situacao_aluno) quem
// agenda e quem silencia depois que o operador tabula.
function lembreteParcelaDevido(a, hojeStr) {
  if (String(a?.situacao_operacional || "").toUpperCase() !== "ACORDO_EM_DIA") return false;
  const ret = a?.data_retorno ? String(a.data_retorno).slice(0, 10) : null;
  if (!ret) return false;
  return ret <= (hojeStr || hojeLocalBR());
}

function mostrarSeloCriticidade(a) {
  if (critCanon(a) === "NORMAL") return false;
  // quitacao nunca exibe criticidade financeira, independentemente de valor antigo.
  if (SITUACAO_QUITACAO.has(String(a?.situacao_operacional || "").toUpperCase())) return false;
  if (semSaldoVencido(a)) return false;
  return true;
}

// Aba "Solicitacoes" foi removida: Solicitar link / termo / financeiro /
// informar pagamento / anexar comprovante ficam INLINE dentro da Tabulacao
// (aba Negociacao), que e o centro unico do operador.
// Casos nao acionaveis: nao aparecem na lista operacional (continuam
// disponiveis para consulta/historico). Somente status ja existentes.
// SEM_SALDO_EM_ABERTO: status que a rotina canonica retirar_zerados_reais_sem_saldo()
// atribui a casos com caso_saldo_zerado_real = true (saldo REAL zero, nao heuristica
// de valor). Fica fora da fila ativa, mas continua consultavel na ficha. Nao confundir
// com BAIXA_REALIZADA, que pode ter saldo real > 0 (anomalia sob investigacao) e por
// isso PERMANECE na fila.
const STATUS_NAO_ACIONAVEIS = ["JURIDICO", "CANCELAMENTO_COBRANCA", "SUSPENSAO_COBRANCA", "AGUARDANDO_BAIXA", "SALDO_ZERO_CONFIRMADO", "SEM_SALDO_EM_ABERTO"];

const SALDO_MINIMO_FILA = 5; // R$ -- abaixo disso o caso nao entra na fila do operador

function ehNaoAcionavel(a, idsEmConfirmacao) {
  const s = String(a?.status_atual || "").toUpperCase();
  if (s.startsWith("QUITAD")) return true; // QUITADO / QUITADO_MANUAL / QUITACAO...
  if (STATUS_NAO_ACIONAVEIS.includes(a?.status_atual)) return true;
  // Tem solicitacao de confirmacao de pagamento PENDENTE: ja esta no fluxo de
  // Confirmacao de Pagamento, sai da fila operacional (fonte de verdade =
  // solicitacoes_confirmacao_pagamento, nao o texto de status).
  if (idsEmConfirmacao && idsEmConfirmacao.has(String(a?.id))) return true;
  // "Aguardando confirmacao de pagamento": caso ja foi para a etapa de
  // confirmacao (operador registrou o valor). Nao ha cobranca a fazer enquanto
  // a confirmacao nao e resolvida -- sai da fila operacional e segue apenas no
  // fluxo de confirmacao. Se a confirmacao for rejeitada, o status volta ao
  // normal e o caso reaparece. O status vem como texto humano em status_jornada.
  const sj = String(a?.status_jornada || "").toUpperCase();
  if (sj.includes("AGUARDANDO CONFIRMAÇÃO") || sj.includes("AGUARDANDO CONFIRMACAO")) return true;
  // Saldo total abaixo de R$ 5,00 (decisao da gestao, 21/08/2026): residuo
  // nao vale acionamento e so ocupa a fila. Fonte = alunos.saldo_total
  // (canonico, persistido por recalcular_situacao_aluno). Sem saldo gravado,
  // o caso continua na fila (nao esconder por falta de dado).
  const st = Number(a?.saldo_total);
  if (a?.saldo_total != null && Number.isFinite(st) && st < SALDO_MINIMO_FILA) return true;
  return false;
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
  { id: "negociacao", label: "Tabulação" },
  { id: "email", label: "📧 E-mail" },
  { id: "financeiro", label: "Financeiro" },
  { id: "adm", label: "ADM" },
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

export default function PainelCarteira({ embedded = false, mostrar360 = false }) {
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
  const [filtroTabulacao, setFiltroTabulacao] = useState("TODAS");
  const [filtroKpi, setFiltroKpi] = useState(null);
  const [filtroValorMin, setFiltroValorMin] = useState("");
  const [filtroValorMax, setFiltroValorMax] = useState("");
  const [filtroDiasMinSemContato, setFiltroDiasMinSemContato] = useState("");
  const [ordenacao, setOrdenacao] = useState("inteligente");
  const [casosEspeciais, setCasosEspeciais] = useState(null);
  const [carregandoEspecial, setCarregandoEspecial] = useState(false);
  // Ids de alunos por estado de acordo (para clique dos cards operacionais).
  const [acordoBuckets, setAcordoBuckets] = useState({ aVencer: [], atrasado: [], quebrado: [] });
  // Detalhamento de parcelas baixadas no mes (cards financeiros).
  const [detalheParcelas, setDetalheParcelas] = useState([]);
  const [detalheFinanceiro, setDetalheFinanceiro] = useState(null); // { tipo, titulo }
  const [mostrarAgenda, setMostrarAgenda] = useState(false); // painel Agenda (retornos) embutido
  const [confirmandoRetorno, setConfirmandoRetorno] = useState(null); // aluno_id em confirmacao
  // Arquivo de quitados (SO GESTAO): casos com quitacao real registrada
  // (quitado_em). Read-only, fora da fila operacional. Etapa 2 do tratamento
  // de quitados -- ver [[quitados-blindagem-fila-e-arquivo]].
  const [quitadosModal, setQuitadosModal] = useState(false);
  const [quitadosLista, setQuitadosLista] = useState([]);
  const [carregandoQuitados, setCarregandoQuitados] = useState(false);
  const [qtdQuitados, setQtdQuitados] = useState(null);
  // Financeiro consolidado por aluno (valor em aberto sem duplicidade).
  // { [aluno_id]: { mensalidades, acordos, total, temDetalhe, temAtraso, acordoResponsavel } }
  const [finAlunos, setFinAlunos] = useState({});
  // Meu desempenho operacional (indicadores pessoais do operador logado).
  const [desempenho, setDesempenho] = useState(null);
  const [acionadosHojeIds, setAcionadosHojeIds] = useState([]);
  const [semPrimeiroIds, setSemPrimeiroIds] = useState([]);
  // aluno_ids com solicitacao de confirmacao de pagamento PENDENTE. Enquanto a
  // confirmacao nao e resolvida (validada ou rejeitada), o aluno sai da fila
  // operacional -- independentemente do texto de status_atual/status_jornada,
  // que nem sempre reflete o "pago". Fonte de verdade =
  // solicitacoes_confirmacao_pagamento (ver [[auto-sair-fila-quitou-ou-confirmacao]]).
  const idsEmConfirmacaoRef = useRef(new Set());

  // ---- Modal operacional ----
  const [modalAberto, setModalAberto] = useState(false);
  const [alunoModal, setAlunoModal] = useState(null);
  const [abaModal, setAbaModal] = useState("resumo");
  const [historico, setHistorico] = useState([]);

  // ---- Acionamento guiado ----
  // O operador clica em "Iniciar acionamento" e o sistema abre, um a um, os
  // casos da fila inteligente. SEM PULO: o proximo so abre depois de tabular
  // (finalizarAtendimento). Sair e permitido (receptivo, pausa) -- pular o
  // aluno, nao. A ordem e a da propria fila inteligente, reconsultada a cada
  // avanco (outro operador pode ter pego o caso; o aluno pode ter pago).
  const [guiado, setGuiado] = useState(false);
  const [guiadoAcionados, setGuiadoAcionados] = useState(0);
  const [guiadoAvancar, setGuiadoAvancar] = useState(0); // tick: avancar apos tabular
  const [guiadoConcluido, setGuiadoConcluido] = useState(null); // { acionados }
  const guiadoFeitosRef = useRef(new Set()); // ids ja tabulados nesta sessao guiada
  const guiadoPendenteRef = useRef(false); // ha um avanco pedido e ainda nao consumido
  const listaFiltradaRef = useRef([]);

  // Exporta o historico/tabulacoes do aluno em PDF -- pra registro,
  // conferencia ou envio pra fora do sistema.
  function exportarHistoricoPDF() {
    if (!alunoModal) return;
    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const margem = 48;
    let y = 56;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(16);
    doc.text("ReATIVA — Histórico de Tabulações", margem, y);
    y += 26;

    doc.setFontSize(12);
    doc.text(nomeAluno(alunoModal) || "-", margem, y);
    y += 18;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(90);
    doc.text(`CPF: ${alunoModal.cpf || "-"}`, margem, y);
    y += 14;
    doc.text(`Responsável atual: ${alunoModal.responsavel_atual_nome || "-"}`, margem, y);
    y += 14;
    doc.text(`Exportado em: ${new Date().toLocaleString("pt-BR")}`, margem, y);
    y += 24;

    doc.setDrawColor(210);
    doc.line(margem, y, 548, y);
    y += 20;

    doc.setTextColor(20);

    if (historico.length === 0) {
      doc.text("Nenhuma movimentação registrada.", margem, y);
    }

    historico.forEach((h) => {
      if (y > 760) {
        doc.addPage();
        y = 56;
      }
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10);
      doc.text(formatarDataHora(h.registrado_em) + "  —  " + (h.tipo || "Movimentação"), margem, y);
      y += 14;

      doc.setFont("helvetica", "normal");
      doc.setFontSize(9.5);
      const descricao = h.descricao || h.status_novo || "-";
      const linhas = doc.splitTextToSize(descricao, 500);
      doc.text(linhas, margem, y);
      y += linhas.length * 12 + 4;

      if (h.status_anterior || h.status_novo) {
        doc.setTextColor(110);
        doc.text(
          `Status: ${labelStatus(h.status_anterior) || "-"} → ${labelStatus(h.status_novo) || "-"}`,
          margem,
          y
        );
        doc.setTextColor(20);
        y += 13;
      }

      if (h.registrado_por_nome) {
        doc.setTextColor(110);
        doc.text(`Registrado por: ${h.registrado_por_nome}`, margem, y);
        doc.setTextColor(20);
        y += 13;
      }

      y += 10;
      doc.setDrawColor(235);
      doc.line(margem, y - 4, 548, y - 4);
    });

    const nomeArquivo = `historico-${(nomeAluno(alunoModal) || "aluno").replace(/[^a-zA-Z0-9]/g, "-")}.pdf`;
    doc.save(nomeArquivo);
  }
  const [honorarios, setHonorarios] = useState(null);
  const [carregandoModal, setCarregandoModal] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [editandoOperador, setEditandoOperador] = useState(false);
  const [novoOperadorEmailModal, setNovoOperadorEmailModal] = useState("");
  const [salvandoOperador, setSalvandoOperador] = useState(false);
  const [feedback, setFeedback] = useState(null); // { tipo: "ok"|"erro", texto }
  // Aviso flutuante das acoes rapidas da linha (fora do modal).
  const [avisoRapido, setAvisoRapido] = useState(null); // { tipo: "ok"|"erro", texto }
  // Sobe a cada gravacao: sinal para a faixa "Da para desfazer" reconsultar.
  const [desfazerTick, setDesfazerTick] = useState(0);
  // Ids com acao rapida em andamento -- evita duplicar movimentacao no duplo clique.
  const [tabulandoIds, setTabulandoIds] = useState(() => new Set());
  const tabulandoRef = useRef(new Set());
  useEffect(() => {
    if (!avisoRapido) return;
    // Com botao de desfazer o aviso precisa durar o suficiente para o
    // operador ler, decidir e clicar.
    const t = setTimeout(
      () => setAvisoRapido(null),
      avisoRapido.tipo === "erro" ? 9000 : avisoRapido.desfazerAlunoId ? 15000 : 3500
    );
    return () => clearTimeout(t);
  }, [avisoRapido]);

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
  const [fixados, setFixados] = useState(new Set());
  const [nomeCopiadoId, setNomeCopiadoId] = useState(null);
  const [somenteFixados, setSomenteFixados] = useState(false);
  const [somenteFocoDia, setSomenteFocoDia] = useState(false);
  const [visao, setVisao] = useState("lista");
  const [arrastandoId, setArrastandoId] = useState(null);
  const [filtroAnoVencimento, setFiltroAnoVencimento] = useState("");
  const [alunosDoAnoVencimento, setAlunosDoAnoVencimento] = useState(null);
  const [colunaSobre, setColunaSobre] = useState(null);
  const [alunosComBoletoVencendo, setAlunosComBoletoVencendo] = useState(new Set());

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getUser();
      const mail = data?.user?.email || null;
      setEmail(mail);
      // O cadastro vem ANTES do setVeTudo porque "ver tudo" agora também
      // depende do perfil (diretoria), não só do e-mail.
      let perfil = null;
      if (mail) {
        const { data: cadastro } = await supabase
          .from("usuarios")
          .select("*")
          .eq("email", mail)
          .single();
        perfil = cadastro || null;
        setUsuarioPerfil(cadastro || { email: mail, nome: nomeOperadorPorEmail(mail) });
      }
      setVeTudo(
        podeVerTudo(mail, perfil?.perfil) &&
          localStorage.getItem("reativa_perfil_visao") !== "operador"
      );
    })();
  }, []);

  useEffect(() => {
    if (email === null) return;
    carregar();
    carregarRetornosPendentes();
    carregarNovosCasosAutomaticos();
    carregarFixados();
    carregarBoletosVencendo();
    carregarMinhaMediaVsEquipe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email, veTudo, operadorFiltro]);

  // Busca os alunos com titulo em aberto vencendo no ano selecionado --
  // separado do resto pra nao recarregar a carteira toda a cada troca.
  useEffect(() => {
    if (!filtroAnoVencimento) {
      setAlunosDoAnoVencimento(null);
      return;
    }
    let ativo = true;
    (async () => {
      const { data } = await supabase.rpc("alunos_por_ano_vencimento", { p_ano: filtroAnoVencimento });
      if (ativo) setAlunosDoAnoVencimento(new Set((data || []).map((d) => d.aluno_id)));
    })();
    return () => { ativo = false; };
  }, [filtroAnoVencimento]);

  const [novosCasosAutomaticos, setNovosCasosAutomaticos] = useState([]);
  const [avisoNovosCasosFechado, setAvisoNovosCasosFechado] = useState(false);
  const [minhaMediaVsEquipe, setMinhaMediaVsEquipe] = useState(null);
  const [avisoMediaFechado, setAvisoMediaFechado] = useState(false);

  // Avisa o operador quando ele recebeu caso(s) novo(s) pela reposicao
  // automatica (quando outro caso dele foi quitado/fechado e o sistema
  // repos sozinho, sem ele pedir). So mostra as ultimas 24h, sem repetir
  // depois que ele ve/fecha o aviso na sessao atual.
  async function carregarNovosCasosAutomaticos() {
    if (!email) return;

    const desde = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from("historico_operadores_alunos")
      .select("nome_aluno, criado_em")
      .eq("acao", "REPOSICAO_AUTOMATICA_VAGA")
      .eq("operador_email", email)
      .gte("criado_em", desde)
      .order("criado_em", { ascending: false })
      .limit(20);

    if (!error) {
      setNovosCasosAutomaticos(data || []);
    }
  }

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
        // Contagem canonica da CARTEIRA ATIVA (exclui encerrados operacionais:
        // SEM_SALDO_EM_ABERTO, quitados, juridico, cancelado). Backend:
        // public.contar_carteira_ativa. Casos saldo-zero nao contam nos 500.
        const { data: __cc } = await supabase.rpc("contar_carteira_ativa", { p_email: alvoEscopo || null });
        ativosCanonico = Number(__cc);
        if (!Number.isFinite(ativosCanonico)) ativosCanonico = null;
      } catch (e) { ativosCanonico = null; }
      // KILL SWITCH: valor_carteira_operador é MÉTRICA (não a lista). Suspenso
      // em contenção -> valorCarteira fica 0; a lista de casos segue normal.
      if (!analiticasSuspensas()) {
        try {
          const { data: __vv } = await supabase.rpc("valor_carteira_operador", { p_email: alvoEscopo });
          setValorCarteira(Number(__vv) || 0);
        } catch (e) { ativosCanonico = null; }
      }
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
      // Alunos com confirmacao de pagamento PENDENTE saem da fila operacional,
      // mesmo que o texto de status ainda nao reflita "pago". Fonte de verdade =
      // solicitacoes_confirmacao_pagamento (PENDENTES).
      // PAGINADO: o PostgREST devolve no maximo 1000 linhas por resposta,
      // independentemente do .limit(). Com ~2.400 pendentes, um unico select
      // deixava ~1.400 alunos ja enviados para confirmacao/baixa VAZAREM para
      // a fila do operador.
      const idsEmConfirmacao = new Set();
      try {
        const PAG_CONF = 1000;
        for (let ini = 0; ini < 50000; ini += PAG_CONF) {
          const { data: pendentesConf, error: erroConf } = await supabase
            .from("solicitacoes_confirmacao_pagamento")
            .select("aluno_id")
            .in("status", ["AGUARDANDO_CONFIRMACAO", "PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO"])
            .order("id", { ascending: true })
            .range(ini, ini + PAG_CONF - 1);
          if (erroConf) throw erroConf;
          (pendentesConf || []).forEach((p) => {
            if (p?.aluno_id != null) idsEmConfirmacao.add(String(p.aluno_id));
          });
          if (!pendentesConf || pendentesConf.length < PAG_CONF) break;
        }
      } catch (e) {
        console.error("Erro ao carregar confirmacoes pendentes (fila):", e);
      }
      idsEmConfirmacaoRef.current = idsEmConfirmacao;

      // Lista operacional: fora quitados e demais nao-acionaveis (status
      // existentes). Casos continuam no banco para consulta/historico.
      const listaAtiva = todas.filter((a) => !ehQuitado(a) && !ehNaoAcionavel(a, idsEmConfirmacao));
      setCasos(listaAtiva);

      // Contagens por data (usam a mesma base escopada).
      const cRetHoje = aplicarEscopo(
        supabase.from("alunos").select("id,status_atual,status_jornada,status_acionamento").eq("data_retorno", hoje).limit(5000)
      );
      const cSemAcion10 = aplicarEscopo(
        supabase.from("alunos").select("id,status_atual,status_jornada,status_acionamento").lte("data_ultimo_acionamento", corte(10)).limit(5000)
      );
      // 9 dias ou mais sem acionamento (sem teto: quem passou de 10 dias
      // continua na carteira e segue em risco ate ser acionado).
      const cProx = aplicarEscopo(
        supabase.from("alunos").select("id,status_atual,status_jornada,status_acionamento").lte("data_ultimo_acionamento", corte(9)).limit(5000)
      );

      const [rRetHoje, rSemAcion10, rProx] = await Promise.all([cRetHoje, cSemAcion10, cProx]);
      const soAcionaveis = (r) => (r?.data || []).filter((a) => !ehQuitado(a) && !ehNaoAcionavel(a, idsEmConfirmacao));
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
            negociadas: 0,
            qtdNegociadas: 0,
            acordos: 0,
            total: 0,
            temDetalhe: false,
            temAtraso: false,
            temAVencer: false,
            menorVencimento: null, // menor vencimento em aberto (YYYY-MM-DD)
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
            const vp = p.vencimento ? String(p.vencimento).slice(0, 10) : null;
            if (vp && (!fin[id].menorVencimento || vp < fin[id].menorVencimento)) fin[id].menorVencimento = vp;
          }
        }

        // 2) Titulos/mensalidades importados em aberto (borderos ja normalizados aqui).
        for (let i = 0; i < idsCarteira.length; i += LOTE_IN) {
          const lote = idsCarteira.slice(i, i + LOTE_IN);
          // HOTFIX parcela negociada: traz tambem as vinculadas, num balde
          // separado. Elas NAO entram em "mensalidades" (que segue sendo so
          // obrigacao avulsa) nem sao somadas junto com as parcelas do acordo
          // -- a divida delas ja esta em fin[id].acordos. O total nao muda.
          const { data } = await supabase
            .from("acordos_titulos")
            .select("aluno_id,status,situacao,acordo_id,valor_em_aberto,saldo_corrigido,valor_original,vencimento")
            .in("aluno_id", lote)
            .in("status", ["em_aberto", "vinculada"]);
          for (const t of data || []) {
            const id = String(t.aluno_id);
            if (!fin[id]) continue;
            const v = Number(t.valor_em_aberto ?? t.saldo_corrigido ?? t.valor_original ?? 0);
            const vt = t.vencimento ? String(t.vencimento).slice(0, 10) : null;
            if (vt && (!fin[id].menorVencimento || vt < fin[id].menorVencimento)) fin[id].menorVencimento = vt;
            const negociada =
              t.status === "vinculada" || t.situacao === "NEGOCIADO" || !!t.acordo_id;
            if (negociada) {
              fin[id].negociadas += v;
              fin[id].qtdNegociadas += 1;
              fin[id].temDetalhe = true;
              continue;
            }
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
        // Pagina TODAS as movimentações do mês. Sem isto, o Supabase corta em
        // 1000 linhas por requisição: operadores de alto volume (>1000
        // tabulações/mês) perdiam as linhas de hoje, zerando "acionados hoje".
        const movMes = [];
        {
          const TAM = 1000;
          for (let de = 0; ; de += TAM) {
            const { data: pagina, error: errPag } = await supabase
              .from("aluno_movimentacoes")
              .select("aluno_id,registrado_em")
              .eq("registrado_por_email", email)
              .in("tipo", TIPOS_ACIONAMENTO)
              .gte("registrado_em", inicioMesTS)
              .order("registrado_em", { ascending: false })
              .range(de, de + TAM - 1);
            if (errPag || !pagina || pagina.length === 0) break;
            movMes.push(...pagina);
            if (pagina.length < TAM) break;
          }
        }

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

  // Foco do Dia usa isso pra saber quem tem boleto vencendo em 2 dias.
  async function carregarBoletosVencendo() {
    const { data } = await supabase.rpc("parcelas_vencendo_2_dias");
    setAlunosComBoletoVencendo(new Set((data || []).map((p) => p.aluno_id)));
  }

  // Compara a media da minha carteira com a media geral da equipe -- pra
  // eu saber se fiquei pra tras depois de fechar/quitar algum caso.
  async function carregarMinhaMediaVsEquipe() {
    if (analiticasSuspensas()) return; // métrica analítica — suspensa em contenção
    const { data } = await supabase.rpc("minha_media_vs_equipe");
    setMinhaMediaVsEquipe(data || null);
  }

  // Fixar/desafixar caso -- pra voltar rapido sem procurar de novo.
  async function carregarFixados() {
    if (!email) return;
    const { data } = await supabase
      .from("casos_fixados")
      .select("aluno_id")
      .eq("operador_email", email);
    setFixados(new Set((data || []).map((f) => f.aluno_id)));
  }

  async function copiarNome(a, e) {
    if (e) e.stopPropagation();
    const nome = nomeAluno(a);
    try {
      await navigator.clipboard.writeText(nome);
    } catch {
      // fallback para navegadores sem Clipboard API
      const ta = document.createElement("textarea");
      ta.value = nome;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch { /* ignore */ }
      document.body.removeChild(ta);
    }
    setNomeCopiadoId(a.id);
    setTimeout(() => setNomeCopiadoId((atual) => (atual === a.id ? null : atual)), 1500);
  }

  async function alternarFixado(alunoId, e) {
    if (e) e.stopPropagation();
    if (!email) return;
    const jaFixado = fixados.has(alunoId);

    if (jaFixado) {
      await supabase.from("casos_fixados").delete().eq("operador_email", email).eq("aluno_id", alunoId);
      setFixados((atual) => {
        const novo = new Set(atual);
        novo.delete(alunoId);
        return novo;
      });
    } else {
      await supabase.from("casos_fixados").insert({ operador_email: email, aluno_id: alunoId });
      setFixados((atual) => new Set(atual).add(alunoId));
    }
  }

  // Carrega retornos ADM pendentes/em tratamento. Se gestao selecionou um
  // operador especifico no seletor, mostra os retornos dele (visao "como
  // se fosse" aquele operador); se nao selecionou ninguem (TODOS), gestao
  // nao ve nada aqui (evita mostrar o total de todo mundo misturado).
  async function carregarRetornosPendentes() {
    let query = supabase
      .from("retornos_adm")
      .select("id, aluno_id, resultado_adm, motivo, proximo_passo, status_tratamento, criado_em, operador_destino_nome")
      .in("status_tratamento", ["PENDENTE", "EM_TRATAMENTO"])
      .order("status_tratamento", { ascending: true })
      .order("criado_em", { ascending: true });

    if (veTudo) {
      if (operadorFiltro === "TODOS") {
        setRetornosPendentes([]);
        return;
      }
      query = query.eq("operador_destino_email", operadorFiltro);
    }

    const { data } = await query;
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
    // Lembrete de parcela devido (acordo em dia, D-2): a tabulacao ja vem
    // pre-selecionada -- o operador so confirma depois de falar com o aluno.
    setStatusNovo(lembreteParcelaDevido(a) ? "LEMBRETE_PARCELA" : (a.status_atual || ""));
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
      // Abrir a ficha marca visualizado E conclui o retorno de "link pronto"
      // (regra de negocio: operador enviou/vai enviar o link por fora). Some do topo.
      try {
        await supabase.rpc("retorno_adm_visualizar", { p_id: ret.id });
        setRetornosPendentes((atual) => atual.filter((r) => r.aluno_id !== a.id));
      } catch (e) { /* silencioso */ }
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

  // Proximo caso do acionamento guiado: primeiro da fila inteligente (ordem
  // viva, recem-recarregada) que ainda nao foi tabulado hoje nem nesta sessao.
  function proximoDoGuiado(lista) {
    const hojeSet = new Set((acionadosHojeIds || []).map(String));
    return (lista || []).find(
      (a) => a?.id && !guiadoFeitosRef.current.has(String(a.id)) && !hojeSet.has(String(a.id))
    ) || null;
  }

  function iniciarGuiado() {
    if (ordenacao !== "inteligente") setOrdenacao("inteligente");
    guiadoFeitosRef.current = new Set();
    setGuiadoAcionados(0);
    setGuiadoConcluido(null);
    setGuiado(true);
    // A lista ja esta na ordem da fila inteligente quando ordenacao ==
    // "inteligente"; se acabou de trocar, o efeito de avanco recalcula.
    guiadoPendenteRef.current = true;
    setGuiadoAvancar((t) => t + 1);
  }

  // Avanco RAPIDO do guiado: nao recarrega a carteira inteira (isso levava
  // segundos). Pega o proximo da lista ja ordenada e confere SO ELE no banco
  // (ainda e meu? ainda e acionavel?). Quem falhar na conferencia e marcado
  // como feito e passa-se ao seguinte. A recarga completa roda em segundo
  // plano depois que o proximo ja esta aberto.
  async function avancarGuiadoRapido(idAtual) {
    const meuEmail = emailEscopo();
    for (let tentativa = 0; tentativa < 25; tentativa++) {
      const cand = proximoDoGuiado(listaFiltradaRef.current.filter((x) => String(x.id) !== String(idAtual)));
      if (!cand) {
        encerrarGuiado(true);
        setModalAberto(false);
        setAlunoModal(null);
        carregar();
        return;
      }
      let fresco;
      try {
        const { data } = await supabase.from("alunos").select(COLUNAS_ALUNO).eq("id", cand.id).maybeSingle();
        fresco = data;
      } catch { fresco = null; }
      const aindaMeu = !meuEmail || String(fresco?.responsavel_atual_email || "").toLowerCase() === String(meuEmail).toLowerCase();
      const ok = fresco && aindaMeu && !ehNaoAcionavel(fresco, idsEmConfirmacaoRef.current)
        && !(fresco.data_ultimo_acionamento && String(fresco.data_ultimo_acionamento).slice(0, 10) === hojeLocalBR());
      if (!ok) {
        guiadoFeitosRef.current.add(String(cand.id)); // saiu da fila por fora: nao e meu/ja pago/ja acionado
        continue;
      }
      await abrirModal(fresco);
      setAbaModal("negociacao");
      carregar(); // recarga completa em segundo plano
      return;
    }
    // Muitas conferencias seguidas falharam: recarrega tudo e deixa o efeito decidir.
    await carregar();
    guiadoPendenteRef.current = true;
    setGuiadoAvancar((t) => t + 1);
  }

  function encerrarGuiado(concluiu) {
    setGuiado(false);
    if (concluiu) setGuiadoConcluido({ acionados: guiadoFeitosRef.current.size });
  }

  function fecharModal() {
    if (guiado) {
      const sair = window.confirm(
        "Sair do acionamento guiado?\n\nEste aluno ainda nao foi tabulado. Ele continua na fila e sera o primeiro quando voce retomar."
      );
      if (!sair) return;
      encerrarGuiado(false);
    }
    setModalAberto(false);
    setAlunoModal(null);
    setFeedback(null);
    setAcaoInline(null);
    setRetornoAluno(null);
    // A conclusao do retorno e feita pelo gatilho quando a acao real ocorre;
    // atualiza contador ao fechar.
    carregarRetornosPendentes();
  }

  // Desfazer direto do aviso da acao rapida: pega o cartao mais recente que
  // ainda pode voltar atras naquele aluno. Quem decide se pode e o banco -- se
  // o ADM ja pegou o item ou outra acao entrou no meio, volta recusado com o
  // motivo, e o operador ve a frase em vez de um botao que nao faz nada.
  async function desfazerUltimaDoAluno(alunoId) {
    const lista = await listarDesfazer(alunoId, 5);
    const alvo = (lista.itens || []).find((i) => !i.bloqueio);
    if (!alvo) {
      const bloqueado = (lista.itens || [])[0];
      setAvisoRapido({
        tipo: "erro",
        texto: bloqueado
          ? `Nao da mais para desfazer: ${explicarBloqueio(bloqueado.bloqueio)}`
          : "Nao encontrei essa acao para desfazer.",
      });
      return;
    }

    const res = await desfazerAcao(alvo);
    if (!res.ok) {
      setAvisoRapido({ tipo: "erro", texto: res.erro });
      return;
    }
    setAvisoRapido({
      tipo: "ok",
      texto:
        "Desfeito." +
        (res.statusRestaurado ? ` A ficha voltou para "${res.statusRestaurado}".` : ""),
    });
    setDesfazerTick((t) => t + 1);
    carregar();
  }

  // Acao rapida direto na linha da carteira -- tabula sem precisar abrir
  // o modal inteiro, pra casos simples do dia a dia.
  async function tabularRapido(aluno, statusNovo, rotuloStatus, e) {
    if (e) e.stopPropagation();
    if (!aluno?.id) return;
    // Trava sincrona: o segundo clique cai fora antes de qualquer gravacao.
    if (tabulandoRef.current.has(aluno.id)) return;
    tabulandoRef.current.add(aluno.id);
    setTabulandoIds(new Set(tabulandoRef.current));

    const agora = new Date().toISOString();
    const statusAntigo = aluno.status_atual || aluno.status_jornada || null;

    try {
      // 1) Atualiza a ficha do aluno. NAO mexe em responsavel_atual_email
      // nem em fidelizacao -- o caso continua com o mesmo operador.
      const { error: erroAluno } = await supabase
        .from("alunos")
        .update({
          status_jornada: statusNovo,
          status_atual: statusNovo,
          data_ultimo_acionamento: agora,
          ultimo_contato: agora,
        })
        .eq("id", aluno.id);
      if (erroAluno) throw erroAluno;

      // 2) Registra a movimentacao manual do operador. O tipo
      // FINALIZACAO_ATENDIMENTO e reconhecido por eh_tipo_acionamento(),
      // entao conta como acionamento manual e o gatilho propaga a data
      // para alunos e casos.
      const { error: erroMov } = await supabase.from("aluno_movimentacoes").insert({
        aluno_id: String(aluno.id),
        tipo: "FINALIZACAO_ATENDIMENTO",
        descricao: `${rotuloStatus} — ação rápida direto na Minha Carteira.`,
        status_anterior: statusAntigo,
        status_novo: statusNovo,
        registrado_por_nome: usuarioLogado?.nome || nomeOperadorPorEmail(email),
        registrado_por_email: email,
        registrado_em: agora,
      });
      if (erroMov) throw erroMov;

      // 3) Reordena na hora: a linha ja recebe a nova data e vai pro fim
      // da fila do proprio operador, sem esperar o recarregamento inteiro.
      setCasos((prev) =>
        prev.map((c) =>
          c.id === aluno.id
            ? { ...c, status_jornada: statusNovo, status_atual: statusNovo, data_ultimo_acionamento: agora, ultimo_contato: agora }
            : c
        )
      );
      setAvisoRapido({
        tipo: "ok",
        texto: `${rotuloStatus} registrado para ${nomeAluno(aluno)}.`,
        desfazerAlunoId: aluno.id,
      });
      setDesfazerTick((t) => t + 1);
      // Recarrega KPIs em segundo plano, sem travar a acao.
      carregar();
    } catch (err) {
      setAvisoRapido({
        tipo: "erro",
        texto: `Nao foi possivel registrar "${rotuloStatus}": ${err?.message || err?.details || "erro desconhecido"}`,
      });
    } finally {
      tabulandoRef.current.delete(aluno.id);
      setTabulandoIds(new Set(tabulandoRef.current));
    }
  }

  // Move um caso de coluna arrastando -- reaproveita a mesma tabulacao
  // rapida (atualiza status + registra movimentacao).
  async function moverParaColuna(aluno, coluna) {
    if (!coluna || coluna.chave === "SEM_ACIONAMENTO" || coluna.chave === "OUTROS") return;
    await tabularRapido(aluno, coluna.chave, `Movido pra "${coluna.titulo}"`);
  }

  // Troca rapida do operador responsavel direto no modal, sem sair da
  // Minha Carteira. So quem ve tudo (Amanda e Fernanda) tem esse controle.
  async function salvarOperadorModal() {
    if (!alunoModal?.id || !novoOperadorEmailModal) return;

    const novoOperador = OPERADORES.find((op) => op.email === novoOperadorEmailModal);
    if (!novoOperador) return;

    setSalvandoOperador(true);

    // Usa a RPC segura (executor) -- update direto bate na trava _guard_resp_aluno
    // e retorna SEM_PERMISSAO mesmo para quem tem permissao (Amanda/Fernanda).
    const { data: r, error } = await supabase.rpc("alterar_responsavel_aluno", {
      p_aluno_id: alunoModal.id,
      p_novo_email: novoOperador.email,
      p_motivo: "Alteracao de responsavel pela carteira",
      p_origem: "minha_carteira",
      p_modo: "ALTERAR_SOMENTE_ALUNO",
    });

    if (error || !r?.ok) {
      alert("Erro ao alterar operador responsavel: " + (r?.erro || error?.message || "erro"));
      setSalvandoOperador(false);
      return;
    }

    setEditandoOperador(false);
    setNovoOperadorEmailModal("");
    setSalvandoOperador(false);
    atualizarTudo(alunoModal.id);
  }

  // Abre o e-mail padrao do computador com um rascunho pronto, e registra
  // no historico do aluno que o e-mail foi enviado (igual ja fazemos com
  // outras acoes na carteira).
  // Enviar e-mail conta como tabulacao de verdade -- atualiza o status do
  // aluno (igual finalizarAtendimento) e usa o mesmo tipo que o Meu
  // Dashboard conta como acionamento, senao o envio nao contava em nada.
  async function enviarEmailAluno(aluno) {
    if (!aluno?.email) return;

    const assunto = encodeURIComponent("ReATIVA — Regularização de mensalidades");
    const corpo = encodeURIComponent(
      `Olá, ${nomeAluno(aluno)}.\n\nEstamos entrando em contato sobre a regularização das suas mensalidades em aberto.\n\nQualquer dúvida, estamos à disposição.`
    );
    window.open(`mailto:${aluno.email}?subject=${assunto}&body=${corpo}`, "_blank");

    const agora = new Date().toISOString();
    const statusAntigo = aluno.status_atual || aluno.status_jornada || null;

    await supabase
      .from("alunos")
      .update({
        status_jornada: "MENSAGEM_ENVIADA",
        status_atual: "MENSAGEM_ENVIADA",
        data_ultimo_acionamento: agora,
        ultimo_contato: agora,
      })
      .eq("id", aluno.id);

    await supabase.from("aluno_movimentacoes").insert({
      aluno_id: String(aluno.id),
      tipo: "FINALIZACAO_ATENDIMENTO",
      descricao: `E-mail enviado para ${aluno.email} direto na Minha Carteira.`,
      status_anterior: statusAntigo,
      status_novo: "MENSAGEM_ENVIADA",
      registrado_por_nome: usuarioLogado?.nome || nomeOperadorPorEmail(email),
      registrado_por_email: email,
      registrado_em: agora,
    });

    atualizarTudo(aluno.id);
  }

  // Recarrega o aluno atual (linha da carteira + modal) apos uma acao.
  async function atualizarTudo(id) {
    setDesfazerTick((t) => t + 1);
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
      } else {
        // Sem data digitada: agenda o retorno automaticamente pela regra do
        // status (Fase 3). Alguns status nao geram retorno automatico.
        const retornoAuto = retornoAutomaticoDeStatus(statusNovo);
        if (retornoAuto) atualizacaoAluno.data_retorno = retornoAuto;
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
          .in("status", ["AGUARDANDO_CONFIRMACAO", "PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO"])
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

      // Foi pra juridico -- sinaliza que o caso saiu da carteira ativa,
      // dispara a reposicao automatica.
      if (statusNovo === "JURIDICO") {
        const { error: erroLiberar } = await supabase.rpc("liberar_caso_por_evento", {
          p_aluno_id: a.id,
          p_evento: "JURIDICO",
        });
        if (erroLiberar) {
          console.error("Erro ao liberar caso (reposição automática):", erroLiberar);
        }
      }

      setResumoConversa("");
      setFeedback({ tipo: "ok", texto: "Atendimento salvo com sucesso." });
      if (guiado) {
        // Tabulou: este e o unico jeito de avancar. Recarrega a fila do banco
        // (outro operador pode ter pego o proximo; alguem pode ter pago) e
        // deixa o efeito de avanco abrir o proximo com a lista fresca.
        guiadoFeitosRef.current.add(String(a.id));
        setGuiadoAcionados(guiadoFeitosRef.current.size);
        // Tira o tabulado da lista local na hora (sem esperar recarga).
        setCasos((atual) => atual.map((x) => (String(x.id) === String(a.id) ? { ...x, ...atualizacaoAluno } : x)));
        await avancarGuiadoRapido(a.id);
      } else {
        await atualizarTudo(a.id);
      }
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
        dados = (data || []).filter((a) => !ehQuitado(a) && !ehNaoAcionavel(a, idsEmConfirmacaoRef.current));
      } else if (kpi === "semAcionamento10") {
        const { data } = await base().lte("data_ultimo_acionamento", corteDias(10)).limit(5000);
        dados = (data || []).filter((a) => !ehQuitado(a) && !ehNaoAcionavel(a, idsEmConfirmacaoRef.current));
      } else if (kpi === "proximosPerder") {
        // 9 dias ou mais sem acionamento (sem teto: acima de 10 dias o caso
        // continua na carteira e segue em risco ate ser acionado).
        const { data } = await base()
          .lte("data_ultimo_acionamento", corteDias(9))
          .limit(5000);
        dados = (data || []).filter((a) => !ehQuitado(a) && !ehNaoAcionavel(a, idsEmConfirmacaoRef.current));
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

  // Confirma (ou desfaz) o retorno de um aluno via RPC e reflete localmente.
  async function confirmarRetornoAgenda(alunoId, confirmar = true) {
    setConfirmandoRetorno(alunoId);
    try {
      const { data, error } = await supabase.rpc("agenda_confirmar_retorno", {
        p_aluno_id: alunoId,
        p_confirmar: confirmar,
      });
      if (error) throw error;
      setCasos((prev) =>
        prev.map((c) => (String(c.id) === String(alunoId) ? { ...c, retorno_confirmado_em: data || null } : c))
      );
    } catch (e) {
      alert("Não foi possível confirmar o retorno: " + (e?.message || e));
    } finally {
      setConfirmandoRetorno(null);
    }
  }

  function onKpiClick(id) {
    if (id === "agenda") {
      setMostrarAgenda((v) => !v);
      return;
    }
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

  // Arquivo de quitados (SO GESTAO). Anchor: casos.quitado_em IS NOT NULL --
  // quitacao real com data/valor/origem. Read-only, nao entra na fila.
  async function abrirQuitados() {
    if (!veTudo) return; // guard de UI; RLS ainda protege no backend
    setQuitadosModal(true);
    setCarregandoQuitados(true);
    try {
      let q = supabase
        .from("casos")
        .select("aluno_id,nome,nome_aluno,cpf,operador_email,quitado_em,valor_quitado,origem_quitacao,status_financeiro")
        .not("quitado_em", "is", null)
        .order("quitado_em", { ascending: false })
        .limit(5000);
      // Se a gestao filtrou um operador especifico, respeita o recorte.
      if (operadorFiltro && operadorFiltro !== "TODOS") q = q.eq("operador_email", operadorFiltro);
      const { data, error } = await q;
      if (error) throw error;
      setQuitadosLista(data || []);
    } catch (e) {
      console.error("Erro ao carregar arquivo de quitados:", e);
      setQuitadosLista([]);
    } finally {
      setCarregandoQuitados(false);
    }
  }

  // Contador do card (gestao). Leve: HEAD count sem trazer linhas.
  useEffect(() => {
    if (!veTudo) { setQtdQuitados(null); return undefined; }
    let ativo = true;
    (async () => {
      let q = supabase.from("casos").select("aluno_id", { count: "exact", head: true }).not("quitado_em", "is", null);
      if (operadorFiltro && operadorFiltro !== "TODOS") q = q.eq("operador_email", operadorFiltro);
      const { count } = await q;
      if (ativo) setQtdQuitados(Number(count) || 0);
    })();
    return () => { ativo = false; };
  }, [veTudo, operadorFiltro]);

  const [saldoView, setSaldoView] = useState({});
  const [valorCarteira, setValorCarteira] = useState(0);
  const normCpf = (c) => String(c || "").replace(/\D/g, "").padStart(11, "0");
  useEffect(() => {
    // KILL SWITCH: vw_carteira_operador enriquece a lista com saldo/qtd
    // (MÉTRICA). Suspenso -> saldoView vazio; a lista de casos segue normal.
    if (analiticasSuspensas()) return undefined;
    let ativo = true;
    (async () => {
      const alvo = operadorFiltro && operadorFiltro !== "TODOS" ? operadorFiltro : (veTudo ? null : email);
      // Pagina a view: um .select() sem range trava em 1000 linhas no Supabase,
      // entao so os primeiros ~1000 CPFs recebiam saldo real e a ordenacao por
      // valor so funcionava nos primeiros casos. Aqui traz todos em lotes.
      const PAGINA = 1000;
      const m = {};
      let inicio = 0;
      while (true) {
        let query = supabase
          .from("vw_carteira_operador")
          .select("cpf_limpo, saldo_mensalidades_aberto, qtd_titulos_abertos")
          .range(inicio, inicio + PAGINA - 1);
        if (alvo) query = query.eq("operador_email", alvo);
        const { data } = await query;
        if (!ativo) return;
        (data || []).forEach((r) => { m[normCpf(r.cpf_limpo)] = { saldo: Number(r.saldo_mensalidades_aberto) || 0, qtd: Number(r.qtd_titulos_abertos) || 0 }; });
        if (!data || data.length < PAGINA) break;
        inicio += PAGINA;
      }
      if (!ativo) return;
      setSaldoView(m);
    })();
    return () => { ativo = false; };
  }, [casos, email, veTudo, operadorFiltro]);
  const saldoDe = (a) => {
    const v = saldoView[normCpf(a && a.cpf)];
    if (v && Number.isFinite(v.saldo)) return v.saldo;
    // Fallback quando a view analitica nao trouxe o CPF (kill switch ligado,
    // corrida de carga, ou CPF fora da view): usa o valor em aberto do proprio
    // caso em vez de 0. Sem isso a ordenacao "Maior valor primeiro" jogava os
    // maiores devedores para o fim da lista (todos empatados em 0).
    const bruto = Number(a && a.valor_em_aberto);
    return Number.isFinite(bruto) ? bruto : 0;
  };
  const qtdTitulosDe = (a) => (saldoView[normCpf(a && a.cpf)] ? saldoView[normCpf(a && a.cpf)].qtd : 0);
  // Valor CANONICO para ordenar/filtrar: o MESMO "Em aberto" que aparece grande
  // no card (fa.total = mensalidades em aberto + acordos). Antes a ordenacao usava
  // saldoDe (view analitica = "Mensalidades (originais)"), que diverge do total
  // exibido -> a fila parecia fora de ordem (ex.: um caso de R$ 3.743 caindo
  // abaixo de um de R$ 718 porque o "originais" dele era menor). Fallback pro
  // valor_em_aberto do proprio caso quando nao ha detalhe consolidado.
  const valorAbertoDe = (a) => {
    const fa = finAlunos[String(a && a.id)];
    if (fa && fa.temDetalhe && Number.isFinite(Number(fa.total))) return Number(fa.total);
    const fb = Number(a && a.valor_em_aberto);
    return Number.isFinite(fb) ? fb : 0;
  };
  const listaFiltrada = useMemo(() => {
    // Com um card selecionado, a lista vem dos registros carregados do
    // indicador; sem card, mostra a carteira normal. Busca/status/ordenacao
    // continuam aplicando por cima.
    let l = filtroKpi ? casosEspeciais || [] : casos;
    if (filtroStatus !== "TODOS") {
      l = l.filter((a) => statusPrazo(a).label === filtroStatus);
    }
    if (filtroTabulacao !== "TODAS") {
      l = l.filter((a) => tabulacaoDoAluno(a) === filtroTabulacao);
    }
    if (somenteFixados) {
      l = l.filter((a) => fixados.has(a.id));
    }
    if (somenteFocoDia) {
      const hoje = hojeLocalBR();
      l = l.filter((a) => {
        const critico = critAlta(a); // criticidade canonica do backend
        const retornoHoje = a.data_retorno === hoje;
        const retornoAtrasado = a.data_retorno && a.data_retorno < hoje;
        const fixado = fixados.has(a.id);
        const boletoVencendo = alunosComBoletoVencendo.has(a.id);
        return critico || retornoHoje || retornoAtrasado || fixado || boletoVencendo;
      });
    }
    const valorMinNum = filtroValorMin.trim() ? Number(filtroValorMin.replace(/\./g, "").replace(",", ".")) : null;
    const valorMaxNum = filtroValorMax.trim() ? Number(filtroValorMax.replace(/\./g, "").replace(",", ".")) : null;
    if (valorMinNum !== null && !Number.isNaN(valorMinNum)) {
      l = l.filter((a) => valorAbertoDe(a) >= valorMinNum);
    }
    if (valorMaxNum !== null && !Number.isNaN(valorMaxNum)) {
      l = l.filter((a) => valorAbertoDe(a) <= valorMaxNum);
    }
    if (filtroDiasMinSemContato.trim()) {
      const diasMin = Number(filtroDiasMinSemContato);
      if (!Number.isNaN(diasMin)) {
        l = l.filter((a) => {
          const d = diasSemContato(a);
          return d === null ? true : d >= diasMin;
        });
      }
    }
    if (alunosDoAnoVencimento) {
      l = l.filter((a) => alunosDoAnoVencimento.has(a.id));
    }
    if (busca.trim()) {
      const t = semAcento(busca);
      l = l.filter((a) =>
        [nomeAluno(a), a.cpf, a.telefone, a.responsavel_atual_nome, situacaoLabel(a)]
          .filter(Boolean)
          .some((c) => semAcento(c).includes(t))
      );
    }
    // Chave de ordenacao precisa (milissegundos), nao em dias inteiros --
    // com dias inteiros, varios casos tabulados no mesmo dia empatavam e a
    // ordem entre eles ficava embaralhada (o que acabou de ser tabulado
    // nem sempre ia pro fim de verdade). Aqui o mais recente sempre fica
    // por ultimo, sem empate.
    const chaveOrdenacao = (a) => {
      const base = a?.data_ultimo_acionamento || a?.ultimo_contato || a?.responsavel_atual_em || null;
      if (!base) return null;
      const t = new Date(base).getTime();
      return Number.isNaN(t) ? null : t;
    };
    const keyDias = (a) => {
      const t = chaveOrdenacao(a);
      return t === null ? Infinity : -t;
    };
    const arr = [...l];
    if (ordenacao === "inteligente") {
      // Fila inteligente (regra da gestao, 21/08/2026): a ordem segue
      // EXATAMENTE o selo de prazo que o operador ve na linha (statusPrazo):
      //   0 Perdendo o caso (11+ dias)  -> nunca perder caso
      //   1 Critico (9-10 dias)
      //   2 Atencao (8 dias)
      //   3 Novo (nunca acionado e sem data de entrada)
      //   4 Retorno devido (hoje/atrasado)
      //   5 Dentro do prazo (0-7 dias)
      // Dentro de cada faixa: CRITICIDADE canonica, depois SEMPRE os mais
      // antigos sem acionamento primeiro (chegando por ultimo nos mais novos);
      // empate por saldo. Sem rodizio por ano: ordem estrita.
      const hoje = hojeLocalBR();
      const RANK_PRAZO = { "Perdendo o caso": 0, Critico: 1, Atencao: 2, Novo: 3 };
      const faixa = (a) => {
        const lab = statusPrazo(a).label;
        if (lab in RANK_PRAZO) return RANK_PRAZO[lab];
        const ret = a?.data_retorno ? String(a.data_retorno).slice(0, 10) : null;
        if (ret && ret <= hoje) return 4;
        return 5;
      };
      const diasParado = (a) => {
        const d = diasSemContato(a);
        return d === null ? 9999 : d;
      };
      arr.sort((a, b) =>
        (faixa(a) - faixa(b)) ||
        (critRank(a) - critRank(b)) ||
        (diasParado(b) - diasParado(a)) ||
        (keyDias(b) - keyDias(a)) ||
        (valorAbertoDe(b) - valorAbertoDe(a))
      );
    }
    else if (ordenacao === "prioridade") {
      // O que acionar primeiro: retorno devido (hoje/atrasado) e maior
      // criticidade canonica no topo; empate por mais tempo sem contato e maior
      // saldo. Reflete a criticidade correta do backend, nao dias sem contato.
      const hoje = hojeLocalBR();
      const retornoDevido = (a) => {
        const ret = a?.data_retorno ? String(a.data_retorno).slice(0, 10) : null;
        return ret && ret <= hoje ? 0 : 1;
      };
      arr.sort((a, b) =>
        (retornoDevido(a) - retornoDevido(b)) ||
        (critRank(a) - critRank(b)) ||
        (keyDias(b) - keyDias(a)) ||
        (valorAbertoDe(b) - valorAbertoDe(a))
      );
    }
    else if (ordenacao === "sem_contato_desc") arr.sort((a, b) => keyDias(b) - keyDias(a));
    else if (ordenacao === "sem_contato_asc") arr.sort((a, b) => keyDias(a) - keyDias(b));
    else if (ordenacao === "valor_desc") arr.sort((a, b) => valorAbertoDe(b) - valorAbertoDe(a));
    else if (ordenacao === "valor_asc") arr.sort((a, b) => valorAbertoDe(a) - valorAbertoDe(b));

    // Quando a operadora escolhe explicitamente ordenar por VALOR, essa ordem
    // manda por cima de tudo: nada de rodizio por ano nem re-rank do Foco do Dia
    // reembaralhando (era isso que fazia "os 5 primeiros em ordem e depois um de
    // 300 alternando alto/baixo"). Fica valor puro, decrescente ou crescente.
    const ordenacaoPorValor = ordenacao === "valor_desc" || ordenacao === "valor_asc";

    // No Foco do Dia, a prioridade manda por cima da ordenacao escolhida:
    // retorno do dia/atrasado primeiro, depois boleto vencido/vencendo, depois
    // o resto. Dentro de cada grupo, mantem a ordem ja aplicada acima (sort
    // estavel). Usa o menor vencimento em aberto ja calculado em finAlunos.
    // Excecao: se a ordenacao escolhida for por valor, nao re-ranqueia -- a
    // operadora quer o maior valor no topo sem nada furando a fila.
    if (somenteFocoDia && !ordenacaoPorValor) {
      const hoje = hojeLocalBR();
      const rankFoco = (a) => {
        const ret = a.data_retorno ? String(a.data_retorno).slice(0, 10) : null;
        if (ret && ret <= hoje) return 0; // retorno devido
        const venc = finAlunos[String(a.id)]?.menorVencimento || null;
        if (venc) {
          const d = diasParaData(hoje, venc);
          if (d !== null && d < 0) return 1; // vencido
          if (d !== null && d <= 3) return 2; // vence em ate 3 dias
        }
        return 3;
      };
      // Empate por MAIOR saldo dentro de cada faixa: sem esse desempate a ordem
      // dentro do grupo dependia do sort anterior e parecia "sem ordem".
      arr.sort((a, b) =>
        (rankFoco(a) - rankFoco(b)) ||
        (critRank(a) - critRank(b)) ||
        (valorAbertoDe(b) - valorAbertoDe(a))
      );
    }
    return arr;
  }, [casos, casosEspeciais, filtroStatus, filtroTabulacao, busca, filtroKpi, ordenacao, saldoView, filtroValorMin, filtroValorMax, filtroDiasMinSemContato, somenteFixados, fixados, somenteFocoDia, alunosComBoletoVencendo, alunosDoAnoVencimento, finAlunos]);
  listaFiltradaRef.current = listaFiltrada;

  // Avanco do acionamento guiado. Roda depois que a lista foi recarregada
  // (carregar -> setCasos -> listaFiltrada), por isso le a lista fresca.
  useEffect(() => {
    if (!guiado || !guiadoAvancar || !guiadoPendenteRef.current) return;
    if (ordenacao !== "inteligente") return; // iniciarGuiado ja trocou; espera o re-render
    guiadoPendenteRef.current = false; // consome o pedido: trocar filtro/ordem depois nao pula ninguem
    const prox = proximoDoGuiado(listaFiltradaRef.current);
    if (!prox) {
      encerrarGuiado(true);
      setModalAberto(false);
      setAlunoModal(null);
      return;
    }
    abrirModal(prox).then(() => setAbaModal("negociacao"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guiadoAvancar, ordenacao]);

  // Agrupamento pro Kanban: uma coluna fixa "Sem acionamento" (nunca
  // acionados) + as tabulacoes normais mais usadas no dia a dia, com o
  // resto agrupado em "Outros status" pra nao poluir o board.
  const COLUNAS_KANBAN_PRINCIPAIS = [
    { chave: "CONTATAR", titulo: "Contatar" },
    { chave: "EM_ATENDIMENTO", titulo: "Em Atendimento" },
    { chave: "ALUNO_EM_NEGOCIACAO_24H", titulo: "Em Negociação" },
    { chave: "AGUARDANDO_LINK", titulo: "Aguardando Link" },
    { chave: "AGUARDANDO_BAIXA", titulo: "Aguardando Baixa" },
    { chave: "ACORDO_FECHADO", titulo: "Acordo Fechado" },
  ];
  const kanbanColunas = useMemo(() => {
    const semAcionamento = [];
    const porStatus = {};
    COLUNAS_KANBAN_PRINCIPAIS.forEach((c) => (porStatus[c.chave] = []));
    const outros = [];

    listaFiltrada.forEach((a) => {
      if (!a.data_ultimo_acionamento) {
        semAcionamento.push(a);
        return;
      }
      const st = String(a.status_atual || a.status_jornada || "").toUpperCase();
      if (porStatus[st]) porStatus[st].push(a);
      else outros.push(a);
    });

    const colunas = [{ chave: "SEM_ACIONAMENTO", titulo: "Sem acionamento", itens: semAcionamento }];
    COLUNAS_KANBAN_PRINCIPAIS.forEach((c) => colunas.push({ chave: c.chave, titulo: c.titulo, itens: porStatus[c.chave] }));
    colunas.push({ chave: "OUTROS", titulo: "Outros status", itens: outros });
    return colunas;
  }, [listaFiltrada]);

  // Cards operacionais (abrem a tabela) + financeiros (abrem detalhamento).
  // Todos permanecem visiveis mesmo zerados.
  // Agenda embutida: retornos da carteira (hoje -> futuros) + atrasados nao
  // confirmados por ate 7 dias. Confirmados saem da lista (tratados).
  const agendaPendentes = useMemo(() => {
    const hoje = hojeLocalBR();
    const diasAtras = (iso) => {
      const a = new Date(`${hoje}T00:00:00`);
      const b = new Date(`${String(iso).slice(0, 10)}T00:00:00`);
      return Math.round((a - b) / 86400000);
    };
    return (casos || [])
      .filter((a) => {
        const ret = a?.data_retorno ? String(a.data_retorno).slice(0, 10) : null;
        if (!ret) return false;
        if (a.retorno_confirmado_em) return false; // ja tratado
        if (ret >= hoje) return true; // hoje ou futuro
        return diasAtras(ret) <= 7; // atrasado: some depois de 1 semana
      })
      .sort((x, y) => {
        const rx = String(x.data_retorno).slice(0, 10);
        const ry = String(y.data_retorno).slice(0, 10);
        if (rx !== ry) return rx < ry ? -1 : 1;
        return String(x.hora_retorno || "99:99").localeCompare(String(y.hora_retorno || "99:99"));
      });
  }, [casos]);

  // Carteira compacta (sugestao da operacao 2026-08-08): so os cards que a
  // operacao de fato usa. "Sem acionamento" + "proximos de perder" viraram um
  // unico card focado na janela critica (9-11 dias). A Agenda entra como card.
  const kpiCards = [
    { id: "ativos", rot: "Casos ativos", val: kpis.ativos, cor: "#2563eb", icone: "📁" },
    { id: "proximosPerder", rot: "Sem acionamento (risco de perder)", val: kpis.proximosPerder, cor: "#dc2626", icone: "⚠️", urgente: true },
    { id: "agenda", rot: "Agenda (retornos)", val: agendaPendentes.length, cor: "#7c3aed", icone: "🗓️" },
    { id: "acordoAVencer", rot: "Acordos a vencer", val: kpis.acordoAVencer, cor: "#0891b2", icone: "📄" },
    { id: "acordoAtrasado", rot: "Acordos atrasados", val: kpis.acordoAtrasado, cor: "#f97316", icone: "⏰" },
    { id: "acordoQuebrado", rot: "Acordos quebrados", val: kpis.acordoQuebrado, cor: "#e11d48", icone: "💥" },
    { id: "retornosAdm", rot: "Retornos do ADM", val: retornosPendentes.length, cor: "#c2410c", icone: "📌" },
  ].filter((c) => (!veTudo || operadorFiltro !== "TODOS") || c.id !== "retornosAdm");

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

      {!avisoNovosCasosFechado && novosCasosAutomaticos.length > 0 && (
        <div
          style={{
            background: "#eff6ff",
            border: "1px solid #c7d7fe",
            borderRadius: 14,
            padding: "13px 16px",
            marginBottom: 16,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 12,
          }}
        >
          <div>
            <strong style={{ color: "#0f7a4f" }}>
              🔄 Você recebeu {novosCasosAutomaticos.length} caso{novosCasosAutomaticos.length > 1 ? "s" : ""} novo
              {novosCasosAutomaticos.length > 1 ? "s" : ""} automaticamente nas últimas 24h
            </strong>
            <p style={{ margin: "4px 0 0", fontSize: 12.5, color: "#0f7a4f" }}>
              Reposição automática (outro caso seu foi confirmado/fechado): {" "}
              {novosCasosAutomaticos.slice(0, 5).map((c) => c.nome_aluno).join(", ")}
              {novosCasosAutomaticos.length > 5 ? ` e mais ${novosCasosAutomaticos.length - 5}` : ""}.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setAvisoNovosCasosFechado(true)}
            style={{ border: "none", background: "transparent", color: "#0f7a4f", cursor: "pointer", fontSize: 13, fontWeight: 700 }}
          >
            Fechar
          </button>
        </div>
      )}

      {!veTudo && !avisoMediaFechado && minhaMediaVsEquipe?.abaixo_da_media && (
        <div
          style={{
            background: "#fff7e6",
            border: "1px solid #f5c542",
            borderRadius: 14,
            padding: "13px 16px",
            marginBottom: 16,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 12,
          }}
        >
          <div>
            <strong style={{ color: "#7c4a1e" }}>⚖️ Sua carteira está abaixo da média da equipe</strong>
            <p style={{ margin: "4px 0 0", fontSize: 12.5, color: "#7c4a1e" }}>
              Seu valor médio por caso: {formatarMoeda(minhaMediaVsEquipe.minha_media)} · Média da equipe:{" "}
              {formatarMoeda(minhaMediaVsEquipe.media_geral)}. O nivelamento automático deve te aproximar da
              média nos próximos dias.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setAvisoMediaFechado(true)}
            style={{ border: "none", background: "transparent", color: "#7c4a1e", cursor: "pointer", fontSize: 13, fontWeight: 700 }}
          >
            Fechar
          </button>
        </div>
      )}

      <div style={S.cabecalho}>
        <div>
          <h1 style={S.titulo}>{mostrar360 ? "Panorama 360" : (veTudo ? "Fila operacional" : "Minha Carteira")}</h1>
          <p style={S.subtitulo}>
            {veTudo ? "Visao completa da base de casos." : `Carteira de ${nomeOperadorPorEmail(email)}.`}
          </p>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <div style={S.userChip}>
            <span style={S.userNome}>{nomeOperadorPorEmail(email)}</span>
            <span style={S.userRole}>{veTudo ? "Gestao" : "Operador"}</span>
          </div>
          {veTudo && !mostrar360 && aba === "carteira" && (
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
          {avisoRapido && (
            <div
              role="status"
              style={{
                position: "fixed",
                right: 20,
                bottom: 20,
                zIndex: 9999,
                maxWidth: 420,
                padding: "12px 16px",
                borderRadius: 10,
                fontSize: 13,
                fontWeight: 600,
                color: "#fff",
                boxShadow: "0 8px 24px rgba(0,0,0,.25)",
                background: avisoRapido.tipo === "erro" ? "#b42318" : "#1e40af",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <span>{avisoRapido.texto}</span>
                {avisoRapido.desfazerAlunoId && (
                  <button
                    type="button"
                    onClick={() => desfazerUltimaDoAluno(avisoRapido.desfazerAlunoId)}
                    style={{
                      background: "rgba(255,255,255,.18)",
                      color: "#fff",
                      border: "1px solid rgba(255,255,255,.5)",
                      borderRadius: 8,
                      padding: "4px 10px",
                      fontSize: 12,
                      fontWeight: 800,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    ↺ Desfazer
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <div style={mostrar360 && veTudo ? { display: "none" } : S.abas} role="tablist">
        <button
          type="button"
          onClick={() => setSomenteFocoDia((atual) => !atual)}
          style={{
            border: "none",
            borderRadius: 10,
            padding: "9px 16px",
            fontSize: 13,
            fontWeight: 800,
            cursor: "pointer",
            marginRight: 10,
            background: somenteFocoDia ? "#dc2626" : "#fef2f2",
            color: somenteFocoDia ? "#fff" : "#dc2626",
            boxShadow: somenteFocoDia ? "0 4px 14px rgba(220,38,38,0.35)" : "none",
          }}
        >
          🎯 Foco do Dia
        </button>
        <div style={{ display: "flex", background: "#f1f5f9", borderRadius: 10, padding: 3, marginRight: 10 }}>
          <button
            type="button"
            onClick={() => setVisao("lista")}
            style={{
              border: "none",
              borderRadius: 8,
              padding: "7px 14px",
              fontSize: 12.5,
              fontWeight: 800,
              cursor: "pointer",
              background: visao === "lista" ? "#fff" : "transparent",
              color: visao === "lista" ? "#2563eb" : "#64748b",
              boxShadow: visao === "lista" ? "0 1px 2px rgba(16,24,40,0.08)" : "none",
            }}
          >
            📋 Lista
          </button>
          <button
            type="button"
            onClick={() => setVisao("kanban")}
            style={{
              border: "none",
              borderRadius: 8,
              padding: "7px 14px",
              fontSize: 12.5,
              fontWeight: 800,
              cursor: "pointer",
              background: visao === "kanban" ? "#fff" : "transparent",
              color: visao === "kanban" ? "#2563eb" : "#64748b",
              boxShadow: visao === "kanban" ? "0 1px 2px rgba(16,24,40,0.08)" : "none",
            }}
          >
            🗂️ Kanban
          </button>
        </div>
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
      ) : veTudo && mostrar360 ? (
        <>
          <VisaoGeralCarteira email={emailEscopo()} />
          <VisaoGestao360 />
        </>
      ) : (
        <>
          {(!veTudo || operadorFiltro !== "TODOS") && retornosPendentes.length > 0 && (
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

          {!veTudo && desempenho && (
            <div style={S.desWrap}>
              <div style={S.desHeader}>Meu desempenho operacional</div>
              <div style={S.desRow}>
                <button type="button" style={{ ...S.desItem, ...(filtroKpi === "ativos" ? S.desItemAtivo : {}) }} onClick={() => onKpiClick("ativos")} title="Ver casos ativos">
                  <span style={S.desNum}>{desempenho.ativos}</span>
                  <span style={S.desRot}>Casos ativos</span>
                </button>
                <button type="button" style={{ ...S.desItem, ...(filtroKpi === "acionadosHoje" ? S.desItemAtivo : {}) }} onClick={() => onKpiClick("acionadosHoje")} title="CPFs que você tabulou hoje">
                  <span style={S.desNum}>{desempenho.acionadosHoje}</span>
                  <span style={S.desRot}>CPFs acionados hoje</span>
                </button>
                <button type="button" style={{ ...S.desItem, ...(filtroKpi === "semPrimeiroAcionamento" ? S.desItemAtivo : {}) }} onClick={() => onKpiClick("semPrimeiroAcionamento")} title="Casos ativos sem primeira tabulação">
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

          <div style={S.kpiGrid} className="pc-kpis">
            {kpiCards.map((k) => {
              // Todos os cards sao clicaveis e abrem a listagem filtrada.
              const filtravel = true;
              const ativoK = k.arquivo ? quitadosModal : k.id === "agenda" ? mostrarAgenda : filtroKpi === k.id;
              return (
                <div
                  key={k.id}
                  onClick={filtravel ? () => (k.arquivo ? abrirQuitados() : onKpiClick(k.id)) : undefined}
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

          {mostrarAgenda && (
            <div style={S.agendaPainel}>
              <div style={S.agendaHead}>
                <span style={S.agendaTitulo}>🗓️ Agenda — retornos ({agendaPendentes.length})</span>
                <button type="button" style={S.agendaFechar} onClick={() => setMostrarAgenda(false)}>
                  Fechar ✕
                </button>
              </div>
              {agendaPendentes.length === 0 ? (
                <p style={S.agendaVazia}>Nenhum retorno pendente. 🎉</p>
              ) : (
                <div style={S.agendaLista}>
                  {agendaPendentes.map((a) => {
                    const ret = String(a.data_retorno).slice(0, 10);
                    const hoje = hojeLocalBR();
                    const atrasado = ret < hoje;
                    const ehHoje = ret === hoje;
                    const partes = ret.split("-");
                    const dataBR = partes.length === 3 ? `${partes[2]}/${partes[1]}/${partes[0]}` : ret;
                    const hora = a.hora_retorno ? String(a.hora_retorno).slice(0, 5) : null;
                    return (
                      <div
                        key={a.id}
                        style={{
                          ...S.agendaItem,
                          ...(atrasado ? S.agendaItemAtrasado : ehHoje ? S.agendaItemHoje : {}),
                        }}
                      >
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <button type="button" style={S.agendaNome} onClick={() => abrirModal(a)} title="Abrir ficha">
                            {a.nome_aluno || a.nome || "Aluno"}
                          </button>
                          <div style={S.agendaMeta}>
                            <span style={{ color: atrasado ? "#dc2626" : ehHoje ? "#7c3aed" : "#475569", fontWeight: 700 }}>
                              {atrasado ? "⚠️ Atrasado · " : ehHoje ? "Hoje · " : ""}
                              {dataBR}
                              {hora ? ` às ${hora}` : ""}
                            </span>
                          </div>
                        </div>
                        <button
                          type="button"
                          style={S.agendaConfirmar}
                          disabled={confirmandoRetorno === a.id}
                          onClick={() => confirmarRetornoAgenda(a.id, true)}
                          title="Marcar retorno como tratado"
                        >
                          {confirmandoRetorno === a.id ? "…" : "✓ Confirmar"}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

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
                <option value="Novo">Novo</option>
                <option value="Dentro do prazo">Dentro do prazo</option>
                <option value="Atencao">Atencao</option>
                <option value="Critico">Critico</option>
                <option value="Perdendo o caso">Perdendo o caso</option>
                <option value="Aguardando pgto">Aguardando pgto</option>
                <option value="Pago parcial">Pago parcial (ainda deve)</option>
                <option value="Juridico">Juridico</option>
              </select>
              <select
                style={S.select}
                value={filtroTabulacao}
                onChange={(e) => setFiltroTabulacao(e.target.value)}
                title="Filtrar por tabulação (desfecho do acionamento) — acompanhar retorno de termos e links"
              >
                <option value="TODAS">Todas as tabulações</option>
                {OPCOES_TABULACAO.map((g) => (
                  <optgroup key={g.grupo} label={g.grupo}>
                    {g.itens.map((s) => (
                      <option key={s} value={s}>{labelStatus(s)}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <input
                style={{ ...S.select, width: 110 }}
                placeholder="Valor mín."
                value={filtroValorMin}
                onChange={(e) => setFiltroValorMin(e.target.value)}
              />
              <input
                style={{ ...S.select, width: 110 }}
                placeholder="Valor máx."
                value={filtroValorMax}
                onChange={(e) => setFiltroValorMax(e.target.value)}
              />
              <input
                style={{ ...S.select, width: 140 }}
                type="number"
                min="0"
                placeholder="Dias mín. sem contato"
                value={filtroDiasMinSemContato}
                onChange={(e) => setFiltroDiasMinSemContato(e.target.value)}
              />
              <select
                style={S.select}
                value={filtroAnoVencimento}
                onChange={(e) => setFiltroAnoVencimento(e.target.value)}
              >
                <option value="">Todos os anos de vencimento</option>
                <option value="2023">Vencimento 2023</option>
                <option value="2024">Vencimento 2024</option>
                <option value="2025">Vencimento 2025</option>
                <option value="2026">Vencimento 2026</option>
              </select>
              <button
                type="button"
                onClick={() => setSomenteFixados((atual) => !atual)}
                style={{
                  ...S.select,
                  cursor: "pointer",
                  fontWeight: 700,
                  background: somenteFixados ? "#fff7e6" : "#fff",
                  borderColor: somenteFixados ? "#f5c542" : undefined,
                  color: somenteFixados ? "#7c4a1e" : undefined,
                }}
              >
                📌 Fixados {fixados.size > 0 ? `(${fixados.size})` : ""}
              </button>
              <button
                type="button"
                onClick={iniciarGuiado}
                disabled={guiado || listaFiltrada.length === 0}
                title="Abre os casos da fila inteligente um a um. O proximo so abre depois de tabular."
                style={{ ...S.btnPrimario, padding: "8px 14px", opacity: guiado || listaFiltrada.length === 0 ? 0.6 : 1 }}
              >
                ▶ Iniciar acionamento
              </button>
              <select style={S.select} value={ordenacao} onChange={(e) => setOrdenacao(e.target.value)}>
                <option value="inteligente">🧠 Fila inteligente</option>
                <option value="prioridade">Prioridade (o que acionar)</option>
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
            {guiadoConcluido && (
              <div style={S.guiadoBanner} role="status">
                🎉 Fila do dia concluida: {guiadoConcluido.acionados} {guiadoConcluido.acionados === 1 ? "aluno acionado" : "alunos acionados"} nesta rodada.
                <button type="button" style={S.guiadoBannerFechar} onClick={() => setGuiadoConcluido(null)} aria-label="Fechar">✕</button>
              </div>
            )}

            {visao === "kanban" ? (
              <div style={{ display: "flex", gap: 14, overflowX: "auto", paddingBottom: 10 }}>
                {kanbanColunas.map((col) => (
                  <div
                    key={col.chave}
                    onDragOver={(e) => {
                      if (col.chave === "SEM_ACIONAMENTO" || col.chave === "OUTROS") return;
                      e.preventDefault();
                      setColunaSobre(col.chave);
                    }}
                    onDragLeave={() => setColunaSobre((c) => (c === col.chave ? null : c))}
                    onDrop={async (e) => {
                      e.preventDefault();
                      setColunaSobre(null);
                      if (!arrastandoId) return;
                      const aluno = listaFiltrada.find((x) => x.id === arrastandoId);
                      setArrastandoId(null);
                      if (aluno) await moverParaColuna(aluno, col);
                    }}
                    style={{
                      background: colunaSobre === col.chave ? "#dbeafe" : "#eef1f6",
                      borderRadius: 14, padding: 12, minWidth: 250, flexShrink: 0, maxHeight: 640, display: "flex", flexDirection: "column",
                      transition: "background 0.12s ease",
                      border: colunaSobre === col.chave ? "2px dashed #2563eb" : "2px dashed transparent",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, padding: "0 4px" }}>
                      <span style={{ fontWeight: 800, fontSize: 12, textTransform: "uppercase", letterSpacing: "0.03em", color: "#334155" }}>{col.titulo}</span>
                      <span style={{ background: "#fff", borderRadius: 999, padding: "2px 9px", fontSize: 11, fontWeight: 800, color: "#2563eb" }}>{col.itens.length}</span>
                    </div>
                    <div style={{ overflowY: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
                      {col.itens.map((a) => {
                        const sp = statusPrazo(a);
                        const feitoHoje = trabalhadoHoje(a);
                        return (
                          <div
                            key={a.id}
                            draggable
                            title={feitoHoje ? "Ja trabalhado hoje" : undefined}
                            onDragStart={() => setArrastandoId(a.id)}
                            onDragEnd={() => { setArrastandoId(null); setColunaSobre(null); }}
                            onClick={() => abrirModal(a)}
                            style={{
                              background: feitoHoje ? COR_TRABALHADO_HOJE : "#fff", borderRadius: 12, padding: "12px 13px", border: "1px solid #e6eaf0",
                              borderLeft: `3px solid ${sp.cor}`, boxShadow: "0 1px 2px rgba(16,24,40,0.05)", cursor: "grab",
                              opacity: arrastandoId === a.id ? 0.4 : 1,
                            }}
                          >
                            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>{nomeAluno(a)}</div>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11.5, color: "#64748b" }}>
                              <span style={{ fontWeight: 800, color: "#1e40af" }}>{formatarMoeda(saldoDe(a))}</span>
                              <span>{formatarData(a.data_ultimo_acionamento) || "Nunca"}</span>
                            </div>
                          </div>
                        );
                      })}
                      {col.itens.length === 0 && (
                        <div style={{ fontSize: 12, color: "#94a3b8", textAlign: "center", padding: "16px 0" }}>vazio</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <>
            <div style={S.tabelaWrap}>
              <table style={S.tabela} className="pc-tabela">
                <thead>
                  <tr>
                    <th style={S.th}>Nome</th>
                    <th style={S.th}>CPF</th>
                    <th style={S.th}>Situacao</th>
                    <th style={S.th}>Ult. contato</th>
                    <th style={S.th}>Prox. contato</th>
                    <th style={S.thNum}>Valor aberto</th>
                    <th style={S.th}>Status</th>
                    <th style={S.th}>Ação rápida</th>
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
                    const feitoHoje = trabalhadoHoje(a);
                    return (
                      <tr
                        key={a.id}
                        title={feitoHoje ? "Ja trabalhado hoje" : undefined}
                        style={{
                          ...S.tr,
                          borderLeft: `4px solid ${sp.cor}`,
                          // Sem destaque nao fixa cor nenhuma: no celular a
                          // linha vira card e o branco vem do CSS.
                          background: feitoHoje ? COR_TRABALHADO_HOJE : undefined,
                        }}
                        onMouseEnter={(e) =>
                          (e.currentTarget.style.background = feitoHoje ? COR_TRABALHADO_HOJE_HOVER : "#f8fafc")
                        }
                        onMouseLeave={(e) =>
                          (e.currentTarget.style.background = feitoHoje ? COR_TRABALHADO_HOJE : "")
                        }
                        onClick={() => abrirModal(a)}
                      >
                        <td style={S.td} data-label="Nome">
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <button
                              type="button"
                              onClick={(e) => alternarFixado(a.id, e)}
                              title={fixados.has(a.id) ? "Desafixar" : "Fixar caso"}
                              style={{
                                background: "none",
                                border: "none",
                                cursor: "pointer",
                                fontSize: 15,
                                opacity: fixados.has(a.id) ? 1 : 0.25,
                                lineHeight: 1,
                                padding: 0,
                              }}
                            >
                              📌
                            </button>
                            <div style={S.nomeCel}>{nomeAluno(a)}</div>
                            <button
                              type="button"
                              onClick={(e) => copiarNome(a, e)}
                              title="Copiar nome"
                              style={{
                                background: "none",
                                border: "none",
                                cursor: "pointer",
                                fontSize: 13,
                                lineHeight: 1,
                                padding: 0,
                                color: nomeCopiadoId === a.id ? "#16a34a" : "#94a3b8",
                              }}
                            >
                              {nomeCopiadoId === a.id ? "✓" : "📋"}
                            </button>
                          </div>
                          <div style={S.subCel}>
                            {[a.telefone, a.unidade, a.curso].filter(Boolean).join(" · ") || "-"}
                          </div>
                          {(() => {
                            const st = seloTermoLink(a);
                            if (!st) return null;
                            return (
                              <div
                                style={{
                                  display: "inline-block",
                                  marginTop: 4,
                                  background: st.bg,
                                  color: st.cor,
                                  borderRadius: 6,
                                  padding: "2px 7px",
                                  fontSize: 11,
                                  fontWeight: 700,
                                }}
                              >
                                {st.emoji} {st.texto}
                              </div>
                            );
                          })()}
                          {String(a.status_atual) === "JURIDICO" && (
                            <div style={{ ...S.subCel, color: "#7c3aed", fontWeight: 600 }}>
                              {a.processo_numero && String(a.processo_numero).trim()
                                ? `Jurídico · Processo nº ${a.processo_numero}`
                                : "Jurídico · Processo não informado"}
                            </div>
                          )}
                          {(() => {
                            const sug = sugestaoDoCaso(a, fa && fa.menorVencimento, hojeLocalBR());
                            if (!sug) return null;
                            return (
                              <div
                                style={{
                                  display: "inline-block",
                                  marginTop: 4,
                                  background: sug.bg,
                                  color: sug.cor,
                                  borderRadius: 6,
                                  padding: "2px 7px",
                                  fontSize: 11,
                                  fontWeight: 700,
                                }}
                              >
                                {sug.emoji} {sug.texto}
                              </div>
                            );
                          })()}
                          {ordenacao === "inteligente" && fa && (fa.acordos || 0) > 0 && (() => {
                            const selo = seloFila(a, hojeLocalBR());
                            if (!selo) return null;
                            return (
                              <div
                                style={{
                                  display: "inline-block",
                                  marginTop: 4,
                                  marginLeft: 4,
                                  background: selo.bg,
                                  color: selo.cor,
                                  borderRadius: 6,
                                  padding: "2px 7px",
                                  fontSize: 11,
                                  fontWeight: 700,
                                }}
                              >
                                {selo.emoji} {selo.texto}
                              </div>
                            );
                          })()}
                          {/* Criticidade CANONICA do backend (recalcular_situacao_aluno):
                              a fonte da verdade para "o que acionar". Nao mostra
                              selo para NORMAL, so para o que exige acao. */}
                          {mostrarSeloCriticidade(a) && (
                            <div
                              style={{
                                display: "inline-block",
                                marginTop: 4,
                                background: CRITICIDADE_LABEL[critCanon(a)].bg,
                                color: CRITICIDADE_LABEL[critCanon(a)].cor,
                                borderRadius: 6,
                                padding: "2px 7px",
                                fontSize: 11,
                                fontWeight: 800,
                                letterSpacing: 0.3,
                              }}
                            >
                              {CRITICIDADE_LABEL[critCanon(a)].texto}
                            </div>
                          )}
                          {/* Situacao operacional + proxima acao autoritativas
                              (recalcular_situacao_aluno). A proxima_acao ja vem
                              como texto pronto do banco. */}
                          {a.situacao_operacional && SITUACAO_OPERACIONAL_LABEL[a.situacao_operacional] && (
                            <div
                              style={{
                                display: "inline-block",
                                marginTop: 4,
                                marginLeft: 4,
                                background: SITUACAO_OPERACIONAL_LABEL[a.situacao_operacional].bg,
                                color: SITUACAO_OPERACIONAL_LABEL[a.situacao_operacional].cor,
                                borderRadius: 6,
                                padding: "2px 7px",
                                fontSize: 11,
                                fontWeight: 700,
                              }}
                            >
                              {SITUACAO_OPERACIONAL_LABEL[a.situacao_operacional].texto}
                            </div>
                          )}
                          {a.proxima_acao && (
                            <div style={{ ...S.subCel, marginTop: 4, color: "#334155", fontWeight: 600 }}>
                              {a.proxima_acao}
                            </div>
                          )}
                        </td>
                        <td style={S.td} data-label="CPF">{a.cpf || "-"}</td>
                        <td style={S.td} data-label="Situação">
                          <span style={S.badgeSituacao}>{situacaoLabel(a)}</span>
                        </td>
                        <td style={S.td} data-label="Últ. contato">{formatarData(a.data_ultimo_acionamento || a.ultimo_contato)}</td>
                        <td style={S.td} data-label="Próx. contato">{formatarData(a.data_retorno)}</td>
                        <td style={S.tdValor} data-label="Valor aberto">
                          {temDet ? (
                            <div style={S.emAbertoBox}>
                              <div style={{ ...S.emAbertoTotal, color: corTotal }}>
                                Em aberto: {formatarMoeda(fa.total)}
                              </div>
                              <div style={S.emAbertoSub}>Mensalidades: {formatarMoeda(fa.mensalidades)}</div>
                            <div style={S.emAbertoSub}>Mensalidades (originais): {formatarMoeda(saldoDe(a))}</div>
                            <div style={S.emAbertoSub}>Titulos em aberto: {qtdTitulosDe(a)}</div>
                              <div style={S.emAbertoSub}>Acordos: {formatarMoeda(fa.acordos)}</div>
                              {fa.qtdNegociadas > 0 && (
                                <div style={S.emAbertoSub}>
                                  Negociadas em acordo: {formatarMoeda(fa.negociadas)} ({fa.qtdNegociadas}) — já
                                  contabilizadas em Acordos
                                </div>
                              )}
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
                        <td style={S.td} data-label="Status">
                          <span style={{ ...S.badgeStatus, color: sp.cor }}>
                            <span style={{ ...S.bolinha, background: sp.cor }} />
                            {sp.label}
                          </span>
                        </td>
                        <td style={S.td} data-label="Ação rápida">
                          <button
                            type="button"
                            disabled={tabulandoIds.has(a.id)}
                            onClick={(e) => tabularRapido(a, "MENSAGEM_ENVIADA", "Mensagem enviada", e)}
                            style={{
                              opacity: tabulandoIds.has(a.id) ? 0.6 : 1,
                              background: "#2563eb",
                              color: "#fff",
                              border: "none",
                              borderRadius: 8,
                              padding: "6px 10px",
                              fontSize: 11.5,
                              fontWeight: 700,
                              cursor: "pointer",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {tabulandoIds.has(a.id) ? "Registrando..." : "✅ Mensagem enviada"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {listaFiltrada.length === 0 && (
                    <tr>
                      <td style={S.vazio} colSpan={8}>
                        {carregando || carregandoEspecial ? "Carregando..." : "Nenhum caso encontrado"}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <p style={S.rodapeTabela}>
              Mostrando {listaFiltrada.length} de {casos.length} casos carregados. Clique numa linha para abrir o atendimento.
              {" "}
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                <span
                  style={{
                    width: 12,
                    height: 12,
                    borderRadius: 3,
                    background: COR_TRABALHADO_HOJE,
                    border: `1px solid ${COR_TRABALHADO_HOJE_HOVER}`,
                    display: "inline-block",
                  }}
                />
                Linhas em azul claro = ja acionadas hoje.
              </span>
            </p>
              </>
            )}
          </div>
        </>
      )}

      {/* ---- Modal operacional ---- */}
      {modalAberto && alunoModal && (
        <div style={S.overlay} onClick={fecharModal}>
          <div
            style={S.modal}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            onKeyDown={(e) => {
              // Atalho do acionamento guiado: Ctrl/Cmd+Enter = Finalizar atendimento.
              if (guiado && abaModal === "negociacao" && e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                finalizarAtendimento();
              }
            }}
          >
            <div style={S.modalHeader}>
              <div style={{ minWidth: 0 }}>
                {guiado && (
                  <div style={S.guiadoSelo}>
                    ▶ Acionamento guiado · {guiadoAcionados} {guiadoAcionados === 1 ? "acionado" : "acionados"} · faltam {Math.max(0, listaFiltrada.filter((x) => !guiadoFeitosRef.current.has(String(x.id)) && !acionadosHojeIds.map(String).includes(String(x.id))).length)}
                  </div>
                )}
                <h2 style={{ ...S.modalNome, display: "flex", alignItems: "center", gap: 8 }}>
                  <span>{nomeAluno(alunoModal)}</span>
                  <button
                    type="button"
                    onClick={(e) => copiarNome(alunoModal, e)}
                    title="Copiar nome do aluno"
                    aria-label="Copiar nome do aluno"
                    style={S.btnCopiarNome}
                  >
                    {nomeCopiadoId === alunoModal.id ? "✓ copiado" : "📋 copiar"}
                  </button>
                </h2>
                <div style={S.modalSub}>
                  {alunoModal.cpf || "-"} · {alunoModal.telefone || "sem telefone"} ·{" "}
                  <span style={{ color: statusPrazo(alunoModal).cor, fontWeight: 700 }}>
                    {statusPrazo(alunoModal).label}
                  </span>
                </div>
              </div>
              <button style={S.btnFechar} onClick={fecharModal} aria-label={guiado ? "Sair do acionamento guiado" : "Fechar"} title={guiado ? "Sair do acionamento guiado" : "Fechar"}>
                {guiado ? "Sair ✕" : "✕"}
              </button>
            </div>

            <div style={{ padding: "0 16px" }}>
              <DadosAcademicos aluno={alunoModal} />
              <PainelDesfazer
                alunoId={alunoModal?.id}
                atualizarEm={desfazerTick}
                onDesfeito={() => {
                  atualizarTudo(alunoModal.id);
                  carregar();
                }}
              />
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
                        <div style={S.infoRot}>Responsável pelo aluno</div>
                        <div style={S.infoVal}>
                          {alunoModal.responsavel_atual_nome || "Sem responsável"}
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
                        <div style={S.infoRot}>Responsável pelo aluno</div>
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

              {abaModal === "adm" && (
                <div style={S.secao}>
                  <div style={S.infoBox}>
                    <div style={S.infoRot}>Responsável pelo aluno</div>
                    {!editandoOperador ? (
                      <div style={S.infoVal}>
                        {alunoModal.responsavel_atual_nome || "Sem responsável"}
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
                    ) : (
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
                    )}
                  </div>
                  {!veTudo && (
                    <p style={S.subCel}>Só quem gerencia pode trocar o operador responsável.</p>
                  )}
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

                  {lembreteParcelaDevido(alunoModal) && (
                    <div style={S.lembreteBox}>
                      <div style={S.lembreteTitulo}>🔔 Lembrete de parcela</div>
                      <div style={S.lembreteTexto}>
                        {alunoModal.proxima_acao || "Acordo em dia: lembrar o aluno da proxima parcela."}
                      </div>
                      <div style={S.lembreteDica}>
                        Agendado automaticamente 2 dias antes do vencimento. Depois de tabular, o caso fica em silencio ate a parcela vencer.
                      </div>
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
                    <button style={S.btnPrimario} onClick={finalizarAtendimento} disabled={salvando} title={guiado ? "Ctrl+Enter. No acionamento guiado, salvar abre o proximo aluno." : undefined}>
                      {salvando ? "Salvando..." : guiado ? "Finalizar e abrir o proximo ▶" : "Finalizar atendimento"}
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

                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "20px 0 10px" }}>
                    <h3 style={{ margin: 0 }}>Histórico</h3>
                    <button
                      type="button"
                      onClick={exportarHistoricoPDF}
                      style={{
                        background: "#fff",
                        border: "1px solid #cbd5e1",
                        borderRadius: 8,
                        padding: "6px 12px",
                        fontSize: 12,
                        fontWeight: 700,
                        color: "#334155",
                        cursor: "pointer",
                      }}
                    >
                      📄 Exportar PDF
                    </button>
                  </div>
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

              {abaModal === "email" && (
                <div style={S.secao}>
                  <EmailAlunoUnificado aluno={alunoModal} />
                </div>
              )}

              {abaModal === "financeiro" && (
                <div style={S.secao}>
                  <FinanceiroAluno aluno={alunoModal} />
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

      {quitadosModal && (
        <div style={S.overlay} onClick={() => setQuitadosModal(false)}>
          <div style={{ ...S.modal, maxWidth: 1040 }} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <div style={S.modalHeader}>
              <div style={{ minWidth: 0 }}>
                <h2 style={S.modalNome}>Quitados (arquivo)</h2>
                <div style={S.modalSub}>
                  {carregandoQuitados
                    ? "Carregando…"
                    : `${quitadosLista.length} caso(s) quitado(s) · Total quitado: ${formatarMoeda(quitadosLista.reduce((s, r) => s + (Number(r.valor_quitado) || 0), 0))}`}
                  {operadorFiltro && operadorFiltro !== "TODOS" ? ` · ${nomeOperadorPorEmail(operadorFiltro)}` : ""}
                  {" · Somente leitura (fora da fila)"}
                </div>
              </div>
              <button style={S.btnFechar} onClick={() => setQuitadosModal(false)} aria-label="Fechar">✕</button>
            </div>
            <div style={S.modalBody}>
              <div style={S.tabelaWrap}>
                <table style={S.tabela}>
                  <thead>
                    <tr>
                      <th style={S.th}>Aluno</th>
                      <th style={S.th}>Data da quitacao</th>
                      <th style={S.thNum}>Valor quitado</th>
                      <th style={S.th}>Origem</th>
                      <th style={S.th}>Operador</th>
                    </tr>
                  </thead>
                  <tbody>
                    {quitadosLista.map((r, i) => (
                      <tr key={`${r.aluno_id || r.cpf || "q"}-${i}`} style={S.tr}>
                        <td style={S.td}>{r.nome || r.nome_aluno || "-"}</td>
                        <td style={S.td}>{formatarData(r.quitado_em)}</td>
                        <td style={S.tdNum}>{formatarMoeda(Number(r.valor_quitado) || 0)}</td>
                        <td style={S.td}>{labelOrigemQuitacao(r)}</td>
                        <td style={S.td}>{nomeOperadorPorEmail(r.operador_email)}</td>
                      </tr>
                    ))}
                    {!carregandoQuitados && quitadosLista.length === 0 && (
                      <tr><td style={S.vazio} colSpan={5}>Nenhum caso quitado no recorte atual.</td></tr>
                    )}
                  </tbody>
                  {quitadosLista.length > 0 && (
                    <tfoot>
                      <tr>
                        <td style={S.tdTotal} colSpan={2}>Total</td>
                        <td style={S.tdNumTotal}>{formatarMoeda(quitadosLista.reduce((s, r) => s + (Number(r.valor_quitado) || 0), 0))}</td>
                        <td style={S.td} colSpan={2}></td>
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
  .pc-root { --pc-brand: #1e40af; --pc-ink: #101828; }
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

    /* Tabela vira lista de cards no celular -- linha inteira (nome, CPF,
       situacao, valor, status) fica visivel de uma vez, sem precisar
       rolar pra lados nem apertar em cima de texto cortado. Resolve
       nomes repetidos (ex: 3 "Vitoria da Silva") ficarem indistinguiveis
       e dificeis de tocar certo. */
    .pc-tabela thead { display: none; }
    .pc-tabela, .pc-tabela tbody, .pc-tabela tr, .pc-tabela td { display: block; width: 100%; }
    .pc-tabela tr {
      background: #fff;
      border: 1px solid #edf0f5;
      border-radius: 14px;
      margin-bottom: 10px;
      padding: 12px 14px;
      box-shadow: 0 1px 2px rgba(16,24,40,0.04);
    }
    .pc-tabela td {
      padding: 6px 0 !important;
      border: none !important;
      text-align: left !important;
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 10px;
    }
    .pc-tabela td[data-label="Nome"] { flex-direction: column; align-items: flex-start; padding-bottom: 8px !important; border-bottom: 1px solid #f2f4f7 !important; margin-bottom: 4px; }
    .pc-tabela td[data-label]::before {
      content: attr(data-label);
      font-size: 10.5px;
      font-weight: 700;
      color: #98a2b3;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      flex-shrink: 0;
      padding-top: 2px;
    }
    .pc-tabela td[data-label="Nome"]::before { display: none; }
    .pc-tabela td[data-label="Valor aberto"] > div { align-items: flex-end; text-align: right; }
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
  agendaPainel: { background: "#fff", borderRadius: 16, padding: "16px 18px", border: "1px solid #ede9fe", boxShadow: SOMBRA_CARD, marginBottom: 18 },
  agendaHead: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  agendaTitulo: { fontSize: 14.5, fontWeight: 800, color: "#5b21b6" },
  agendaFechar: { background: "#f3f4f6", border: "none", borderRadius: 8, padding: "5px 12px", fontSize: 12, fontWeight: 700, color: "#475569", cursor: "pointer" },
  agendaVazia: { margin: "6px 0", fontSize: 13, color: "#64748b" },
  agendaLista: { display: "flex", flexDirection: "column", gap: 8, maxHeight: 360, overflowY: "auto" },
  agendaItem: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 12px", borderRadius: 12, border: "1px solid #eef2f7", background: "#fafbfc" },
  agendaItemHoje: { border: "1px solid #ddd6fe", background: "#f5f3ff" },
  agendaItemAtrasado: { border: "1px solid #fecaca", background: "#fef2f2" },
  agendaNome: { background: "none", border: "none", padding: 0, fontSize: 13.5, fontWeight: 700, color: "#1e293b", cursor: "pointer", textAlign: "left", textDecoration: "underline", textDecorationColor: "#cbd5e1", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%" },
  agendaMeta: { fontSize: 11.5, marginTop: 2 },
  agendaConfirmar: { background: "#7c3aed", color: "#fff", border: "none", borderRadius: 9, padding: "7px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" },
  cabecalho: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, marginBottom: 22, flexWrap: "wrap" },
  titulo: { margin: 0, marginBottom: 3, color: "#0d1321", fontSize: 26, fontWeight: 800, letterSpacing: "-0.03em", fontFamily: FONTE_TITULO },
  subtitulo: { margin: 0, color: "#8a93a3", fontSize: 13.5 },
  userChip: { display: "flex", flexDirection: "column", alignItems: "flex-end", lineHeight: 1.2, padding: "6px 14px", background: "#fff", border: `1px solid ${COR_BORDA}`, borderRadius: 12, boxShadow: SOMBRA_CARD },
  userNome: { fontWeight: 700, color: "#101828", fontSize: 13 },
  userRole: { fontSize: 10, color: "#1e40af", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" },
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
  desItemAtivo: { borderColor: "#1e40af", background: "#eff6ff", boxShadow: "0 0 0 2px rgba(15,157,107,0.14)" },
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
  chipFiltro: { display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", background: "#e9f9f1", color: "#1e40af", border: "1px solid #c7d7fe", borderRadius: 999, padding: "6px 13px", fontSize: 11.5, fontWeight: 700 },
  tabelaWrap: { overflowX: "auto", borderRadius: 12 },
  tabela: { width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 13 },
  th: { textAlign: "left", padding: "11px 12px", color: "#8a93a3", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", background: "#f8fafc", borderBottom: `1px solid ${COR_BORDA}`, whiteSpace: "nowrap" },
  thNum: { textAlign: "right", padding: "11px 12px", color: "#8a93a3", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", background: "#f8fafc", borderBottom: `1px solid ${COR_BORDA}`, whiteSpace: "nowrap" },
  tr: { cursor: "pointer", borderBottom: `1px solid ${COR_BORDA_SUAVE}`, transition: "background 0.12s ease" },
  td: { padding: "14px 14px", color: "#475569", verticalAlign: "middle" },
  tdNum: { padding: "11px 10px", color: "#1e293b", textAlign: "right", whiteSpace: "nowrap", fontWeight: 600 },
  tdTotal: { padding: "11px 10px", color: "#1e293b", fontWeight: 700, borderTop: `2px solid ${COR_BORDA}`, textAlign: "right" },
  tdNumTotal: { padding: "11px 10px", color: "#1e40af", textAlign: "right", whiteSpace: "nowrap", fontWeight: 800, borderTop: `2px solid ${COR_BORDA}` },
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
  modalAbaAtiva: { color: "#1e40af", borderBottom: "2px solid #1e40af" },
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
  btnSalvarOperador: { border: "none", background: "#1e40af", color: "#fff", borderRadius: 8, padding: "5px 9px", fontSize: 12, fontWeight: 700, cursor: "pointer" },
  btnCancelarOperador: { border: "1px solid #cbd5e1", background: "#fff", color: "#475569", borderRadius: 8, padding: "5px 9px", fontSize: 12, cursor: "pointer" },
  label: { fontSize: 12, fontWeight: 700, color: "#475569", marginTop: 4 },
  input: { padding: "10px 12px", borderRadius: 10, border: `1px solid ${COR_BORDA}`, fontSize: 13, background: "#fff", color: "#344054" },
  textarea: { padding: "10px 12px", borderRadius: 10, border: `1px solid ${COR_BORDA}`, fontSize: 13, minHeight: 70, resize: "vertical", fontFamily: "inherit", background: "#fff", color: "#344054" },
  proximaAcao: { fontSize: 12.5, color: "#667085", background: "#f9fafc", border: `1px solid ${COR_BORDA_SUAVE}`, borderRadius: 10, padding: "9px 13px" },
  acoesLinha: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 },
  btnCopiarNome: { background: "#eef2ff", color: "#1e40af", border: "1px solid #c7d2fe", borderRadius: 8, padding: "2px 8px", fontSize: 11, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" },
  guiadoBanner: { marginTop: 10, padding: "10px 14px", borderRadius: 10, background: "#ecfdf5", border: "1px solid #6ee7b7", color: "#065f46", fontSize: 13, fontWeight: 700, display: "flex", alignItems: "center", gap: 10 },
  guiadoBannerFechar: { marginLeft: "auto", background: "transparent", border: "none", cursor: "pointer", color: "#065f46", fontWeight: 700 },
  guiadoSelo: { display: "inline-block", marginBottom: 6, padding: "3px 10px", borderRadius: 999, background: "#1e40af", color: "#fff", fontSize: 11, fontWeight: 800, letterSpacing: 0.3 },
  lembreteBox: { marginBottom: 12, padding: "10px 12px", borderRadius: 10, background: "#ecfdf5", border: "1px solid #6ee7b7" },
  lembreteTitulo: { fontSize: 13, fontWeight: 800, color: "#065f46" },
  lembreteTexto: { fontSize: 13, color: "#064e3b", marginTop: 4 },
  lembreteDica: { fontSize: 11, color: "#047857", marginTop: 6 },
  btnPrimario: { background: "#1e40af", color: "#fff", border: "none", borderRadius: 10, padding: "10px 18px", fontSize: 13, fontWeight: 700, cursor: "pointer" },
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
