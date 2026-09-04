import { useEffect, useState, useCallback, useRef } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { supabase } from "../services/supabase";
import { podeVerTudo } from "../utils/operadores";
import { rotuloStatusComSaldo, rotuloStatus } from "../utils/rotulosStatus";
import FinalizacaoTermo from "../components/FinalizacaoTermo";
import jsPDF from "jspdf";
import EnvioFinanceiro from "../components/EnvioFinanceiro";
import FinanceiroAluno from "../components/FinanceiroAluno";
import DadosAcademicos from "../components/DadosAcademicos";
import ConfirmarPagamento from "../components/ConfirmarPagamento";
import LinksPagamentoAluno from "../components/LinksPagamentoAluno";
import EmailAlunoUnificado from "../components/EmailAlunoUnificado";
import { carregarTabulacoes, desfechoDaTabulacao, retornoEhManual } from "../utils/tabulacoes";
import TelefonesAluno from "../components/TelefonesAluno";
import PainelDesfazer from "../components/PainelDesfazer";
import Dobra from "../ui/blocos";
import {
  superficie,
  cartao,
  cartaoInterno,
  cartaoTitulo as cardTituloUI,
  faixaMini as faixaMiniUI,
  itemMini as itemMiniUI,
  valorMini as valorMiniUI,
  cartaoSucesso,
} from "../ui/cards";
const OPERADORES_REATIVA = [
  { nome: "Fernanda Supervisora", email: "cobranca04@aelbra.com.br" },
  { nome: "Luana", email: "cobranca05@aelbra.com.br" },
  { nome: "Rafaella", email: "cobranca12@aelbra.com.br" },
  { nome: "Amanda ADM", email: "cobranca07@aelbra.com.br" },
  { nome: "Allan", email: "cobranca11@aelbra.com.br" },
  { nome: "Maurício", email: "cobranca06@aelbra.com.br" },
  { nome: "Olga", email: "cobranca03@aelbra.com.br" },
  { nome: "João", email: "cobranca10@aelbra.com.br" },
  { nome: "Diego", email: "cobranca13@aelbra.com.br" },
  { nome: "Natali", email: "cobranca08@aelbra.com.br" },
  { nome: "Amanda Seibel", email: "amanda.seibel@aelbra.com.br" },
];
const STATUS_FINALIZACAO = [
  "CONTATAR",
  "ELOGIO_ATENDIMENTO",
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
const STATUS_COM_PROCESSO = ["CANCELAMENTO_COBRANCA", "SUSPENSAO_COBRANCA", "JURIDICO"];
// Reaproveita toda a trava/renderização de "ficha bloqueada" que já existe
// pra Jurídico/Cancelamento -- só que este aqui é diferente dos outros
// dois: se subir um título novo desse aluno num bordero, ele volta a
// entrar na fila sozinho (os outros dois nunca voltam automaticamente).
const STATUS_QUITADO_MANUAL = "QUITADO_MANUAL";
// Casos já quitados (sem parcelas em aberto). A ficha desses fica em amarelo
// -- diferente do vermelho de Jurídico/Cancelamento -- porque não é um caso
// travado: se subir um título novo dele num bordero, ele volta pra fila.
const STATUS_QUITADOS = [STATUS_QUITADO_MANUAL, "QUITADO"];
// Emails que podem usar o botão de "Quitar tudo" -- deliberadamente mais
// restrito que podeVerTudo (que também inclui supervisão): só a Amanda.
const EMAILS_PODE_QUITAR_MANUAL = [
  "amanda.seibel@aelbra.com.br",
  "amandaseibel1706@gmail.com",
  "amandapradoseibel@gmail.com",
  "cobranca07@aelbra.com.br", // Amanda ADM
  "cobranca04@aelbra.com.br", // Fernanda (supervisão)
];
function podeQuitarManual(email) {
  return EMAILS_PODE_QUITAR_MANUAL.includes(String(email || "").toLowerCase().trim());
}
// Só gestão/supervisão (podeVerTudo) pode definir estes dois. Uma vez
// finalizado assim, o caso fica travado e destacado em vermelho.
const STATUS_BLOQUEADOS_ACIONAMENTO = [
  "CANCELAMENTO_COBRANCA",
  "SUSPENSAO_COBRANCA",
  "JURIDICO",
  STATUS_QUITADO_MANUAL,
];
const STATUS_BLOQUEADOS_LABEL = {
  ELOGIO_ATENDIMENTO: "Elogio de atendimento",
  CANCELAMENTO_COBRANCA: "Cancelamento definitivo de cobrança",
  SUSPENSAO_COBRANCA: "Suspensão de cobrança",
  JURIDICO: "Jurídico",
  QUITADO_MANUAL: "Quitado",
};
// Mapa TABULACAO -> BLOCO expansivel que deve abrir automaticamente ao
// selecionar a tabulacao. Usa os CODIGOS estaveis de STATUS_FINALIZACAO
// (nunca o texto visivel). Tabulacoes sem acao complementar ("" implicito)
// mantem todos os blocos fechados. A abertura automatica NAO executa nenhuma
// acao nem altera permissao -- so revela o formulario correspondente.
const TABULACAO_PARA_BLOCO = {
  // Link de pagamento (o fluxo de comprovante vive dentro deste bloco)
  AGUARDANDO_LINK: "link",
  SOLICITADO_LINK: "link",
  LINK_PRONTO_PARA_ENVIO: "link",
  AGUARDANDO_COMPROVANTE: "link",
  // Termo / negociacao / acordo
  TERMO_ENVIADO_ALUNO: "termo",
  TERMO_ENVIADO_ADM: "termo",
  TERMO_RECEBIDO_LIBERADO: "termo",
  TERMO_REJEITADO: "termo",
  ACORDO_FECHADO: "termo",
  // Enviar ao financeiro
  AGUARDANDO_BAIXA: "financeiro",
  // Confirmar pagamento / baixa (o componente aplica o guard de permissao)
  BAIXA_REALIZADA: "confirmar",
  BAIXA_DEVOLVIDA: "confirmar",
};
// Ordenação da lista de Alunos: ativos primeiro; QUITADOS, JURÍDICOS e
// CANCELADOS/SUSPENSOS por último. Retorna 0 (ativo) ou 1 (final).
function grupoFinalAluno(aluno) {
  const texto = [aluno?.status_atual, aluno?.status_jornada, aluno?.status_acionamento]
    .filter(Boolean)
    .join(" ")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase();
  const ehFinal =
    texto.includes("QUITAD") ||
    texto.includes("QUITACAO") ||
    texto.includes("JURIDICO") ||
    texto.includes("CANCEL");
  return ehFinal ? 1 : 0;
}
function formatarDataHora(data) {
  if (!data) return "-";
  try {
    // Datas "só data" (ex.: alunos.data_retorno, coluna date do Postgres,
    // sem horário) não podem passar por new Date() direto -- o parser
    // trata como UTC meia-noite e, ao converter pro fuso local (Brasil,
    // UTC-3), o dia "volta" um (ex.: 02/07 vira 01/07 21h).
    if (/^\d{4}-\d{2}-\d{2}$/.test(data)) {
      const [ano, mes, dia] = data.split("-");
      return `${dia}/${mes}/${ano}`;
    }
    return new Date(data).toLocaleString("pt-BR", {
      dateStyle: "short",
      timeStyle: "short",
    });
  } catch {
    return "-";
  }
}
function paraDataLocalBR(valor) {
  if (!valor) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(valor)) return valor;
  const data = new Date(valor);
  if (Number.isNaN(data.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(data);
}
function paraInputDateTime(data) {
  if (!data) return "";
  try {
    // Datas "só data" (ex.: alunos.data_retorno, coluna date sem horário)
    // não podem passar pelo new Date() genérico -- é tratado como UTC
    // meia-noite e o ajuste de fuso abaixo "volta" um dia (mesmo bug do
    // formatarDataHora, aqui no input de edição).
    if (/^\d{4}-\d{2}-\d{2}$/.test(data)) {
      return `${data}T00:00`;
    }
    const d = new Date(data);
    const offset = d.getTimezoneOffset();
    const local = new Date(d.getTime() - offset * 60000);
    return local.toISOString().slice(0, 16);
  } catch {
    return "";
  }
}
function pegarCampo(objeto, campos, padrao = "-") {
  for (const campo of campos) {
    if (
      objeto?.[campo] !== undefined &&
      objeto?.[campo] !== null &&
      objeto?.[campo] !== ""
    ) {
      return objeto[campo];
    }
  }
  return padrao;
}
function moeda(valor) {
  if (valor === null || valor === undefined || valor === "") return "-";
  const numero = Number(valor);
  if (Number.isNaN(numero)) return valor;
  return numero.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}
// Responsavel pelo ACORDO -- lido do proprio registro, na ordem de prioridade
// exigida. Nunca cai no responsavel atual do aluno nem em quem confirmou/baixou.
function responsavelDoAcordo(a) {
  return (
    (a?.operador_responsavel_nome && String(a.operador_responsavel_nome).trim()) ||
    (a?.operador_responsavel_email && String(a.operador_responsavel_email).trim()) ||
    (a?.criado_por_nome && String(a.criado_por_nome).trim()) ||
    (a?.criado_por_email && String(a.criado_por_email).trim()) ||
    "Responsável não identificado"
  );
}
// Situacao simples do acordo, derivada apenas de sinais auditaveis reais.
function situacaoDoAcordo(a) {
  if (!a) return "-";
  if (a.status === "CANCELADO") return "Cancelado";
  if (a.status === "QUITADO") return "Quitado";
  if (a.status === "ATIVO") {
    if (!a.confirmado_em) return "Aguardando confirmação";
    return a._atrasado ? "Atrasado" : "Em dia";
  }
  return a.status || "-";
}
function corSituacaoAcordo(sit) {
  if (sit === "Em dia" || sit === "Quitado") return "#16a34a";
  if (sit === "Atrasado") return "#b45309";
  if (sit === "Cancelado") return "#ef4444";
  if (sit === "Aguardando confirmação") return "#2563eb";
  return "#475569";
}
// Quanto vale uma mensalidade negociada. Mesma ordem que a Carteira e o
// Financeiro usam -- se divergir daqui, a ficha passa a contar diferente do
// resto do sistema sem ninguem perceber.
function valorTitulo(t) {
  return Number(t?.saldo_corrigido ?? t?.valor_em_aberto ?? t?.valor_original ?? 0);
}

function somaTitulos(ts) {
  return (ts || []).reduce((acc, t) => acc + valorTitulo(t), 0);
}

function dataCurta(v) {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("pt-BR");
}
export default function Alunos({ fichaEmbedId = null } = {}) {
  const navigate = useNavigate();
  const location = useLocation();
  const [vindoDaFila, setVindoDaFila] = useState(false);
  const [usuarioLogado, setUsuarioLogado] = useState(null);
  const emailLiberadoAluno = true; // liberado para todos os operadores
  const [alunos, setAlunos] = useState([]);
  const [alunoSelecionado, setAlunoSelecionado] = useState(null);
  const [nomeCopiado, setNomeCopiado] = useState(null);
  const [finAlunos, setFinAlunos] = useState({});
  const [abaFicha, setAbaFicha] = useState("dados");
  const [editandoCadastro, setEditandoCadastro] = useState(false);
  const [nomeEditado, setNomeEditado] = useState("");
  const [cpfEditado, setCpfEditado] = useState("");
  const [telefoneEditado, setTelefoneEditado] = useState("");
  const [emailEditado, setEmailEditado] = useState("");
  const [salvandoCadastro, setSalvandoCadastro] = useState(false);
  const [movimentacoes, setMovimentacoes] = useState([]);
  // Saldo financeiro atual da ficha aberta, pela fonte unica (RPC). Serve para
  // (a) mostrar a situacao financeira ATUAL separada do ultimo evento de baixa
  // e (b) bloquear "Quitar tudo" quando ainda ha saldo/pendencia em aberto.
  const [saldoFicha, setSaldoFicha] = useState(null);
  // Estado explicito do carregamento do saldo canonico:
  // "carregando" -> mostra indicador (NUNCA R$ 0,00 provisorio)
  // "ok"         -> saldoFicha valido (pode ser zero de verdade)
  // "erro"       -> consulta falhou (mostra "Saldo indisponivel", nao assume zero)
  const [saldoStatus, setSaldoStatus] = useState("carregando");
  // Qual bloco expansivel da aba Tabulacao esta aberto ("" = todos fechados).
  // Controlado por estado para permitir abertura automatica por tabulacao,
  // manter apenas um aberto por vez e evitar formularios longos simultaneos.
  const [blocoAberto, setBlocoAberto] = useState("");
  // Sobe a cada acao gravada na ficha: e o sinal para a faixa "Da para
  // desfazer" reconsultar o que ainda pode voltar atras.
  const [desfazerTick, setDesfazerTick] = useState(0);
  // Intencao vinda de uma notificacao de link: abrir a secao "Link de pagamento"
  // e destacar a solicitacao/link exato (sem procurar na fila). Preenchidos a
  // partir do localStorage no momento da abertura por notificacao.
  const [secaoAlvoFicha, setSecaoAlvoFicha] = useState("");
  const [destacarLinkId, setDestacarLinkId] = useState("");
  // Acordos do aluno aberto -- alimenta o card "Responsavel pelos acordos"
  // (informativo). Responsavel vem SEMPRE do registro do acordo, nunca do
  // responsavel atual do aluno / ultimo acionamento / quem confirmou.
  const [acordosFicha, setAcordosFicha] = useState([]);
  const [acordosStatus, setAcordosStatus] = useState("carregando"); // carregando|ok|erro
  const [verTodosAcordos, setVerTodosAcordos] = useState(false);

  // Exporta o historico/tabulacoes do aluno em PDF -- mesma funcao da
  // Minha Carteira, pra manter consistencia entre as duas telas.
  function exportarHistoricoPDF() {
    if (!alunoSelecionado) return;
    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const margem = 48;
    let y = 56;
    const nome = pegarCampo(alunoSelecionado, ["nome", "nome_aluno", "aluno"], "-");
    const cpf = pegarCampo(alunoSelecionado, ["cpf", "CPF"], "-");

    doc.setFont("helvetica", "bold");
    doc.setFontSize(16);
    doc.text("ReATIVA — Histórico de Tabulações", margem, y);
    y += 26;

    doc.setFontSize(12);
    doc.text(nome, margem, y);
    y += 18;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(90);
    doc.text(`CPF: ${cpf}`, margem, y);
    y += 14;
    doc.text(`Exportado em: ${new Date().toLocaleString("pt-BR")}`, margem, y);
    y += 24;

    doc.setDrawColor(210);
    doc.line(margem, y, 548, y);
    y += 20;
    doc.setTextColor(20);

    if (movimentacoes.length === 0) {
      doc.text("Nenhuma movimentação registrada.", margem, y);
    }

    movimentacoes.forEach((mov) => {
      if (y > 760) {
        doc.addPage();
        y = 56;
      }
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10);
      doc.text(formatarDataHora(mov.registrado_em) + "  —  " + (mov.tipo || "Movimentação"), margem, y);
      y += 14;

      doc.setFont("helvetica", "normal");
      doc.setFontSize(9.5);
      const linhas = doc.splitTextToSize(mov.descricao || "-", 500);
      doc.text(linhas, margem, y);
      y += linhas.length * 12 + 4;

      if (mov.status_anterior || mov.status_novo) {
        doc.setTextColor(110);
        doc.text(`Status: ${mov.status_anterior || "-"} → ${mov.status_novo || "-"}`, margem, y);
        doc.setTextColor(20);
        y += 13;
      }

      if (mov.registrado_por_nome) {
        doc.setTextColor(110);
        doc.text(`Registrado por: ${mov.registrado_por_nome}`, margem, y);
        doc.setTextColor(20);
        y += 13;
      }

      y += 10;
      doc.setDrawColor(235);
      doc.line(margem, y - 4, 548, y - 4);
    });

    doc.save(`historico-${nome.replace(/[^a-zA-Z0-9]/g, "-")}.pdf`);
  }
  const [busca, setBusca] = useState("");
  const [observacao, setObservacao] = useState("");
  const [statusFinalizacao, setStatusFinalizacao] = useState("CONTATAR");
  // Referencias aos blocos expansiveis da aba Tabulacao, para rolagem suave
  // ate o inicio do formulario correspondente quando a tabulacao muda.
  const blocosRef = useRef({});
  // Marcado SO pelo onChange do seletor de tabulacao. O efeito que rola ate o
  // bloco olha para este sinal -- assim carregamento de dados nunca rola a
  // tela, e a troca feita por ela continua rolando.
  const rolarAoTrocarRef = useRef(false);

  // DENTRO DO MODAL A FICHA NAO ROLA SOZINHA, nunca.
  //
  // Na tela Base a rolagem automatica faz sentido: existe uma LISTA em cima e a
  // ficha embaixo, entao levar a pessoa ate a ficha e ate util. Embutida no
  // modal da fila, a ficha e o unico conteudo -- nao ha de onde nem para onde
  // rolar, e qualquer scrollIntoView so arranca a leitura do lugar.
  //
  // Amanda passou por isso tres vezes hoje ("corre pra baixo", "continua
  // rolando", "ainda esta puxando para baixo"), e a cada vez eu fechei UM
  // efeito especifico. Errado: o certo e desligar a categoria inteira no
  // contexto onde ela nao serve, em vez de perseguir um efeito por vez.
  const podeRolarSozinho = !fichaEmbedId;
  const [dataRetorno, setDataRetorno] = useState("");
  const [numeroProcesso, setNumeroProcesso] = useState("");
  const [prazoTipo, setPrazoTipo] = useState("DATA");
  const [prazoData, setPrazoData] = useState("");
  const [novoOperadorEmail, setNovoOperadorEmail] = useState("");
  const [editandoOperadorRapido, setEditandoOperadorRapido] = useState(false);
  const [motivoAlteracaoOperador, setMotivoAlteracaoOperador] = useState("");
  const [novaDataRetornoAlteracao, setNovaDataRetornoAlteracao] = useState("");
  const [novaTabulacaoAlteracao, setNovaTabulacaoAlteracao] = useState("");
  const [elogioArquivo, setElogioArquivo] = useState(null);
  const [enviandoElogio, setEnviandoElogio] = useState(false);
  const [carregando, setCarregando] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState("");
  const [origemAbertura, setOrigemAbertura] = useState("");
  // Valor em aberto consolidado por aluno da LISTA -- reutiliza EXATAMENTE a
  // mesma fonte da Minha Carteira (acordos ATIVO -> parcelas A_VENCER/VENCIDA +
  // acordos_titulos em_aberto). total = mensalidades + acordos. Sem calculo novo.
  useEffect(() => {
    let cancelado = false;
    async function calcularFinLista() {
      const ids = (alunos || []).map((a) => String(a.id));
      if (!ids.length) {
        setFinAlunos({});
        return;
      }
      const LOTE = 200;
      const fin = {};
      ids.forEach((id) => {
        fin[id] = { mensalidades: 0, acordos: 0, negociadas: 0, qtdNegociadas: 0, total: 0, temDetalhe: false };
      });
      const acAluno = [];
      for (let i = 0; i < ids.length; i += LOTE) {
        const lote = ids.slice(i, i + LOTE);
        const { data } = await supabase
          .from("acordos")
          .select("id,aluno_id,status")
          .in("aluno_id", lote)
          .eq("status", "ATIVO");
        if (data) acAluno.push(...data);
      }
      const acById = new Map(acAluno.map((a) => [a.id, a]));
      const acIds = acAluno.map((a) => a.id);
      for (let i = 0; i < acIds.length; i += LOTE) {
        const lote = acIds.slice(i, i + LOTE);
        if (!lote.length) continue;
        const { data } = await supabase
          .from("parcelas")
          .select("acordo_id,status,valor")
          .in("acordo_id", lote)
          .in("status", ["A_VENCER", "VENCIDA"]);
        for (const pp of data || []) {
          const ac = acById.get(pp.acordo_id);
          if (!ac || !ac.aluno_id) continue;
          const id = String(ac.aluno_id);
          if (!fin[id]) continue;
          fin[id].acordos += Number(pp.valor || 0);
          fin[id].temDetalhe = true;
        }
      }
      for (let i = 0; i < ids.length; i += LOTE) {
        const lote = ids.slice(i, i + LOTE);
        // HOTFIX parcela negociada: o filtro .eq("status","em_aberto") fazia a
        // mensalidade vinculada a acordo sumir da tela sem aparecer em lugar
        // nenhum. Agora traz tambem as vinculadas e as contabiliza num balde
        // SEPARADO ("negociadas") -- elas NAO entram no total em aberto, que
        // segue sendo so obrigacao avulsa, e NAO sao somadas de novo junto
        // com as parcelas do acordo. O total geral nao muda.
        const { data } = await supabase
          .from("acordos_titulos")
          .select("aluno_id,status,situacao,acordo_id,valor_em_aberto,saldo_corrigido,valor_original")
          .in("aluno_id", lote)
          .in("status", ["em_aberto", "vinculada"]);
        for (const t of data || []) {
          const id = String(t.aluno_id);
          if (!fin[id]) continue;
          const v = Number(t.valor_em_aberto ?? t.saldo_corrigido ?? t.valor_original ?? 0);
          const negociada =
            t.status === "vinculada" || t.situacao === "NEGOCIADO" || !!t.acordo_id;
          if (negociada) {
            fin[id].negociadas += v;
            fin[id].qtdNegociadas += 1;
          } else {
            fin[id].mensalidades += v;
          }
          fin[id].temDetalhe = true;
        }
      }
      ids.forEach((id) => {
        fin[id].total = fin[id].mensalidades + fin[id].acordos;
      });
      if (!cancelado) setFinAlunos(fin);
    }
    calcularFinLista();
    return () => {
      cancelado = true;
    };
  }, [alunos]);
  useEffect(() => {
    inicializarTelaAlunos();
  }, []);

  // Notificacao clicada com a ficha JA montada: navigate("/aluno?...") nao
  // remonta, entao o efeito de mount acima nao roda de novo. Aqui reagimos a
  // cada navegacao (location.key e unico por navegacao, mesmo com a mesma URL)
  // e consumimos os flags pendentes. Idempotente com o mount: quem rodar
  // primeiro consome os flags; o outro vira no-op.
  useEffect(() => {
    if (!location.search || !location.search.includes("origem=notificacao")) return;
    consumirIntencaoDeAbertura();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key]);
  async function inicializarTelaAlunos() {
    const usuario = await pegarUsuarioLogado();
    setUsuarioLogado(usuario);
    const parametros = new URLSearchParams(window.location.search);
    const alunoIdDaUrl =
      parametros.get("alunoId") ||
      parametros.get("id") ||
      parametros.get("aluno");
    const alunoIdLocalStorage = localStorage.getItem("reativa_aluno_abrir_id");
    const alunoIdSessionStorage = sessionStorage.getItem("reativa_aluno_abrir_id");
    const alunoId =
      fichaEmbedId || alunoIdDaUrl || alunoIdLocalStorage || alunoIdSessionStorage;
    if (parametros.get("origem") === "fila") {
      setVindoDaFila(!fichaEmbedId);
    }
    if (alunoId) {
      setOrigemAbertura(`Abrindo aluno recebido da fila: ${alunoId}`);
      // Consome a intencao de secao/destaque (mesmo caminho usado quando a
      // ficha ja esta montada -- ver efeito de location abaixo).
      await consumirIntencaoDeAbertura(alunoId);
      return;
    }
    await carregarAlunos();
  }

  // Consome, UMA UNICA VEZ, os flags de "abrir ficha X na secao Y destacando Z"
  // deixados por uma notificacao (link, retorno etc). Idempotente: os flags sao
  // removidos na primeira execucao, entao chamar duas vezes (mount + navegacao)
  // nao reabre nada. NAO decide autorizacao -- isso continua em abrirAlunoPorId/RLS.
  async function consumirIntencaoDeAbertura(alunoIdJaResolvido) {
    const alunoId =
      alunoIdJaResolvido ||
      localStorage.getItem("reativa_aluno_abrir_id") ||
      sessionStorage.getItem("reativa_aluno_abrir_id");
    if (!alunoId) return false;
    const secaoAlvo = localStorage.getItem("reativa_aluno_abrir_secao") || "";
    const linkDestacar = localStorage.getItem("reativa_link_destacar_id") || "";
    localStorage.removeItem("reativa_aluno_abrir_id");
    sessionStorage.removeItem("reativa_aluno_abrir_id");
    localStorage.removeItem("reativa_aluno_abrir_secao");
    localStorage.removeItem("reativa_link_destacar_id");
    if (secaoAlvo) setSecaoAlvoFicha(secaoAlvo);
    if (linkDestacar) setDestacarLinkId(linkDestacar);
    await abrirAlunoPorId(alunoId);
    return true;
  }
  async function pegarUsuarioLogado() {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data?.user) {
      return {
        nome: "Usuário não identificado",
        email: null,
      };
    }
    const user = data.user;
    const nome =
      user.user_metadata?.nome ||
      user.user_metadata?.name ||
      user.email?.split("@")[0] ||
      "Usuário";
    return {
      nome,
      email: user.email,
    };
  }
  async function carregarAlunos() {
    setCarregando(true);
    setErro("");
    // Importante: toda pesquisa/atualização da lista precisa soltar o aluno
    // que estava aberto (ex: vindo da fila). Sem isso, quem pesquisa outro
    // nome mas não clica no resultado continua com a ficha antiga aberta e
    // corre o risco de tabular/agir no aluno errado.
    setAlunoSelecionado(null);
    setAbaFicha("dados");
    setEditandoCadastro(false);
    setOrigemAbertura("");
    setMovimentacoes([]);
    setVindoDaFila(false);
    try {
      const termo = busca.trim();
      let data, error;
      if (termo) {
        // Usa a funcao de busca (RPC) -- CPF acha qualquer aluno, nome
        // continua restrito a proprio + livre, evitando reabrir a
        // brecha de "listar carteira de colega" que corrigimos hoje.
        const resultado = await supabase.rpc("buscar_aluno", { p_termo: termo });
        data = resultado.data || [];
        error = resultado.error;
        // Busca multi-palavra: o RPC casa a expressao como substring CONTIGUA,
        // entao "Sabrina Carvalho Silva" (nome com palavras fora de ordem ou
        // com termos que nao aparecem juntos no cadastro) voltava vazio. Quando
        // isso acontece e ha mais de um token, refaz por token e cruza os
        // resultados: SO entram os alunos que casam TODOS os tokens.
        //
        // HOTFIX (pesquisa-aluno-id-correto): o fallback antigo, quando NINGUEM
        // casava todos os tokens, caia para "quem casa a maioria" (parcial). Para
        // nomes cujo cadastro nao existe/diverge (ex.: "Alba Kerlly Pinheiro
        // Bastos" -- token "kerlly" nao existe, max de tokens casados = 1) isso
        // despejava ~150 alunos que casavam UM UNICO token comum ("pinheiro",
        // "bastos"), abrindo "diversos alunos" e nao a aluna pesquisada. Agora,
        // se ninguem casa todos os tokens, a lista fica vazia (nenhum aluno
        // encontrado) em vez de inundar com correspondencias parciais erradas.
        // Cada linha continua sendo um aluno unico (dedup por a.id).
        const tokens = termo.split(/\s+/).filter((t) => t.length >= 2);
        if (!error && data.length === 0 && tokens.length > 1) {
          const porToken = await Promise.all(
            tokens.map((tk) => supabase.rpc("buscar_aluno", { p_termo: tk }))
          );
          const erroToken = porToken.find((r) => r.error);
          if (!erroToken) {
            const contagem = new Map();
            const porId = new Map();
            porToken.forEach((r) => {
              const vistos = new Set();
              (r.data || []).forEach((a) => {
                if (vistos.has(a.id)) return;
                vistos.add(a.id);
                contagem.set(a.id, (contagem.get(a.id) || 0) + 1);
                porId.set(a.id, a);
              });
            });
            const todos = [...contagem.entries()]
              .filter(([, c]) => c === tokens.length)
              .map(([id]) => porId.get(id));
            // Sem "parcial": exige casar TODOS os tokens. Se ninguem casa,
            // retorna vazio -- nunca inunda com correspondencias de um so token.
            data = todos;
          }
        }
      } else {
        const resultado = await supabase.from("alunos").select("*").limit(150);
        data = resultado.data;
        error = resultado.error;
      }
      if (error) {
        console.error("Erro ao carregar alunos:", error);
        setErro("Erro ao carregar alunos.");
        setAlunos([]);
        return;
      }
      setAlunos(data || []);
    } catch (e) {
      console.error("Erro inesperado ao carregar alunos:", e);
      setErro("Erro inesperado ao carregar alunos.");
      setAlunos([]);
    } finally {
      setCarregando(false);
    }
  }
  async function abrirAlunoPorId(alunoIdRecebido) {
    const alunoId = String(alunoIdRecebido || "").trim();
    if (!alunoId) return;
    setCarregando(true);
    setErro("");
    try {
      const { data: linhas, error } = await supabase.rpc("buscar_aluno_por_id", { p_id: alunoId });
      const data = linhas?.[0] || null;
      if (error) {
        console.error("Erro ao abrir aluno automaticamente:", error);
        setErro("Erro ao abrir aluno selecionado pela fila.");
        await carregarAlunos();
        return;
      }
      if (!data) {
        setErro("Aluno recebido da fila não foi encontrado na tabela alunos.");
        await carregarAlunos();
        return;
      }
      prepararAlunoNaTela(data);
      await carregarMovimentacoes(data.id);
      setAlunos([data]);
      window.history.replaceState(
        null,
        "",
        `/alunos?alunoId=${encodeURIComponent(data.id)}`
      );
    } catch (e) {
      console.error("Erro inesperado ao abrir aluno automaticamente:", e);
      setErro("Erro inesperado ao abrir aluno selecionado.");
      await carregarAlunos();
    } finally {
      setCarregando(false);
    }
  }
  async function abrirAluno(aluno) {
    setAbaFicha("dados");
    prepararAlunoNaTela(aluno);
    await carregarMovimentacoes(aluno.id);
    if (!podeRolarSozinho) return;
    setTimeout(function () {
      var el = document.getElementById("ficha-aluno");
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 150);
  }
  // Fonte canonica do saldo operacional do aluno: RPC aluno_saldo_pendente_detalhe.
  // Usada de forma consistente no cabecalho (situacao financeira) e no card
  // "Valor em aberto". Nunca usar casos.total_em_aberto nem alunos.valor_em_aberto
  // isoladamente, nem assumir 0 durante o carregamento/erro.
  const recarregarSaldoFicha = useCallback(async (id) => {
    if (!id) {
      setSaldoFicha(null);
      setSaldoStatus("carregando");
      return;
    }
    setSaldoStatus("carregando");
    const { data, error } = await supabase.rpc("aluno_saldo_pendente_detalhe", {
      p_aluno_id: id,
    });
    if (error) {
      setSaldoFicha(null);
      setSaldoStatus("erro");
      return;
    }
    setSaldoFicha(data || null);
    setSaldoStatus("ok");
  }, []);

  // Carrega os acordos do aluno para o card "Responsavel pelos acordos".
  // Responsavel: SEMPRE do proprio registro do acordo, na ordem de prioridade
  // operador_responsavel -> criado_por -> "Responsavel nao identificado".
  const recarregarAcordosFicha = useCallback(async (id) => {
    if (!id) {
      setAcordosFicha([]);
      setAcordosStatus("carregando");
      return;
    }
    setAcordosStatus("carregando");
    const { data: acs, error } = await supabase
      .from("acordos")
      .select(
        "id,status,criado_em,confirmado_em,operador_responsavel_nome,operador_responsavel_email,criado_por_nome,criado_por_email"
      )
      .eq("aluno_id", id)
      .order("criado_em", { ascending: false });
    if (error) {
      setAcordosFicha([]);
      setAcordosStatus("erro");
      return;
    }
    const lista = acs || [];
    // Marca acordos ATIVOS com parcela vencida como "atrasado".
    const idsAtivos = lista.filter((a) => a.status === "ATIVO").map((a) => a.id);
    const comVencida = new Set();
    if (idsAtivos.length) {
      const { data: parc } = await supabase
        .from("parcelas")
        .select("acordo_id")
        .in("acordo_id", idsAtivos)
        .eq("status", "VENCIDA");
      for (const p of parc || []) comVencida.add(p.acordo_id);
    }
    // MENSALIDADES VINCULADAS A CADA ACORDO.
    //
    // Elas existem, tem valor, e NAO entram no total em aberto -- quem entra sao
    // as parcelas do acordo, que ja representam essa mesma divida. Somar as duas
    // dobraria: sao R$ 6,3 milhoes em 2.717 titulos NEGOCIADO na base inteira.
    //
    // Ate agora so aparecia o total ("Negociadas em acordo: R$ X"). Faltava dizer
    // QUAIS -- que e o que permite conferir se o acordo cobriu o que devia.
    const porAcordo = new Map();
    if (lista.length) {
      const idsAcordos = lista.map((a) => a.id);
      const COLUNAS =
        "id,acordo_id,documento,vencimento,competencia,situacao,valor_original,valor_em_aberto,saldo_corrigido,vinculado_em,vinculado_por";

      // O VINCULO MORA EM DOIS LUGARES, e os dois valem.
      //
      // `acordos_titulos.acordo_id` e a tabela `acordo_titulo_vinculo`. O certo e
      // ter os dois -- e os 2.733 titulos negociados corretamente tem. Mas em
      // 31/08 havia 122 titulos ligados SO pela tabela, com a coluna vazia.
      // Lendo so a coluna, esses 122 sumiam da ficha sem aviso: o operador veria
      // "nenhuma mensalidade negociada" num acordo que cobriu varias.
      //
      // Quem manda no SALDO e a tabela de vinculo -- e o que
      // `recalcular_situacao_aluno` consulta para tirar a mensalidade da conta.
      // Entao a ficha precisa mostrar, no minimo, tudo o que o saldo ja desconta.
      const [porColuna, vinculos] = await Promise.all([
        supabase.from("acordos_titulos").select(COLUNAS).in("acordo_id", idsAcordos),
        supabase
          .from("acordo_titulo_vinculo")
          .select("titulo_id,acordo_id,ativo")
          .in("acordo_id", idsAcordos),
      ]);

      const ativos = (vinculos.data || []).filter((v) => v.ativo !== false);
      const acordoDoTitulo = new Map(ativos.map((v) => [v.titulo_id, v.acordo_id]));

      let pelaTabela = [];
      if (ativos.length) {
        const r = await supabase
          .from("acordos_titulos")
          .select(COLUNAS)
          .in("id", ativos.map((v) => v.titulo_id));
        pelaTabela = r.data || [];
      }

      // junta as duas fontes sem repetir o mesmo titulo
      const vistos = new Set();
      for (const t of [...(porColuna.data || []), ...pelaTabela]) {
        if (vistos.has(t.id)) continue;
        vistos.add(t.id);
        const destino = t.acordo_id || acordoDoTitulo.get(t.id);
        if (!destino) continue;
        if (!porAcordo.has(destino)) porAcordo.set(destino, []);
        porAcordo.get(destino).push(t);
      }
      for (const lst of porAcordo.values()) {
        lst.sort(
          (x, y) =>
            String(x.vencimento || "").localeCompare(String(y.vencimento || "")) ||
            String(x.id).localeCompare(String(y.id))
        );
      }
    }
    setAcordosFicha(
      lista.map((a) => ({
        ...a,
        _atrasado: comVencida.has(a.id),
        _titulos: porAcordo.get(a.id) || [],
      }))
    );
    setAcordosStatus("ok");
  }, []);

  // Recarrega o saldo oficial sempre que troca a ficha aberta.
  useEffect(() => {
    recarregarAcordosFicha(alunoSelecionado?.id);
    setVerTodosAcordos(false);
  }, [alunoSelecionado?.id, recarregarAcordosFicha]);

  // Recarrega o saldo oficial sempre que troca a ficha aberta.
  useEffect(() => {
    const id = alunoSelecionado?.id;
    if (!id) {
      setSaldoFicha(null);
      setSaldoStatus("carregando");
      return;
    }
    let ativo = true;
    (async () => {
      setSaldoStatus("carregando");
      const { data, error } = await supabase.rpc("aluno_saldo_pendente_detalhe", {
        p_aluno_id: id,
      });
      if (!ativo) return;
      if (error) {
        setSaldoFicha(null);
        setSaldoStatus("erro");
      } else {
        setSaldoFicha(data || null);
        setSaldoStatus("ok");
      }
    })();
    return () => {
      ativo = false;
    };
  }, [alunoSelecionado?.id]);

  // Verdadeiro quando ha mensalidade aberta, parcela de acordo aberta ou
  // confirmacao/baixa pendente -- nesses casos o aluno NAO esta zerado.
  const fichaComPendencia = !!(saldoFicha && saldoFicha.tem_pendencia === true);

  // Ao trocar a tabulacao: abre automaticamente o bloco correspondente (e fecha
  // o anterior, pois so um fica aberto por vez) e rola suavemente ate o inicio
  // do formulario. Nao executa nenhuma acao nem apaga o que ja foi digitado --
  // apenas revela/oculta o bloco. Fora da aba Tabulacao nao rola a tela.
  useEffect(() => {
    // Quando a ficha foi aberta por uma notificacao de link, a abertura do bloco
    // "Link de pagamento" tem prioridade. Nao sobrepor aqui (o setAbaFicha("dados")
    // do efeito de link reentra neste efeito e fecharia o bloco recem-aberto).
    if (secaoAlvoFicha === "link") return;
    const destino = TABULACAO_PARA_BLOCO[statusFinalizacao] || "";
    setBlocoAberto(destino);

    // SO ROLA SE ELA PEDIU. Este efeito existe para acompanhar quem MUDA a
    // tabulacao no seletor: escolheu "acordo fechado", o bloco do acordo abre e
    // a tela desce ate ele. Util.
    //
    // Mas ele tambem dispara quando a ficha CARREGA, porque statusFinalizacao e
    // preenchido com a tabulacao que o aluno ja tinha -- e mais de uma vez,
    // conforme os dados chegam. Resultado: a tela descia sozinha ao abrir
    // (Amanda, 27/08/2026: "quando abro a ficha ela corre pra baixo"; depois,
    // sobre a primeira tentativa de conserto: "continua rolando a tela").
    //
    // Contar passagens nao resolve -- o numero delas depende de quantas vezes o
    // dado chega. Entao a rolagem passa a exigir um pedido EXPLICITO, marcado
    // pelo proprio onChange do seletor. Carregamento nunca marca; so a mao
    // dela marca. E o pedido e consumido, para nao valer duas vezes.
    if (!rolarAoTrocarRef.current) return;
    rolarAoTrocarRef.current = false;
    if (!podeRolarSozinho) return;

    if (destino && (abaFicha === "dados" || abaFicha === "tabulacoes")) {
      const t = setTimeout(() => {
        const el = blocosRef.current[destino];
        if (el && typeof el.scrollIntoView === "function") {
          el.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      }, 80);
      return () => clearTimeout(t);
    }
  }, [statusFinalizacao, abaFicha, secaoAlvoFicha]);

  // Abertura vinda de uma notificacao de link: quando o aluno correto ja esta
  // carregado, garante a aba de dados, abre o bloco "Link de pagamento" e rola
  // ate ele. O destaque do card exato fica a cargo de LinksPagamentoAluno via
  // a prop destacarSolicitacaoId. Roda uma unica vez por abertura.
  useEffect(() => {
    if (secaoAlvoFicha !== "link") return;
    if (!alunoSelecionado?.id) return;
    setAbaFicha("dados");
    setBlocoAberto("link");
    // No modal, abrir o bloco basta -- rolar arranca a leitura do lugar.
    if (!podeRolarSozinho) { setSecaoAlvoFicha(""); return; }
    // O bloco "Link de pagamento" pode ainda nao estar no DOM (dados assincronos
    // da ficha). Em vez de um unico timeout que pode disparar cedo, tentamos
    // rolar ate o ref existir. So limpamos secaoAlvoFicha ao final -- enquanto
    // ele vale "link", o efeito de tabulacao cede e nao fecha o bloco.
    let tentativas = 0;
    let timer;
    const tentarRolar = () => {
      const el = blocosRef.current.link;
      if (el && typeof el.scrollIntoView === "function") {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        setSecaoAlvoFicha("");
        return;
      }
      if (tentativas++ < 12) {
        timer = setTimeout(tentarRolar, 120);
      } else {
        setSecaoAlvoFicha(""); // desiste do scroll, mas o bloco ja abriu
      }
    };
    timer = setTimeout(tentarRolar, 120);
    return () => clearTimeout(timer);
  }, [secaoAlvoFicha, alunoSelecionado?.id]);

  function prepararAlunoNaTela(aluno) {
    setAlunoSelecionado(aluno);
    setObservacao("");
    setNovoOperadorEmail("");
    setMotivoAlteracaoOperador("");
    const statusAtual = pegarCampo(
      aluno,
      ["status_jornada", "status_atual", "status"],
      "CONTATAR"
    );
    setStatusFinalizacao(statusAtual);
    // So pre-preenche data que o OPERADOR marcou e ainda esta no futuro. Data
    // automatica (motor da fila / regra da tabulacao) nao e compromisso: se
    // viesse preenchida, o Finalizar a regravava como escolha humana.
    const compromisso =
      String(aluno.retorno_origem || "").startsWith("OPERADOR") &&
      (paraDataLocalBR(aluno.data_retorno) || "") >= paraDataLocalBR(new Date());
    setDataRetorno(compromisso ? paraInputDateTime(aluno.data_retorno) : "");
  }
  function abrirEdicaoCadastro() {
    if (!alunoSelecionado) return;
    setNomeEditado(
      pegarCampo(alunoSelecionado, ["nome", "nome_aluno", "aluno"], "")
    );
    setCpfEditado(pegarCampo(alunoSelecionado, ["cpf", "CPF"], ""));
    setTelefoneEditado(pegarCampo(alunoSelecionado, ["telefone", "Telefone"], ""));
    setEmailEditado(pegarCampo(alunoSelecionado, ["email", "Email", "e_mail"], ""));
    setEditandoCadastro(true);
  }
  async function salvarCadastroAluno() {
    if (!alunoSelecionado?.id) return;
    if (!nomeEditado.trim()) {
      alert("Informe o nome do aluno.");
      return;
    }
    if (!cpfEditado.trim()) {
      alert("Informe o CPF do aluno.");
      return;
    }
    setSalvandoCadastro(true);
    const nomeAnterior = pegarCampo(
      alunoSelecionado,
      ["nome", "nome_aluno", "aluno"],
      ""
    );
    const cpfAnterior = pegarCampo(alunoSelecionado, ["cpf", "CPF"], "");
    const telefoneAnterior = pegarCampo(alunoSelecionado, ["telefone", "Telefone"], "");
    const emailAnterior = pegarCampo(alunoSelecionado, ["email", "Email", "e_mail"], "");
    const { error } = await supabase
      .from("alunos")
      .update({
        nome: nomeEditado.trim(),
        cpf: cpfEditado.trim(),
        telefone: telefoneEditado.trim() || null,
        email: emailEditado.trim() || null,
        atualizado_em: new Date().toISOString(),
      })
      .eq("id", alunoSelecionado.id);
    setSalvandoCadastro(false);
    if (error) {
      console.error("Erro ao atualizar cadastro:", error);
      alert("Erro ao salvar cadastro: " + error.message);
      return;
    }
    await supabase.from("aluno_movimentacoes").insert({
      aluno_id: String(alunoSelecionado.id),
      tipo: "CORRECAO_CADASTRO",
      descricao: `Cadastro corrigido. Nome: "${nomeAnterior}" -> "${nomeEditado.trim()}". CPF: "${cpfAnterior}" -> "${cpfEditado.trim()}". Telefone: "${telefoneAnterior}" -> "${telefoneEditado.trim()}". E-mail: "${emailAnterior}" -> "${emailEditado.trim()}".`,
      status_anterior: pegarCampo(
        alunoSelecionado,
        ["status_jornada", "status_atual", "status"],
        null
      ),
      status_novo: pegarCampo(
        alunoSelecionado,
        ["status_jornada", "status_atual", "status"],
        null
      ),
      registrado_por_nome: usuarioLogado?.nome,
      registrado_por_email: usuarioLogado?.email,
      registrado_em: new Date().toISOString(),
    });
    setEditandoCadastro(false);
    await recarregarAlunoSelecionado(alunoSelecionado.id);
    await carregarMovimentacoes(alunoSelecionado.id);
    alert("Cadastro atualizado com sucesso.");
  }
  async function recarregarAlunoSelecionado(alunoId) {
    const { data, error } = await supabase
      .from("alunos")
      .select("*")
      .eq("id", alunoId)
      .maybeSingle();
    if (error) {
      console.error("Erro ao recarregar aluno:", error);
      return;
    }
    if (data) {
      prepararAlunoNaTela(data);
      setAlunos([data]);
      setDesfazerTick((t) => t + 1);
      // Reavalia a fonte canonica do saldo apos qualquer evento financeiro
      // (pagamento, baixa, quitacao, acordo, link etc.), mantendo cabecalho e
      // card "Valor em aberto" consistentes sem chamadas duplicadas espalhadas.
      recarregarSaldoFicha(alunoId);
      // Card "Responsavel pelos acordos" reflete criacao/confirmacao/quebra/
      // cancelamento/quitacao sem exigir reload da pagina inteira.
      recarregarAcordosFicha(alunoId);
    }
  }
  async function solicitarLinkPagamento() {
    if (!alunoSelecionado) {
      alert("Selecione um aluno antes de solicitar o link.");
      return;
    }
    window.dispatchEvent(
      new CustomEvent("REATIVA_ABRIR_LINK_PAGAMENTO", {
        detail: {
          aluno: alunoSelecionado
        }
      })
    );
  }
  async function marcarLinkEnviadoAoAluno() {
    if (!alunoSelecionado?.id) {
      alert("Selecione um aluno antes de marcar o link como enviado.");
      return;
    }
    setSalvando(true);
    try {
      const statusAnterior = pegarCampo(
        alunoSelecionado,
        ["status_jornada", "status_atual", "status"],
        null
      );
      const agora = new Date().toISOString();
      try {
        await supabase
          .from("links_pagamento")
          .update({
            status: "LINK_ENVIADO_AO_ALUNO",
            enviado_operador_em: agora,
            atualizado_em: agora,
          })
          .eq("aluno_id", String(alunoSelecionado.id))
          .in("status", [
            "LINK_GERADO",
            "LINK_PRONTO_PARA_ENVIO",
            "LINK_ENVIADO_ALUNO",
            "LINK_ENVIADO_AO_ALUNO",
          ]);
      } catch (erroLink) {
        console.warn("Não foi possível atualizar links_pagamento:", erroLink);
      }
      await registrarMovimentacao({
        alunoId: alunoSelecionado.id,
        tipo: "LINK_ENVIADO_AO_ALUNO",
        descricao:
          "Operador informou que o link foi enviado ao aluno. Próximo passo: aguardar comprovante de pagamento.",
        statusAnterior,
        statusNovo: "AGUARDANDO_COMPROVANTE",
        retorno: null,
        atualizarResponsavel: false,
      });
      await recarregarAlunoSelecionado(alunoSelecionado.id);
      await carregarMovimentacoes(alunoSelecionado.id);
      await carregarAlunos();
      alert("Link marcado como enviado. Agora o caso ficará aguardando comprovante.");
    } catch (e) {
      console.error(e);
      alert("Erro ao marcar link como enviado ao aluno.");
    } finally {
      setSalvando(false);
    }
  }
  async function carregarMovimentacoes(alunoId) {
    if (!alunoId) return;
    const { data, error } = await supabase
      .from("aluno_movimentacoes")
      .select("*")
      .eq("aluno_id", String(alunoId))
      .order("registrado_em", { ascending: false });
    if (error) {
      console.error("Erro ao carregar movimentações:", error);
      setMovimentacoes([]);
      return;
    }
    setMovimentacoes(data || []);
  }
  async function abrirAnexoElogio(caminho) {
    if (!caminho) return;
    const { data, error } = await supabase.storage
      .from("elogios-prints")
      .createSignedUrl(caminho, 3600);
    if (error || !data?.signedUrl) {
      alert("Erro ao abrir o anexo: " + (error?.message || "não encontrado"));
      return;
    }
    window.open(data.signedUrl, "_blank");
  }
  async function registrarMovimentacao({
    alunoId,
    tipo,
    descricao,
    statusAnterior = null,
    statusNovo = null,
    retorno = null,
    atualizarResponsavel = false,
    observacaoAluno = null,
    extra = {},
    extraAluno = {},
  }) {
    if (!alunoId) {
      alert("Aluno sem ID. Não foi possível registrar.");
      return;
    }
    // Se a ficha ficou muito tempo aberta/parada, o token pode ter
    // expirado sem o refresh automático rodar a tempo -- isso fazia o
    // insert cair como "anon" (sem policy de insert) e dar um "Erro ao
    // registrar movimentação" genérico, mesmo com tudo preenchido certo.
    // Forçar checagem de sessão antes de escrever, igual já feito em
    // outras telas que bateram nesse mesmo problema.
    try {
      await supabase.auth.getSession();
    } catch {
      // Segue e deixa o erro real aparecer, se houver.
    }
    const usuario = await pegarUsuarioLogado();
    const agora = new Date().toISOString();
    const movimento = {
      aluno_id: String(alunoId),
      tipo,
      descricao,
      status_anterior: statusAnterior,
      status_novo: statusNovo,
      registrado_por_nome: usuario.nome,
      registrado_por_email: usuario.email,
      registrado_em: agora,
      data_retorno: retorno,
      ...extra,
    };
    const { error: movError } = await supabase
      .from("aluno_movimentacoes")
      .insert(movimento);
    if (movError) {
      console.error("Erro ao registrar movimentação:", movError);
      alert("Erro ao registrar movimentação: " + movError.message);
      throw movError;
    }
    const atualizacaoAluno = {
      registrado_por_nome: usuario.nome,
      registrado_por_email: usuario.email,
      registrado_em: agora,
      data_ultimo_acionamento: agora,
    };
    if (statusNovo) {
      atualizacaoAluno.status_jornada = statusNovo;
      atualizacaoAluno.status_atual = statusNovo;
      atualizacaoAluno.status_acionamento = statusNovo;
      // Proxima acao e prazo de retorno vem do catalogo de tabulacoes -- a
      // mesma regra da Minha Carteira e do e-mail. Data digitada e compromisso
      // do operador; sem data, a tabulacao agenda sozinha (ou nao agenda).
      const catalogo = await carregarTabulacoes();
      const desfecho = desfechoDaTabulacao(catalogo, statusNovo, {
        dataDigitada: retorno ? paraDataLocalBR(retorno) || "" : "",
      });
      atualizacaoAluno.proxima_acao = desfecho.proxima_acao;
      if (desfecho.data_retorno) {
        atualizacaoAluno.data_retorno = desfecho.data_retorno;
        atualizacaoAluno.retorno_origem = desfecho.retorno_origem;
      }
    } else if (retorno) {
      atualizacaoAluno.data_retorno = paraDataLocalBR(retorno);
      atualizacaoAluno.retorno_origem = "OPERADOR";
    }
    if (observacaoAluno !== null) {
      atualizacaoAluno.observacao = observacaoAluno;
    }
    Object.assign(atualizacaoAluno, extraAluno);
    if (atualizarResponsavel) {
      atualizacaoAluno.responsavel_atual_nome = usuario.nome;
      atualizacaoAluno.responsavel_atual_email = usuario.email;
      atualizacaoAluno.responsavel_atual_em = agora;
    }
    const { error: updateError } = await supabase
      .from("alunos")
      .update(atualizacaoAluno)
      .eq("id", alunoId);
    if (updateError) {
      console.error("Erro ao atualizar aluno:", updateError);
      alert("Movimentação registrada, mas houve erro ao atualizar a ficha.");
      throw updateError;
    }
  }
  async function assumirAtendimento() {
    if (!alunoSelecionado?.id) return;
    setSalvando(true);
    try {
      const statusAnterior = pegarCampo(
        alunoSelecionado,
        ["status_jornada", "status_atual", "status"],
        null
      );
      // Claim atômico: só assume se a matrícula ainda estiver sem responsável.
      // A RPC (sistema_assumir_atendimento + trigger _guard_resp_aluno no banco)
      // impede que dois operadores assumam o mesmo caso, grava o histórico com
      // responsável anterior/novo e origem ASSUMIU_ATENDIMENTO, e inicia a
      // fidelização de 10 dias (responsavel_atual_em = agora).
      const { data: rClaim, error: rpcError } = await supabase.rpc(
        "sistema_assumir_atendimento",
        { p_aluno_id: alunoSelecionado.id }
      );
      if (rpcError) {
        alert("Erro ao assumir atendimento: " + rpcError.message);
        return;
      }
      if (!rClaim?.ok) {
        alert(
          rClaim?.erro === "JA_TEM_RESPONSAVEL"
            ? "Outro operador já assumiu este atendimento."
            : "Não foi possível assumir o atendimento: " + (rClaim?.erro || "erro desconhecido")
        );
        await recarregarAlunoSelecionado(alunoSelecionado.id);
        return;
      }

      // Claim confirmado → só agora muda para EM_ATENDIMENTO (sem tocar no
      // responsável, que já foi definido atomicamente pela RPC).
      await registrarMovimentacao({
        alunoId: alunoSelecionado.id,
        tipo: "EM_ATENDIMENTO",
        descricao: "Atendimento iniciado após assumir o caso.",
        statusAnterior,
        statusNovo: "EM_ATENDIMENTO",
        retorno: null,
        atualizarResponsavel: false,
      });
      await recarregarAlunoSelecionado(alunoSelecionado.id);
      await carregarMovimentacoes(alunoSelecionado.id);
      alert("Atendimento assumido com sucesso.");
    } catch (e) {
      console.error(e);
    } finally {
      setSalvando(false);
    }
  }
  // Botão liberado para Amanda (gestora/ADM) e Fernanda: tira o aluno da fila
  // (novo ou antigo), deixando a ficha amarela. Diferente de
  // Jurídico/Cancelamento, este volta sozinho pra fila se aparecer um
  // título novo desse aluno num bordero (ver Borderos.jsx).
  // QUITAR TUDO.
  //
  // O QUE MUDOU E POR QUE. Isto era uma sequencia de gravacoes soltas no
  // navegador -- movimentacao, titulos, acordos, parcelas, carteira -- sem
  // transacao e com o erro engolido num catch mudo. Se qualquer passo falhasse,
  // o caso ficava PELA METADE: status "quitado" e divida intacta. E a tela
  // ainda dizia que tinha dado certo.
  //
  // Caso real, 28/08/2026: Yasmim da Silva ficou QUITADO_MANUAL com
  // R$ 7.021,66 em tres titulos que nunca foram tocados -- data de atualizacao
  // deles era de julho. Voltou para o topo da fila porque o saldo continuava.
  //
  // Agora chama `quitar_e_encerrar_caso`, que faz TUDO no servidor numa
  // transacao so: casos, alunos, parcelas, acordos, titulos, confirmacoes e
  // baixas. Ou vai tudo, ou nao vai nada -- e o erro aparece na tela.
  async function quitarManual() {
    if (!alunoSelecionado?.id) return;
    if (!podeQuitarManual(usuarioLogado?.email)) return;
    const confirmado = window.confirm(
      "Marcar como quitado e tirar da fila? A ficha fica amarela e sai da fila ativa. Só volta se subir um título novo dele em algum bordero."
    );
    if (!confirmado) return;
    setSalvando(true);
    try {
      let { data, error } = await supabase.rpc("quitar_e_encerrar_caso", {
        p_aluno_id: alunoSelecionado.id,
      });

      // Guarda do acordo em dia: o servidor recusa quando o aluno tem parcela
      // futura e nada vencido, para nao apagar acordo vigente sem querer.
      if (error && String(error.message || "").includes("ACORDO_EM_DIA")) {
        const seguir = window.confirm(
          error.message.replace("ACORDO_EM_DIA: ", "") +
            "\n\nConfirmar mesmo assim?"
        );
        if (!seguir) { setSalvando(false); return; }
        ({ data, error } = await supabase.rpc("quitar_e_encerrar_caso", {
          p_aluno_id: alunoSelecionado.id,
          p_confirmar_acordo_em_dia: true,
        }));
      }

      if (error) {
        alert("NAO foi quitado. Nada foi alterado.\n\n" + error.message);
        return;
      }

      await registrarMovimentacao({
        alunoId: alunoSelecionado.id,
        tipo: "QUITADO_MANUAL",
        descricao: "Caso marcado como quitado manualmente para sair da fila ativa.",
        statusAnterior: pegarCampo(
          alunoSelecionado,
          ["status_jornada", "status_atual", "status"],
          null
        ),
        statusNovo: STATUS_QUITADO_MANUAL,
        retorno: null,
        atualizarResponsavel: false,
      });

      await recarregarAlunoSelecionado(alunoSelecionado.id);
      await carregarMovimentacoes(alunoSelecionado.id);
      const t = data?.titulos ?? data?.titulos_zerados;
      alert(
        "Caso quitado e removido da fila ativa." +
          (t != null ? ` ${t} título(s) zerado(s).` : "")
      );
    } catch (e) {
      console.error(e);
      alert("NAO foi quitado. Nada foi alterado.\n\n" + (e?.message || e));
    } finally {
      setSalvando(false);
    }
  }
  async function finalizarAtendimento() {
    if (!alunoSelecionado?.id) return;
    if (!statusFinalizacao) {
      alert("Selecione o status da finalização.");
      return;
    }
    const precisaRetorno = retornoEhManual(await carregarTabulacoes(), statusFinalizacao);
    if (precisaRetorno && !dataRetorno) {
      alert("Informe a data de retorno para esse status.");
      return;
    }
    const ehStatusRestrito = STATUS_BLOQUEADOS_ACIONAMENTO.includes(statusFinalizacao);
    const permitidoNesseStatus =
      statusFinalizacao === STATUS_QUITADO_MANUAL
        ? podeQuitarManual(usuarioLogado?.email)
        : podeVerTudo(usuarioLogado?.email);
    if (ehStatusRestrito && !permitidoNesseStatus) {
      alert(
        statusFinalizacao === STATUS_QUITADO_MANUAL
          ? "Apenas a Amanda pode marcar um caso como quitado manualmente."
          : "Apenas gestão/supervisão pode definir esse status."
      );
      return;
    }
    if (ehStatusRestrito && !observacao.trim()) {
      alert(
        `Informe a observação em destaque antes de marcar como "${STATUS_BLOQUEADOS_LABEL[statusFinalizacao]}".`
      );
      return;
    }
    const ehStatusComProcesso = STATUS_COM_PROCESSO.includes(statusFinalizacao);
    if (ehStatusComProcesso) {
      if (!numeroProcesso.trim()) {
        alert(
          `Informe o número do processo antes de marcar como "${STATUS_BLOQUEADOS_LABEL[statusFinalizacao]}".`
        );
        return;
      }
      if (prazoTipo === "DATA" && !prazoData) {
        alert("Informe a data do prazo, ou marque como indeterminado.");
        return;
      }
    }
    setSalvando(true);
    try {
      const statusAnterior = pegarCampo(
        alunoSelecionado,
        ["status_jornada", "status_atual", "status"],
        null
      );
      const retornoIso = dataRetorno
        ? new Date(dataRetorno).toISOString()
        : null;
      const extraAluno = ehStatusComProcesso
        ? {
            processo_numero: numeroProcesso.trim(),
            processo_prazo_tipo: prazoTipo,
            processo_prazo_data: prazoTipo === "DATA" ? prazoData : null,
          }
        : {};
      // Print do elogio de atendimento (opcional) -- sobe pro bucket
      // privado antes de registrar a movimentação, pra já salvar o
      // caminho junto com a tabulação.
      let extraElogio = {};
      if (statusFinalizacao === "ELOGIO_ATENDIMENTO" && elogioArquivo) {
        setEnviandoElogio(true);
        const nomeSeguro = elogioArquivo.name
          .normalize("NFD")
          .replace(/[̀-ͯ]/g, "")
          .replace(/[^a-zA-Z0-9.\-_]/g, "_");
        const caminho = `${alunoSelecionado.id}/${Date.now()}-${nomeSeguro}`;
        const { error: erroUpload } = await supabase.storage
          .from("elogios-prints")
          .upload(caminho, elogioArquivo, { cacheControl: "3600", upsert: false });
        setEnviandoElogio(false);
        if (erroUpload) {
          alert("Erro ao anexar o print do elogio: " + erroUpload.message);
        } else {
          extraElogio = { elogio_print_path: caminho, elogio_print_nome: elogioArquivo.name };
        }
      }
      await registrarMovimentacao({
        alunoId: alunoSelecionado.id,
        tipo: "FINALIZACAO_ATENDIMENTO",
        descricao:
          observacao.trim() ||
          `Atendimento finalizado com status: ${statusFinalizacao}.`,
        statusAnterior,
        statusNovo: statusFinalizacao,
        retorno: retornoIso,
        atualizarResponsavel: false,
        observacaoAluno: ehStatusRestrito ? observacao.trim() : null,
        extra: extraElogio,
        extraAluno,
      });
      // Tabulou como "aguardando baixa" (pago) direto na ficha, sem passar
      // pelo card dedicado "Confirmar pagamento" -- sem isso o aluno ficava
      // com o status de pago mas nunca aparecia na fila de Confirmação de
      // Pagamento. Criamos a solicitação aqui pra garantir que todo "pago"
      // realmente cai na fila de confirmação.
      if (statusFinalizacao === "AGUARDANDO_BAIXA") {
        const { data: pendenteExistente } = await supabase
          .from("solicitacoes_confirmacao_pagamento")
          .select("id")
          .eq("aluno_id", String(alunoSelecionado.id))
          .in("status", ["AGUARDANDO_CONFIRMACAO", "PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO"])
          .maybeSingle();
        if (!pendenteExistente) {
          const { error: erroSolicitacao } = await supabase
            .from("solicitacoes_confirmacao_pagamento")
            .insert({
              aluno_id: String(alunoSelecionado.id),
              aluno_nome: pegarCampo(alunoSelecionado, ["nome", "nome_aluno", "aluno"], "Aluno sem nome"),
              aluno_cpf: pegarCampo(alunoSelecionado, ["cpf", "CPF"], null),
              operador_email: usuarioLogado?.email || null,
              operador_nome: usuarioLogado?.nome || null,
              motivo: observacao.trim() || "Tabulado como aguardando baixa direto na ficha do aluno.",
              status: "AGUARDANDO_CONFIRMACAO",
            });
          if (erroSolicitacao) {
            console.error("Erro ao criar solicitação de confirmação de pagamento:", erroSolicitacao);
            alert(
              "Atenção: o status foi salvo, mas houve um erro ao mandar o caso pra fila de Confirmação de Pagamento: " +
                erroSolicitacao.message
            );
          }
        }
      }
      // Foi pra juridico -- sinaliza que o caso saiu da carteira ativa,
      // dispara a reposicao automatica.
      if (statusFinalizacao === "JURIDICO") {
        const { error: erroLiberar } = await supabase.rpc("liberar_caso_por_evento", {
          p_aluno_id: alunoSelecionado.id,
          p_evento: "JURIDICO",
        });
        if (erroLiberar) {
          console.error("Erro ao liberar caso (reposição automática):", erroLiberar);
        }
      }
      setObservacao("");
      setNumeroProcesso("");
      setPrazoTipo("DATA");
      setPrazoData("");
      setElogioArquivo(null);
      await recarregarAlunoSelecionado(alunoSelecionado.id);
      await carregarMovimentacoes(alunoSelecionado.id);
      alert("Finalização registrada com sucesso.");
      if (vindoDaFila) {
        navigate("/minha-fila");
      }
    } catch (e) {
      console.error(e);
    } finally {
      setSalvando(false);
    }
  }
  async function alterarOperadorResponsavel() {
    if (!alunoSelecionado?.id) {
      alert("Selecione um aluno antes de alterar o operador.");
      return;
    }
    if (!novoOperadorEmail) {
      alert("Selecione o novo operador responsável.");
      return;
    }
    const motivo = motivoAlteracaoOperador.trim();
    if (false) {
      alert("Informe o motivo da alteração.");
      return;
    }
    const novoOperador = OPERADORES_REATIVA.find(
      (op) => op.email === novoOperadorEmail
    );
    if (!novoOperador) {
      alert("Operador não encontrado.");
      return;
    }
    setSalvando(true);
    try {
      const usuario = await pegarUsuarioLogado();
      const agora = new Date().toISOString();
      const anteriorNome =
        alunoSelecionado.responsavel_atual_nome || "Sem responsável anterior";
      const anteriorEmail = alunoSelecionado.responsavel_atual_email || null;
      // Troca de responsavel via RPC manual segura (executor; so Amanda/Fernanda).
      void usuario; void agora; void anteriorNome; void anteriorEmail;
      const { data: rResp, error: updateError } = await supabase.rpc("alterar_responsavel_aluno", {
        p_aluno_id: alunoSelecionado.id,
        p_novo_email: novoOperador.email,
        p_motivo: motivo,
        p_origem: "ficha_aluno",
        p_modo: "ALTERAR_SOMENTE_ALUNO",
      });
      if (updateError || !rResp?.ok) {
        alert("Nao foi possivel alterar o responsavel: " + (rResp?.erro || updateError?.message || "erro"));
        return;
      }
      const extraAluno = {};
      if (novaDataRetornoAlteracao) { extraAluno.data_retorno = paraDataLocalBR(new Date(novaDataRetornoAlteracao).toISOString()); }
      if (novaTabulacaoAlteracao) { extraAluno.status_jornada = novaTabulacaoAlteracao; extraAluno.status_atual = novaTabulacaoAlteracao; }
      if (Object.keys(extraAluno).length > 0) { await supabase.from("alunos").update(extraAluno).eq("id", alunoSelecionado.id); }
      setNovoOperadorEmail("");
      setMotivoAlteracaoOperador("");
      setNovaDataRetornoAlteracao("");
      setNovaTabulacaoAlteracao("");
      await recarregarAlunoSelecionado(alunoSelecionado.id);
      await carregarMovimentacoes(alunoSelecionado.id);
      alert("Operador responsável alterado com sucesso.");
    } catch (e) {
      console.error(e);
      alert("Erro inesperado ao alterar operador.");
    } finally {
      setSalvando(false);
    }
  }
  return (
    <div style={pagina}>
      <div style={cabecalho}>
        <div>
          <h1 style={titulo}>Atendimento do aluno</h1>
          <p style={subtitulo}>
            Ficha do aluno, finalização do atendimento, data de retorno e movimentações.
          </p>
          {usuarioLogado && (
            <p style={usuarioTexto}>
              Usuário logado: <strong>{usuarioLogado.nome}</strong>
              {usuarioLogado.email ? ` - ${usuarioLogado.email}` : ""}
            </p>
          )}
          {origemAbertura && (
            <p style={origemTexto}>
              {origemAbertura}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={carregarAlunos}
          disabled={carregando}
          style={botaoSecundario}
        >
          {carregando ? "Carregando..." : "Atualizar"}
        </button>
      </div>
      <div style={caixa}>
        <label style={label}>Buscar aluno por nome ou CPF</label>
        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
          <input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") carregarAlunos();
            }}
            placeholder="Digite nome, CPF ou telefone"
            style={input}
          />
          <button
            type="button"
            onClick={carregarAlunos}
            disabled={carregando}
            style={botaoSecundario}
          >
            Pesquisar
          </button>
        </div>
        {erro && <p style={{ color: "#f87171" }}>{erro}</p>}
      </div>
      <div style={layout}>
        <div style={caixa}>
          <h2 style={tituloSecao}>Alunos</h2>
          {carregando ? (
            <p style={textoCinza}>Carregando...</p>
          ) : alunos.length === 0 ? (
            <p style={textoCinza}>Nenhum aluno encontrado.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              {[...alunos]
                .sort((a, b) => grupoFinalAluno(a) - grupoFinalAluno(b))
                .map((aluno) => {
                const nome = pegarCampo(
                  aluno,
                  ["nome", "nome_aluno", "aluno"],
                  "Aluno sem nome"
                );
                const cpf = pegarCampo(aluno, ["cpf", "CPF"], "-");
                const status = pegarCampo(
                  aluno,
                  ["status_jornada", "status_atual", "status"],
                  "CONTATAR"
                );
                const proximaAcao = pegarCampo(
                  aluno,
                  ["proxima_acao"],
                  "CONTATAR"
                );
                const responsavel =
                  aluno.responsavel_atual_nome || "Sem responsável";
                const selecionado = alunoSelecionado?.id === aluno.id;
                const bloqueado = STATUS_BLOQUEADOS_ACIONAMENTO.includes(status);
                const quitado = STATUS_QUITADOS.includes(status);
                const temProcesso = STATUS_COM_PROCESSO.includes(status);
                const fa = finAlunos[String(aluno.id)];
                const temDetFin = !!(fa && fa.temDetalhe);
                const fallbackFin = Number(aluno.valor_em_aberto || 0);
                return (
                  <button
                    type="button"
                    key={aluno.id}
                    onClick={() => abrirAluno(aluno)}
                    style={{
                      ...cardAlunoLista,
                      background: selecionado
                        ? "#eff6ff"
                        : quitado
                        ? "#fffbeb"
                        : bloqueado
                        ? "#fef2f2"
                        : "#fff",
                      borderColor: selecionado
                        ? "#93c5fd"
                        : quitado
                        ? "#f5c98a"
                        : bloqueado
                        ? "#fca5a5"
                        : "#eef2f6",
                    }}
                  >
                    <div style={colId}>
                      <div style={nomeCelA}>{nome}</div>
                      {aluno.telefone && <div style={subCelA}>{aluno.telefone}</div>}
                      {(aluno.unidade || aluno.curso) && (
                        <div style={subCelA}>
                          {[aluno.unidade, aluno.curso].filter(Boolean).join(" · ")}
                        </div>
                      )}
                      <div style={subCelA}>CPF: {cpf}</div>
                    </div>
                    <div style={colStatus}>
                      <span style={badgeSituacaoA}>
                        {({ CONTATAR: "A contatar", MENSAGEM_ENVIADA: "Mensagem enviada", EM_ATENDIMENTO: "Em atendimento", ALUNO_EM_NEGOCIACAO_24H: "Em negociação", RETORNAR_DEPOIS: "Retornar depois", SEM_RETORNO: "Sem retorno", NAO_LOCALIZADO: "Não localizado", AGUARDANDO_LINK: "Aguardando link", SOLICITADO_LINK: "Link solicitado", LINK_PRONTO_PARA_ENVIO: "Link pronto p/ envio", LINK_ENVIADO_AO_ALUNO: "Link enviado ao aluno", AGUARDANDO_COMPROVANTE: "Aguardando comprovante", AGUARDANDO_BAIXA: "Aguardando baixa", BAIXA_REALIZADA: "Baixa realizada", BAIXA_DEVOLVIDA: "Baixa devolvida", ACORDO_FECHADO: "Acordo fechado", LEMBRETE_PARCELA: "Lembrete de parcela feito", TERMO_ENVIADO_ALUNO: "Termo enviado ao aluno", TERMO_ENVIADO_ADM: "Enviado ao ADM", ENVIADO_FINANCEIRO: "Enviado ao financeiro" }[status]) || STATUS_BLOQUEADOS_LABEL[status] || status}
                      </span>
                      <div style={subCelA}>
                        Últ. contato: {formatarDataHora(aluno.data_ultimo_acionamento)}
                      </div>
                      <div style={subCelA}>
                        Próx. contato: {formatarDataHora(aluno.data_retorno)}
                      </div>
                      {quitado ? (
                        <div style={{ ...subCelA, color: "#b45309", fontWeight: 700 }}>
                          ✓ Quitado
                        </div>
                      ) : bloqueado ? (
                        <div style={{ ...subCelA, color: "#b42318", fontWeight: 700 }}>
                          ⚠️ Não acionar
                        </div>
                      ) : null}
                    </div>
                    <div style={colFin}>
                      {temDetFin ? (
                        <>
                          <div style={emAbertoTotalA}>Total em aberto: {moeda(fa.total)}</div>
                          <div style={emAbertoSubA}>Mensalidades: {moeda(fa.mensalidades)}</div>
                          <div style={emAbertoSubA}>Acordos: {moeda(fa.acordos)}</div>
                          {fa.qtdNegociadas > 0 && (
                            <div style={emAbertoSubA}>
                              Negociadas em acordo: {moeda(fa.negociadas)} ({fa.qtdNegociadas}) — já
                              contabilizadas em Acordos
                            </div>
                          )}
                        </>
                      ) : fallbackFin > 0 ? (
                        <div style={emAbertoTotalA}>Total em aberto: {moeda(fallbackFin)}</div>
                      ) : (
                        <div style={emAbertoSubA}>Sem valor em aberto</div>
                      )}
                    </div>
                    <div style={colOp}>
                      <div style={subCelA}>Resp.: {responsavel}</div>
                      {temProcesso ? (
                        <>
                          <div style={subCelA}>Processo: {aluno.processo_numero || "-"}</div>
                          <div style={subCelA}>
                            Prazo:{" "}
                            {aluno.processo_prazo_tipo === "INDETERMINADO"
                              ? "Indeterminado"
                              : formatarDataHora(aluno.processo_prazo_data)}
                          </div>
                        </>
                      ) : (
                        <div style={subCelA}>Próx. ação: {proximaAcao}</div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <div style={caixa}>
          <span id="ficha-aluno" />{!alunoSelecionado ? (
            <div>
              <h2 style={tituloSecao}>Ficha do aluno</h2>
              <p style={textoCinza}>
                Selecione um aluno na lista ou abra pela fila do operador.
              </p>
            </div>
          ) : (
            <>
              {(() => {
                const statusFicha = pegarCampo(
                  alunoSelecionado,
                  ["status_jornada", "status_atual", "status"],
                  "CONTATAR"
                );
                const fichaQuitada = STATUS_QUITADOS.includes(statusFicha);
                const fichaRestrita =
                  STATUS_BLOQUEADOS_ACIONAMENTO.includes(statusFicha);
                const fichaBloqueadaParaMim =
                  fichaRestrita && !podeVerTudo(usuarioLogado?.email);
                if (fichaQuitada) {
                  return (
                    <div
                      style={{
                        background: "#78350f",
                        color: "#fde68a",
                        border: "1px solid #facc15",
                        borderRadius: 10,
                        padding: "12px 14px",
                        marginBottom: 14,
                        fontWeight: 700,
                      }}
                    >
                      ✓ {STATUS_BLOQUEADOS_LABEL[statusFicha] || "Quitado"} — sem
                      parcelas em aberto. Volta pra fila automaticamente se subir
                      um título novo dele num bordero.
                    </div>
                  );
                }
                return fichaRestrita ? (
                  <div
                    style={{
                      background: "#7f1d1d",
                      color: "#fecaca",
                      borderRadius: 10,
                      padding: "12px 14px",
                      marginBottom: 14,
                      fontWeight: 700,
                    }}
                  >
                    ⚠️ {STATUS_BLOQUEADOS_LABEL[statusFicha]} — este caso não pode
                    ser acionado{fichaBloqueadaParaMim ? " por operadores" : ""}.
                    {alunoSelecionado.observacao
                      ? ` ${alunoSelecionado.observacao}`
                      : ""}
                  </div>
                ) : null;
              })()}
              {vindoDaFila && (
                <button
                  type="button"
                  onClick={() => navigate("/minha-fila")}
                  style={{
                    background: "transparent",
                    border: "1px solid #374151",
                    color: "#d1d5db",
                    borderRadius: 8,
                    padding: "8px 14px",
                    marginBottom: 14,
                    cursor: "pointer",
                    fontWeight: 700,
                  }}
                >
                  ← Voltar para a fila
                </button>
              )}
              <div style={topoFicha}>
                <div style={topoFichaIdentificacao}>
                  {editandoCadastro ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 340 }}>
                      <input
                        value={nomeEditado}
                        onChange={(e) => setNomeEditado(e.target.value)}
                        placeholder="Nome do aluno"
                        style={inputCheio}
                      />
                      <input
                        value={cpfEditado}
                        onChange={(e) => setCpfEditado(e.target.value)}
                        placeholder="CPF do aluno"
                        style={inputCheio}
                      />
                      <input
                        value={telefoneEditado}
                        onChange={(e) => setTelefoneEditado(e.target.value)}
                        placeholder="Telefone (com DDD)"
                        style={inputCheio}
                      />
                      <input
                        value={emailEditado}
                        onChange={(e) => setEmailEditado(e.target.value)}
                        placeholder="E-mail"
                        style={inputCheio}
                      />
                      <div style={{ display: "flex", gap: 8 }}>
                        <button
                          type="button"
                          onClick={salvarCadastroAluno}
                          disabled={salvandoCadastro}
                          style={botaoPrincipal}
                        >
                          {salvandoCadastro ? "Salvando..." : "Salvar"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditandoCadastro(false)}
                          disabled={salvandoCadastro}
                          style={botaoSecundario}
                        >
                          Cancelar
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <h2 style={{ ...nomeAlunoFicha, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        {pegarCampo(
                          alunoSelecionado,
                          ["nome", "nome_aluno", "aluno"],
                          "Aluno sem nome"
                        )}
                        {(() => {
                          const nomeAluno = pegarCampo(
                            alunoSelecionado,
                            ["nome", "nome_aluno", "aluno"],
                            ""
                          );
                          if (!nomeAluno || nomeAluno === "Aluno sem nome") return null;
                          const copiado = nomeCopiado === nomeAluno;
                          return (
                            <button
                              type="button"
                              title="Copiar nome"
                              onClick={async () => {
                                try {
                                  await navigator.clipboard.writeText(nomeAluno);
                                } catch {
                                  const ta = document.createElement("textarea");
                                  ta.value = nomeAluno;
                                  document.body.appendChild(ta);
                                  ta.select();
                                  document.execCommand("copy");
                                  document.body.removeChild(ta);
                                }
                                setNomeCopiado(nomeAluno);
                                setTimeout(() => setNomeCopiado(null), 1500);
                              }}
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 4,
                                fontSize: 12,
                                fontWeight: 700,
                                padding: "4px 10px",
                                borderRadius: 8,
                                cursor: "pointer",
                                background: copiado ? "#dcfce7" : "#f1f5f9",
                                color: copiado ? "#166534" : "#334155",
                                border: `1px solid ${copiado ? "#bbf7d0" : "#e2e8f0"}`,
                              }}
                            >
                              {copiado ? "✓ Copiado" : "📋 Copiar"}
                            </button>
                          );
                        })()}
                      </h2>
                      {/* Selos de status (visão rápida). Saldo e responsável ficam
                          no bloco de decisão, à direita -- aqui seria repetição. */}
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, margin: "8px 0 6px" }}>
                        <span style={{ fontSize: 12, fontWeight: 700, padding: "4px 11px", borderRadius: 999, background: "#f1f5f9", color: "#475569", border: "1px solid #d5dde7" }}>
                          {rotuloStatusComSaldo(
                            pegarCampo(alunoSelecionado, ["status_jornada", "status_atual", "status"], "CONTATAR"),
                            saldoStatus === "ok" ? !fichaComPendencia : null
                          )}
                        </span>
                        {(alunoSelecionado.nivel_criticidade || alunoSelecionado.criticidade) && (() => {
                          const c = String(alunoSelecionado.nivel_criticidade || alunoSelecionado.criticidade).toUpperCase();
                          // CRITICO/URGENTE vem PREENCHIDO: sao os unicos chips
                          // fortes da ficha, pra serem a primeira coisa lida.
                          // ATENCAO/NORMAL ficam suaves -- nao pedem acao imediata.
                          const mapa = { CRITICO: ["#b91c1c", "#fff", "#991b1b"], URGENTE: ["#c2410c", "#fff", "#9a3412"], ATENCAO: ["#fef9c3", "#854d0e", "#fde68a"], NORMAL: ["#f1f5f9", "#475569", "#d5dde7"] };
                          const [bg, fg, bd] = mapa[c] || mapa.NORMAL;
                          return <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: "0.03em", padding: "4px 11px", borderRadius: 999, background: bg, color: fg, border: `1px solid ${bd}` }}>{c}</span>;
                        })()}
                      </div>
                      <PainelDesfazer
                        alunoId={alunoSelecionado?.id}
                        atualizarEm={desfazerTick}
                        onDesfeito={async () => {
                          await recarregarAlunoSelecionado(alunoSelecionado.id);
                          await carregarMovimentacoes(alunoSelecionado.id);
                          await carregarAlunos();
                        }}
                      />
                      <p style={textoInfo}>
                        CPF: {pegarCampo(alunoSelecionado, ["cpf", "CPF"], "-")}
                        <button
                          type="button"
                          onClick={abrirEdicaoCadastro}
                          style={{
                            marginLeft: 10,
                            background: "none",
                            border: "none",
                            color: "#1d4ed8",
                            cursor: "pointer",
                            textDecoration: "underline",
                            fontSize: 13,
                          }}
                        >
                          Corrigir nome/CPF
                        </button>
                      </p>
                      {/* Telefone e e-mail saem daqui: o cartao "Contatos do aluno"
                          logo abaixo e a fonte de verdade -- ele lista TODOS os
                          numeros, marca o principal e mostra os invalidados. Esta
                          linha lia o campo antigo do cadastro, que guarda um so
                          contato, e as duas coisas podiam divergir. */}
                      {/* Unidade/curso saem daqui: o card Dados Acadêmicos logo
                          abaixo já traz campus, curso e modalidade. O saldo sai
                          daqui: vive no bloco de decisão, à direita. */}
                    </>
                  )}
                </div>
                {/* Bloco de decisão: o que o operador precisa pra agir, sem rolar.
                    Valor e responsável vivem aqui -- e só aqui. */}
                <div style={blocoDecisao}>
                  <div
                    style={{
                      ...blocoDecisaoItem,
                      // A faixa so pode ser ambar quando REALMENTE ha saldo.
                      // Em erro/carregando ela seria uma mentira: sinalizaria
                      // divida sem que ninguem tenha conseguido ler o saldo.
                      borderLeft: `4px solid ${
                        saldoStatus === "erro"
                          ? "#dc2626"
                          : saldoStatus !== "ok"
                            ? "#cbd5e1"
                            : fichaComPendencia
                              ? "#f59e0b"
                              : "#16a34a"
                      }`,
                      background:
                        saldoStatus === "ok" && fichaComPendencia ? "#fffbeb" : "#f8fafc",
                    }}
                  >
                    <span style={cardTitulo}>Valor em aberto</span>
                    {saldoStatus === "carregando" && (
                      <div style={{ color: "#64748b", fontSize: 13 }}>Carregando saldo…</div>
                    )}
                    {saldoStatus === "erro" && (
                      <div>
                        <span style={{ color: "#dc2626", fontWeight: 700, fontSize: 13 }}>
                          Saldo indisponível
                        </span>
                        <button
                          type="button"
                          onClick={() => recarregarSaldoFicha(alunoSelecionado?.id)}
                          style={{ marginLeft: 8, border: "1px solid #cbd5e1", background: "#fff", color: "#475569", borderRadius: 6, padding: "2px 8px", fontSize: 12, cursor: "pointer" }}
                        >
                          Tentar novamente
                        </button>
                      </div>
                    )}
                    {saldoStatus === "ok" && (
                      <>
                        <div
                          style={{
                            fontSize: 22,
                            fontWeight: 800,
                            lineHeight: 1.15,
                            color: fichaComPendencia ? "#b45309" : "#15803d",
                          }}
                        >
                          {moeda(Number(saldoFicha?.total) || 0)}
                        </div>
                        <div style={{ fontSize: 12, fontWeight: 600, color: "#475569", marginTop: 2 }}>
                          {fichaComPendencia ? "Com saldo em aberto" : "Sem saldo pendente"}
                          {fichaComPendencia &&
                            Number(saldoFicha?.parcelas_abertas_qtd) > 0 &&
                            ` · ${saldoFicha.parcelas_abertas_qtd} ${
                              Number(saldoFicha.parcelas_abertas_qtd) === 1
                                ? "parcela"
                                : "parcelas"
                            } de acordo em aberto`}
                          {fichaComPendencia &&
                            Number(saldoFicha?.confirmacoes_pendentes) > 0 &&
                            " · confirmação/baixa pendente"}
                        </div>
                      </>
                    )}
                  </div>
                  <div
                    style={{
                      ...blocoDecisaoItem,
                      borderLeft: `4px solid ${
                        alunoSelecionado.responsavel_atual_nome ? "#2563eb" : "#94a3b8"
                      }`,
                    }}
                  >
                    <span style={cardTitulo}>Responsável pelo aluno</span>
                    {!editandoOperadorRapido ? (
                      <div style={{ fontSize: 14, fontWeight: 700, color: "#0f172a" }}>
                        {alunoSelecionado.responsavel_atual_nome || (
                          <span style={{ color: "#64748b", fontWeight: 600 }}>Sem responsável</span>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            setNovoOperadorEmail(alunoSelecionado.responsavel_atual_email || "");
                            setEditandoOperadorRapido(true);
                          }}
                          style={{ marginLeft: 8, border: "none", background: "transparent", cursor: "pointer", fontSize: 13 }}
                          title="Alterar operador responsável"
                        >
                          ✏️
                        </button>
                      </div>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
                        <select
                          value={novoOperadorEmail}
                          onChange={(e) => setNovoOperadorEmail(e.target.value)}
                          style={{ padding: "4px 6px", borderRadius: 6, border: "1px solid #cbd5e1", fontSize: 12 }}
                        >
                          <option value="">Selecione</option>
                          {OPERADORES_REATIVA.map((op) => (
                            <option key={op.email} value={op.email}>
                              {op.nome}
                            </option>
                          ))}
                        </select>
                        <input
                          type="text"
                          placeholder="Motivo da troca (opcional)"
                          value={motivoAlteracaoOperador}
                          onChange={(e) => setMotivoAlteracaoOperador(e.target.value)}
                          style={{ padding: "4px 6px", borderRadius: 6, border: "1px solid #cbd5e1", fontSize: 12 }}
                        />
                        <div style={{ display: "flex", gap: 6 }}>
                          <button
                            type="button"
                            onClick={async () => {
                              await alterarOperadorResponsavel();
                              setEditandoOperadorRapido(false);
                            }}
                            disabled={salvando || !novoOperadorEmail}
                            style={{ border: "none", background: "#16a34a", color: "#fff", borderRadius: 6, padding: "4px 8px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}
                          >
                            {salvando ? "..." : "Salvar"}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setEditandoOperadorRapido(false);
                              setMotivoAlteracaoOperador("");
                            }}
                            style={{ border: "1px solid #cbd5e1", background: "#fff", color: "#475569", borderRadius: 6, padding: "4px 8px", fontSize: 12, cursor: "pointer" }}
                          >
                            Cancelar
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                  {(!alunoSelecionado.responsavel_atual_email ||
                    (podeQuitarManual(usuarioLogado?.email) &&
                      pegarCampo(
                        alunoSelecionado,
                        ["status_jornada", "status_atual", "status"],
                        "CONTATAR"
                      ) !== STATUS_QUITADO_MANUAL)) && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                      {!alunoSelecionado.responsavel_atual_email && (
                        <button
                          type="button"
                          onClick={assumirAtendimento}
                          disabled={
                            salvando ||
                            (STATUS_BLOQUEADOS_ACIONAMENTO.includes(
                              pegarCampo(
                                alunoSelecionado,
                                ["status_jornada", "status_atual", "status"],
                                "CONTATAR"
                              )
                            ) &&
                              !podeVerTudo(usuarioLogado?.email))
                          }
                          style={{ ...botaoPrincipal, flex: "1 1 auto" }}
                        >
                          {salvando ? "Salvando..." : "Assumir atendimento"}
                        </button>
                      )}
                      {podeQuitarManual(usuarioLogado?.email) &&
                        pegarCampo(
                          alunoSelecionado,
                          ["status_jornada", "status_atual", "status"],
                          "CONTATAR"
                        ) !== STATUS_QUITADO_MANUAL && (
                          <button
                            type="button"
                            onClick={quitarManual}
                            disabled={salvando}
                            title="Tira o aluno da fila (ficha fica amarela). Volta sozinho se subir um título novo dele em bordero."
                            style={botaoQuitarTudo}
                          >
                            💰 Quitar tudo (sai da fila)
                          </button>
                        )}
                    </div>
                  )}
                </div>
              </div>
              {/* Ordem da ficha = frequencia de uso. A faixa diz ONDE o caso
                  esta, tabular e O QUE o operador faz o dia inteiro, e o
                  academico e so referencia -- por isso vem por ultimo. */}
              <div style={faixaMini}>
                <div style={{ ...itemMini, borderLeft: "none" }}>
                  <span style={cardTitulo}>Últ. acionamento</span>
                  <div style={valorMini}>{formatarDataHora(alunoSelecionado.data_ultimo_acionamento)}</div>
                </div>
                <div style={itemMini}>
                  <span style={cardTitulo}>Data de retorno</span>
                  <div style={valorMini}>{formatarDataHora(alunoSelecionado.data_retorno)}</div>
                </div>
                <div style={{ ...itemMini, flex: "2 1 200px" }}>
                  <span style={cardTitulo}>Próxima ação</span>
                  <div style={valorMini}>{rotuloStatus(alunoSelecionado.proxima_acao || "CONTATAR")}</div>
                </div>
                <div style={itemMini}>
                  <span style={cardTitulo}>Últ. tabulação</span>
                  <div style={valorMini}>{formatarDataHora(alunoSelecionado.registrado_em)}</div>
                </div>
                <div style={itemMini}>
                  <span style={cardTitulo}>Status</span>
                  <div style={valorMini}>{rotuloStatus(alunoSelecionado.status_acionamento) || "-"}</div>
                </div>
              </div>
              <div style={caixaTabular}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 13, fontWeight: 800, color: "#1e3a8a", whiteSpace: "nowrap" }}>
                    Tabular:
                  </span>
                <select
                  value={statusFinalizacao}
                  onChange={(e) => {
                    // Foi ela quem trocou: pode rolar ate o bloco.
                    rolarAoTrocarRef.current = true;
                    setStatusFinalizacao(e.target.value);
                  }}
                  style={{ ...select, width: "auto", flex: 1, minWidth: 220, marginBottom: 0 }}
                >
                  {STATUS_FINALIZACAO.filter(
                    (status) =>
                      !STATUS_BLOQUEADOS_ACIONAMENTO.includes(status) ||
                      podeVerTudo(usuarioLogado?.email)
                  ).map((status) => (
                    <option key={status} value={status}>
                      {({ CONTATAR: "A contatar", MENSAGEM_ENVIADA: "Mensagem enviada", EM_ATENDIMENTO: "Em atendimento", ALUNO_EM_NEGOCIACAO_24H: "Em negociação", RETORNAR_DEPOIS: "Retornar depois", SEM_RETORNO: "Sem retorno", NAO_LOCALIZADO: "Não localizado", AGUARDANDO_LINK: "Aguardando link", SOLICITADO_LINK: "Link solicitado", LINK_PRONTO_PARA_ENVIO: "Link pronto p/ envio", LINK_ENVIADO_AO_ALUNO: "Link enviado ao aluno", AGUARDANDO_COMPROVANTE: "Aguardando comprovante", AGUARDANDO_BAIXA: "Aguardando baixa", BAIXA_REALIZADA: "Baixa realizada", BAIXA_DEVOLVIDA: "Baixa devolvida", ACORDO_FECHADO: "Acordo fechado", LEMBRETE_PARCELA: "Lembrete de parcela feito", TERMO_ENVIADO_ALUNO: "Termo enviado ao aluno", TERMO_ENVIADO_ADM: "Enviado ao ADM", ENVIADO_FINANCEIRO: "Enviado ao financeiro" }[status]) || STATUS_BLOQUEADOS_LABEL[status] || status}
                    </option>
                  ))}
                </select>
                </div>
                {statusFinalizacao === "ELOGIO_ATENDIMENTO" && (
                  <div style={{ ...caixaInterna, marginTop: "10px", marginBottom: "10px" }}>
                    <label style={label}>Anexar print do elogio (opcional)</label>
                    <input
                      type="file"
                      accept="image/*,.pdf"
                      onChange={(e) => setElogioArquivo(e.target.files?.[0] || null)}
                      style={inputCheio}
                    />
                    {elogioArquivo && (
                      <p style={{ fontSize: "12px", color: "#16a34a", margin: "6px 0 0" }}>
                        Selecionado: {elogioArquivo.name}
                      </p>
                    )}
                  </div>
                )}
                {STATUS_COM_PROCESSO.includes(statusFinalizacao) && (
                  <div style={{ ...caixaInterna, marginTop: "10px", marginBottom: "10px" }}>
                    <label style={label}>Número do processo</label>
                    <input
                      type="text"
                      value={numeroProcesso}
                      onChange={(e) => setNumeroProcesso(e.target.value)}
                      placeholder="Número do processo"
                      style={inputCheio}
                    />
                    <label style={label}>Prazo</label>
                    <div style={{ display: "flex", gap: "16px", alignItems: "center", marginBottom: "8px" }}>
                      <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "13px" }}>
                        <input
                          type="radio"
                          checked={prazoTipo === "DATA"}
                          onChange={() => setPrazoTipo("DATA")}
                        />
                        Data específica
                      </label>
                      <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "13px" }}>
                        <input
                          type="radio"
                          checked={prazoTipo === "INDETERMINADO"}
                          onChange={() => setPrazoTipo("INDETERMINADO")}
                        />
                        Indeterminado
                      </label>
                    </div>
                    {prazoTipo === "DATA" ? (
                      <input
                        type="date"
                        value={prazoData}
                        onChange={(e) => setPrazoData(e.target.value)}
                        style={inputCheio}
                      />
                    ) : (
                      <p style={{ fontSize: "12px", color: "#f59e0b", margin: 0 }}>
                        Prazo indeterminado: esse caso vai entrar na lista "⚖️ Jurídico - prazo
                        indeterminado" na Fila Operacional pra Amanda cobrar retorno do jurídico.
                      </p>
                    )}
                  </div>
                )}
                <label style={label}>Data e horário de retorno</label>
                <input
                  type="datetime-local"
                  value={dataRetorno}
                  onChange={(e) => setDataRetorno(e.target.value)}
                  style={inputCheio}
                />
                <label style={label}>Observação da finalização</label>
                <textarea
                  value={observacao}
                  onChange={(e) => setObservacao(e.target.value)}
                  placeholder="Digite a observação do atendimento..."
                  rows={2}
                  style={textarea}
                />
                <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
                  <button
                    type="button"
                    onClick={finalizarAtendimento}
                    disabled={
                      salvando ||
                      (STATUS_BLOQUEADOS_ACIONAMENTO.includes(
                        pegarCampo(
                          alunoSelecionado,
                          ["status_jornada", "status_atual", "status"],
                          "CONTATAR"
                        )
                      ) &&
                        !podeVerTudo(usuarioLogado?.email))
                    }
                    style={botaoPrincipal}
                  >
                    {salvando ? "Salvando..." : "Atualizar"}
                  </button>
                  <button
                    type="button"
                    onClick={solicitarLinkPagamento}
                    disabled={salvando}
                    style={botaoSecundario}
                  >
                    Solicitar link
                  </button>
                </div>
              </div>
              <DadosAcademicos aluno={alunoSelecionado} />
              <div style={barraAbasFicha}>
                {[
                  ["dados", "Resumo e tabulação"],
                  ...(emailLiberadoAluno ? [["email", "📧 E-mail"]] : []),
                  ["financeiro", "Financeiro"],
                  ["adm", "ADM"],
                ].map(([chave, rotulo]) => (
                  <button
                    key={chave}
                    type="button"
                    onClick={() => setAbaFicha(chave)}
                    style={
                      abaFicha === chave ? abaFichaAtiva : abaFichaInativa
                    }
                  >
                    {rotulo}
                  </button>
                ))}
              </div>
              {abaFicha === "dados" && (
              <>
              <div style={gradeCards}>
                <div style={{ ...cardInfo, gridColumn: "1 / -1" }}>
                  <span style={cardTitulo}>Responsável pelos acordos</span>
                  {acordosStatus === "carregando" && (
                    <span style={{ color: "#94a3b8" }}>Carregando…</span>
                  )}
                  {acordosStatus === "erro" && (
                    <span>
                      <span style={{ color: "#ef4444" }}>Acordos indisponíveis</span>
                      <button
                        type="button"
                        onClick={() => recarregarAcordosFicha(alunoSelecionado?.id)}
                        style={{ marginLeft: 8, border: "1px solid #cbd5e1", background: "#fff", color: "#475569", borderRadius: 6, padding: "2px 8px", fontSize: 12, cursor: "pointer" }}
                      >
                        Tentar novamente
                      </button>
                    </span>
                  )}
                  {acordosStatus === "ok" && acordosFicha.length === 0 && (
                    <span style={{ color: "#64748b" }}>Nenhum acordo registrado</span>
                  )}
                  {acordosStatus === "ok" && acordosFicha.length > 0 && (
                    <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 8 }}>
                      {(verTodosAcordos ? acordosFicha : acordosFicha.slice(0, 1)).map(
                        (a, i) => {
                          const sit = situacaoDoAcordo(a);
                          return (
                            <div key={a.id}>
                              {acordosFicha.length > 1 && (
                                <div style={{ fontSize: 12, color: "#94a3b8", fontWeight: 700 }}>
                                  {i === 0 ? "Acordo atual" : "Acordo anterior"}
                                </div>
                              )}
                              <div>
                                <strong style={{ color: "#0f172a" }}>
                                  {responsavelDoAcordo(a)}
                                </strong>{" "}
                                · {dataCurta(a.criado_em)} ·{" "}
                                <span style={{ color: corSituacaoAcordo(sit), fontWeight: 700 }}>
                                  {sit}
                                </span>
                              </div>
                              {a._titulos && a._titulos.length > 0 ? (
                                <Dobra
                                  titulo="Mensalidades negociadas neste acordo"
                                  contador={a._titulos.length}
                                  resumo={`${moeda(somaTitulos(a._titulos))} — já representadas pelas parcelas; não somam ao total em aberto`}
                                  style={{ marginTop: 6 }}
                                >
                                  <div style={tabNegHead}>
                                    <span>Documento</span>
                                    <span>Competência</span>
                                    <span>Vencimento</span>
                                    <span>Situação</span>
                                    <span style={{ textAlign: "right" }}>Valor</span>
                                  </div>
                                  {a._titulos.map((t) => (
                                    <div key={t.id} style={tabNegLinha}>
                                      <span>{t.documento || "—"}</span>
                                      <span>{t.competencia || "—"}</span>
                                      <span>{dataCurta(t.vencimento)}</span>
                                      <span>{t.situacao || "—"}</span>
                                      <span style={{ textAlign: "right", fontWeight: 600 }}>
                                        {moeda(valorTitulo(t))}
                                      </span>
                                    </div>
                                  ))}
                                  <div style={tabNegRodape}>
                                    <span>
                                      {a._titulos.length}{" "}
                                      {a._titulos.length === 1 ? "mensalidade" : "mensalidades"} · vinculadas
                                      {a._titulos[0]?.vinculado_em
                                        ? ` desde ${dataCurta(a._titulos[0].vinculado_em)}`
                                        : ""}
                                    </span>
                                    <strong>{moeda(somaTitulos(a._titulos))}</strong>
                                  </div>
                                </Dobra>
                              ) : null}
                            </div>
                          );
                        }
                      )}
                      {acordosFicha.length > 1 && (
                        <button
                          type="button"
                          onClick={() => setVerTodosAcordos((v) => !v)}
                          style={{ alignSelf: "flex-start", border: "1px solid #cbd5e1", background: "#fff", color: "#475569", borderRadius: 6, padding: "3px 10px", fontSize: 12, cursor: "pointer" }}
                        >
                          {verTodosAcordos
                            ? "Ver menos"
                            : `Ver todos os acordos (${acordosFicha.length})`}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
              <TelefonesAluno aluno={alunoSelecionado} />
              </>
              )}
              {(abaFicha === "dados" || abaFicha === "tabulacoes") && (
              <>
              {[
                "LINK_PRONTO_PARA_ENVIO",
                "LINK_GERADO",
              ].includes(
                pegarCampo(
                  alunoSelecionado,
                  ["status_jornada", "status_atual", "status"],
                  "CONTATAR"
                )
              ) ||
              alunoSelecionado.proxima_acao === "ENVIAR_LINK_AO_ALUNO" ? (
                <div style={caixaLinkPronto}>
                  <h3 style={tituloSecao}>Link pronto para envio</h3>
                  <p style={textoInfo}>
                    Este aluno está com link pronto. Depois de enviar o link ao aluno,
                    clique abaixo para mudar o caso para aguardando comprovante.
                  </p>
                  <button
                    type="button"
                    onClick={marcarLinkEnviadoAoAluno}
                    disabled={salvando}
                    style={botaoPrincipal}
                  >
                    {salvando
                      ? "Salvando..."
                      : "Link enviado ao aluno / Aguardar comprovante"}
                  </button>
                </div>
              ) : null}
              <Dobra
                titulo="Link de pagamento"
                refBloco={(el) => (blocosRef.current.link = el)}
                aberto={blocoAberto === "link"}
                onAlternar={(abriu) => setBlocoAberto(abriu ? "link" : (blocoAberto === "link" ? "" : blocoAberto))}
                style={{ ...blocoFicha, borderColor: blocoAberto === "link" ? "#2563eb" : undefined }}
              >
              <LinksPagamentoAluno
                aluno={alunoSelecionado}
                usuarioLogado={usuarioLogado}
                destacarSolicitacaoId={destacarLinkId}
                onAtualizar={async () => {
                  await recarregarAlunoSelecionado(alunoSelecionado.id);
                  await carregarMovimentacoes(alunoSelecionado.id);
                  await carregarAlunos();
                }}
                onSucesso={async () => {
                  await recarregarAlunoSelecionado(alunoSelecionado.id);
                  await carregarMovimentacoes(alunoSelecionado.id);
                  await carregarAlunos();
                }}
              />
              </Dobra>
              <Dobra
                titulo="Termo de acordo"
                refBloco={(el) => (blocosRef.current.termo = el)}
                aberto={blocoAberto === "termo"}
                onAlternar={(abriu) => setBlocoAberto(abriu ? "termo" : (blocoAberto === "termo" ? "" : blocoAberto))}
                style={{ ...blocoFicha, borderColor: blocoAberto === "termo" ? "#2563eb" : undefined }}
              >
                <FinalizacaoTermo
                  aluno={alunoSelecionado}
                  onEnviado={() => setDesfazerTick((t) => t + 1)}
                />
              </Dobra>
              <Dobra
                titulo="Enviar ao financeiro"
                refBloco={(el) => (blocosRef.current.financeiro = el)}
                aberto={blocoAberto === "financeiro"}
                onAlternar={(abriu) => setBlocoAberto(abriu ? "financeiro" : (blocoAberto === "financeiro" ? "" : blocoAberto))}
                style={{ ...blocoFicha, borderColor: blocoAberto === "financeiro" ? "#2563eb" : undefined }}
              >
                <EnvioFinanceiro aluno={alunoSelecionado} />
              </Dobra>
              <Dobra
                titulo="Confirmar pagamento"
                refBloco={(el) => (blocosRef.current.confirmar = el)}
                aberto={blocoAberto === "confirmar"}
                onAlternar={(abriu) => setBlocoAberto(abriu ? "confirmar" : (blocoAberto === "confirmar" ? "" : blocoAberto))}
                style={{ ...blocoFicha, borderColor: blocoAberto === "confirmar" ? "#2563eb" : undefined }}
              >
                <ConfirmarPagamento aluno={alunoSelecionado} />
              </Dobra>
              <div style={caixaInterna}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <h3 style={tituloSecao}>Movimentações</h3>
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
                {movimentacoes.length === 0 ? (
                  <p style={textoCinza}>Nenhuma movimentação registrada.</p>
                ) : (
                  <div style={{ display: "grid", gap: "10px" }}>
                    {movimentacoes.map((mov) => (
                      <div key={mov.id} style={cardMov}>
                        <strong>{mov.tipo}</strong>
                        <p>{mov.descricao || "-"}</p>
                        <small>
                          Status: {mov.status_anterior || "-"} →{" "}
                          {mov.status_novo || "-"}
                          <br />
                          Retorno: {formatarDataHora(mov.data_retorno)}
                          <br />
                          Registrado por:{" "}
                          {mov.registrado_por_nome || "Não identificado"}
                          {mov.registrado_por_email
                            ? ` - ${mov.registrado_por_email}`
                            : ""}
                          <br />
                          Data/hora: {formatarDataHora(mov.registrado_em)}
                        </small>
                        {mov.elogio_print_path && (
                          <button
                            type="button"
                            onClick={() => abrirAnexoElogio(mov.elogio_print_path)}
                            style={{ ...botaoSecundario, marginTop: "8px", fontSize: "12px", padding: "6px 10px" }}
                          >
                            📎 Ver anexo{mov.elogio_print_nome ? `: ${mov.elogio_print_nome}` : ""}
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              </>
              )}

              {abaFicha === "financeiro" && (
                <>
                  <FinanceiroAluno aluno={alunoSelecionado} />
                </>
              )}
              {abaFicha === "email" && emailLiberadoAluno && (
                <div style={caixaInterna}>
                  <EmailAlunoUnificado
                    aluno={alunoSelecionado}
                    onTabulado={() => recarregarAlunoSelecionado(alunoSelecionado.id)}
                  />
                </div>
              )}
              {abaFicha === "adm" && (
              <>
              <div style={caixaInterna}>
                <h3 style={tituloSecao}>Alterar operador responsável</h3>
                <label style={label}>Novo operador</label>
                <select
                  value={novoOperadorEmail}
                  onChange={(e) => setNovoOperadorEmail(e.target.value)}
                  style={select}
                >
                  <option value="">Selecione</option>
                  {OPERADORES_REATIVA.map((operador) => (
                    <option key={operador.email} value={operador.email}>
                      {operador.nome} - {operador.email}
                    </option>
                  ))}
                </select>
                <label style={label}>Motivo</label>
                <textarea
                  value={motivoAlteracaoOperador}
                  onChange={(e) =>
                    setMotivoAlteracaoOperador(e.target.value)
                  }
                  placeholder="Exemplo: operador acionou antes da criação do botão assumir atendimento."
                  rows={3}
                  style={textarea}
                />
                <label style={label}>
                  Nova tabulação (opcional — deixa o caso já pronto pro novo operador)
                </label>
                <select
                  value={novaTabulacaoAlteracao}
                  onChange={(e) => setNovaTabulacaoAlteracao(e.target.value)}
                  style={select}
                >
                  <option value="">Não alterar tabulação</option>
                  {STATUS_FINALIZACAO.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                <label style={label}>Nova data de retorno (opcional)</label>
                <input
                  type="datetime-local"
                  value={novaDataRetornoAlteracao}
                  onChange={(e) => setNovaDataRetornoAlteracao(e.target.value)}
                  style={select}
                />
                <button
                  type="button"
                  onClick={alterarOperadorResponsavel}
                  disabled={salvando}
                  style={botaoPrincipal}
                >
                  Alterar responsável
                </button>
              </div>
              </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
const pagina = {
  minHeight: "calc(100vh - 56px)",
  background: "#f4f6fa",
  color: "#334155",
  // Era 28/40. Numa ficha longa, margem de pagina e o espaco que menos
  // trabalha -- o operador rola por causa dela, nao por causa do conteudo.
  padding: "18px 20px 28px",
  fontFamily: "Inter, Arial, sans-serif",
};
const cabecalho = {
  display: "flex",
  justifyContent: "space-between",
  gap: "16px",
  alignItems: "center",
  marginBottom: "16px",
  flexWrap: "wrap",
};
const titulo = {
  margin: 0,
  marginBottom: 2,
  color: "#0f172a",
  fontSize: 24,
  fontWeight: 800,
  letterSpacing: "-0.02em",
};
const subtitulo = {
  margin: "6px 0 0",
  color: "#94a3b8",
  fontSize: 13,
};
const usuarioTexto = {
  margin: "8px 0 0",
  color: "#64748b",
  fontSize: "13px",
};
const origemTexto = {
  margin: "8px 0 0",
  color: "#2563eb",
  fontSize: "13px",
};
const tituloSecao = {
  color: "#0f172a",
  marginTop: 0,
  fontSize: 16,
  fontWeight: 700,
};
// O nome do aluno e o titulo da pagina -- 16px o deixava do tamanho de um
// subtitulo qualquer, sem ancorar a leitura.
const nomeAlunoFicha = {
  ...tituloSecao,
  fontSize: 22,
  fontWeight: 800,
  letterSpacing: "-0.01em",
};
// Override local do token: a ficha e a tela mais longa do CRM, entao ela
// aperta a propria superficie sem mudar as outras telas que usam o padrao.
const caixa = { ...superficie, padding: "14px", marginBottom: "12px" };
// Moldura dos blocos dobraveis da ficha. A borda azul quando aberto e a unica
// diferenca entre eles -- o resto do visual vem do padrao em src/ui/blocos.jsx.
const blocoFicha = { marginBottom: 12, scrollMarginTop: 16 };
// Bloco de tabular: e a acao que o operador repete o dia inteiro, entao tem
// peso proprio -- borda azul e fundo levemente tintado. Nao e "mais uma caixa".
const caixaTabular = {
  ...cartao,
  background: "#f8fbff",
  border: "1px solid #93c5fd",
  borderLeft: "4px solid #2563eb",
  padding: "10px 12px",
  marginBottom: "10px",
};
const caixaLinkPronto = { ...cartaoSucesso, border: "1px solid #93c5fd", marginBottom: "16px" };
const caixaInterna = cartaoInterno;
const layout = {
  display: "grid",
  gridTemplateColumns: "1fr",
  gap: "18px",
  alignItems: "start",
};
const topoFicha = {
  display: "flex",
  justifyContent: "space-between",
  gap: "16px",
  alignItems: "start",
  flexWrap: "wrap",
  marginBottom: "10px",
};
// Coluna esquerda do topo: identificação do aluno (nome, CPF, contato).
const topoFichaIdentificacao = { flex: "1 1 340px", minWidth: 0 };
// Coluna direita: bloco de decisão. Painel próprio, com borda visível, pra
// separar do resto da ficha -- é onde ficam saldo e responsável.
const blocoDecisao = {
  flex: "0 1 340px",
  minWidth: 260,
  display: "flex",
  flexDirection: "column",
  gap: 8,
  background: "#fff",
  border: "1px solid #cbd5e1",
  borderRadius: 14,
  padding: 10,
  boxShadow: "0 1px 3px rgba(15,23,42,0.06)",
};
// Cada item do bloco tem faixa de cor à esquerda, pra ler como bloco separado.
const blocoDecisaoItem = {
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  borderRadius: 10,
  padding: "6px 10px",
};
// "Quitar tudo" é ação de gestão (tira o aluno da fila): contorno, não preenchido,
// pra não competir com "Assumir atendimento".
const botaoQuitarTudo = {
  background: "#fff",
  color: "#6b21a8",
  border: "1px solid #c4b5fd",
  borderRadius: "8px",
  padding: "10px 14px",
  fontWeight: 600,
  fontSize: 13,
  cursor: "pointer",
  flex: "1 1 auto",
};
// Barra de abas da ficha. Com a ficha compacta ela subiu na tela, e o desenho
// antigo (cinza-claro sobre branco, texto cinza) passou a ler como botao
// desligado -- a Amanda procurou a aba Financeiro e nao achou. Agora: aba
// escolhida em azul solido, as outras com borda e texto escuro. Sao ABAS, e
// tem que parecer clicaveis mesmo quando nao estao escolhidas.
const barraAbasFicha = {
  display: "flex",
  gap: "8px",
  flexWrap: "wrap",
  marginBottom: "14px",
  borderBottom: "2px solid #e2e8f0",
  paddingBottom: "10px",
};
const abaFichaBase = {
  borderRadius: "8px",
  padding: "9px 16px",
  fontSize: "13.5px",
  fontWeight: 700,
  cursor: "pointer",
};
const abaFichaAtiva = {
  ...abaFichaBase,
  background: "#2563eb",
  color: "#fff",
  border: "1px solid #2563eb",
  boxShadow: "0 1px 3px rgba(37,99,235,0.35)",
};
const abaFichaInativa = {
  ...abaFichaBase,
  background: "#fff",
  color: "#334155",
  border: "1px solid #cbd5e1",
};
const gradeCards = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
  gap: "8px",
  marginBottom: "10px",
};
// Tabela das mensalidades negociadas dentro de cada acordo. Cinco colunas
// fixas para documento, competencia, vencimento, situacao e valor -- o valor
// alinhado a direita porque e o que se le em coluna.
const tabNegGrade = {
  display: "grid",
  gridTemplateColumns: "1.4fr 0.8fr 0.9fr 0.9fr 1fr",
  gap: 8,
  fontSize: 12.5,
  alignItems: "center",
};
const tabNegHead = {
  ...tabNegGrade,
  fontWeight: 700,
  color: "#64748b",
  padding: "0 0 4px",
  borderBottom: "1px solid #e2e8f0",
};
const tabNegLinha = {
  ...tabNegGrade,
  padding: "4px 0",
  borderBottom: "1px solid #f1f5f9",
  color: "#0f172a",
};
const tabNegRodape = {
  display: "flex",
  justifyContent: "space-between",
  gap: 8,
  paddingTop: 6,
  fontSize: 12,
  color: "#475569",
};

const cardInfo = cartao;
const cardTitulo = cardTituloUI;
const faixaMini = faixaMiniUI;
const itemMini = itemMiniUI;
const valorMini = valorMiniUI;
const cardAlunoLista = {
  textAlign: "left",
  color: "#475569",
  background: "#fff",
  border: "1px solid #eef2f6",
  borderRadius: "12px",
  padding: "12px 16px",
  cursor: "pointer",
  display: "flex",
  flexWrap: "wrap",
  alignItems: "flex-start",
  gap: "18px",
  fontSize: "12.5px",
  boxShadow: "0 1px 2px rgba(15,23,42,0.04)",
};
const colId = { flex: "2 1 220px", minWidth: 0, display: "flex", flexDirection: "column", gap: 2 };
const colStatus = { flex: "1 1 150px", display: "flex", flexDirection: "column", gap: 3 };
const colFin = { flex: "1 1 150px", display: "flex", flexDirection: "column", gap: 1, alignItems: "flex-start" };
const colOp = { flex: "1 1 160px", display: "flex", flexDirection: "column", gap: 2 };
const nomeCelA = { fontWeight: 600, color: "#1e293b", fontSize: 13 };
const subCelA = { fontSize: 11.5, color: "#94a3b8" };
const badgeSituacaoA = { display: "inline-block", padding: "3px 9px", borderRadius: 999, background: "#eef2ff", color: "#4f46e5", fontSize: 10.5, fontWeight: 700, whiteSpace: "nowrap", alignSelf: "flex-start" };
const emAbertoTotalA = { fontWeight: 700, fontSize: 13, color: "#101828" };
const emAbertoSubA = { fontSize: 11, color: "#94a3b8" };
const cardMov = { ...cartao, borderLeft: "4px solid #2563eb" };
const textoInfo = {
  color: "#475569",
  margin: "3px 0",
  fontSize: 13.5,
  lineHeight: 1.4,
};
const textoCinza = {
  color: "#94a3b8",
};
const label = {
  display: "block",
  marginBottom: "3px",
  color: "#475569",
  fontSize: 11.5,
  fontWeight: 600,
};
const input = {
  flex: "1 1 280px",
  background: "#f8fafc",
  color: "#334155",
  border: "1px solid #e6eaf0",
  borderRadius: "10px",
  padding: "11px 13px",
  outline: "none",
};
const inputCheio = {
  width: "100%",
  background: "#f8fafc",
  color: "#334155",
  border: "1px solid #e6eaf0",
  borderRadius: "8px",
  padding: "7px 10px",
  fontSize: 13,
  outline: "none",
  marginBottom: "6px",
};
const select = {
  width: "100%",
  background: "#f8fafc",
  color: "#334155",
  border: "1px solid #e6eaf0",
  borderRadius: "8px",
  padding: "7px 10px",
  fontSize: 13,
  marginBottom: "6px",
};
const textarea = {
  width: "100%",
  background: "#f8fafc",
  color: "#334155",
  border: "1px solid #e6eaf0",
  borderRadius: "10px",
  padding: "12px",
  resize: "vertical",
  outline: "none",
  marginBottom: "8px",
};
const botaoPrincipal = {
  background: "#2563eb",
  color: "#fff",
  border: "none",
  borderRadius: "8px",
  padding: "10px 16px",
  fontWeight: 600,
  fontSize: 13,
  cursor: "pointer",
};
const botaoSecundario = {
  background: "#fff",
  color: "#475569",
  border: "1px solid #e6eaf0",
  borderRadius: "8px",
  padding: "9px 15px",
  fontWeight: 600,
  fontSize: 13,
  cursor: "pointer",
};
