import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../services/supabase";
import FluxoLinksRapido from "../components/FluxoLinksRapido";
import ModuloLinkPagamentoGlobal from "../components/ModuloLinkPagamentoGlobal";
import LinksPagamentoAluno from "../components/LinksPagamentoAluno";
import CadastroNovoAluno from "../components/CadastroNovoAluno";
import FinalizacaoTermo from "../components/FinalizacaoTermo";
import EnvioFinanceiro from "../components/EnvioFinanceiro";
import FinanceiroAluno from "../components/FinanceiroAluno";
import ConfirmarPagamento from "../components/ConfirmarPagamento";
import { podeVerTudo } from "../utils/operadores";
import FilaReceptivo from "../components/FilaReceptivo";
import PontoOperador from "../components/PontoOperador";
import MuralAniversariantes from "../components/MuralAniversariantes";
import ResumoDoDia from "../components/ResumoDoDia";
import ReceberLeads from "../components/ReceberLeads";
import MinhaCarteira from "../components/MinhaCarteira";
import PainelCarteira from "../components/PainelCarteira";

const STATUS_BLOQUEADOS_ACIONAMENTO = ["CANCELAMENTO_COBRANCA", "SUSPENSAO_COBRANCA", "JURIDICO"];

const STATUS_BLOQUEADOS_LABEL = {
  CANCELAMENTO_COBRANCA: "Cancelamento definitivo de cobrança",
  SUSPENSAO_COBRANCA: "Suspensão de cobrança",
  JURIDICO: "Jurídico",
};

// Caso já quitado não deve aparecer na Fila Operacional (nem pro operador,
// nem pra gestão) -- não é mais um caso a acionar. Detecta pelo texto do
// status_acionamento/status_jornada/status_atual, igual o import já faz
// em VincularBaseOperacional.jsx.
function ehQuitado(aluno) {
  const texto = [aluno?.status_acionamento, aluno?.status_jornada, aluno?.status_atual]
    .filter(Boolean)
    .join(" ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();

  return texto.includes("QUITAD") || texto.includes("QUITACAO");
}

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

const FILTROS = [
  { valor: "MINHA_FILA", label: "Minha fila" },
  { valor: "TODOS", label: "Todos" },
  { valor: "SEM_RESPONSAVEL", label: "Sem responsável" },
  { valor: "RETORNOS_HOJE", label: "Retornos de hoje" },
  { valor: "NEGOCIACAO_24H", label: "Negociação 24h" },
  { valor: "QUITADOS", label: "✅ Quitados" },
  { valor: "JURIDICO_INDETERMINADO", label: "⚖️ Jurídico - prazo indeterminado", somenteGestao: true },
];

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

// Cancelamento definitivo e suspensão de cobrança exigem número do
// processo + prazo (data específica ou indeterminado). Prazo indeterminado
// entra na lista "Jurídico - prazo indeterminado" pra Amanda cobrar retorno.
const STATUS_COM_PROCESSO = ["CANCELAMENTO_COBRANCA", "SUSPENSAO_COBRANCA"];


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

function paraDataLocalBR(valor) {
  if (!valor) return null;

  // Se já vier só a data (YYYY-MM-DD), não precisa converter.
  if (/^\d{4}-\d{2}-\d{2}$/.test(valor)) return valor;

  const data = new Date(valor);
  if (Number.isNaN(data.getTime())) return null;

  // Usa o dia civil em horário de Brasília (não em UTC), pra não gravar
  // o dia seguinte quando o retorno é marcado à noite (21h-23h59).
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(data);
}

function hojeLocalBR() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function saudacaoDoDia() {
  const hora = new Date().getHours();
  if (hora < 12) return "Bom dia";
  if (hora < 18) return "Boa tarde";
  return "Boa noite";
}

function primeiroNome(nomeCompleto) {
  const nome = String(nomeCompleto || "").trim();
  if (!nome) return "";
  return nome.split(" ")[0];
}

function mensagemIncentivo(qtdFinalizados) {
  if (qtdFinalizados <= 0) {
    return { texto: "Vamos começar o dia. Você consegue!", cor: "#94a3b8", bg: "#111827" };
  }
  if (qtdFinalizados < 5) {
    return { texto: `Você já finalizou ${qtdFinalizados} caso${qtdFinalizados > 1 ? "s" : ""} hoje. Bom ritmo!`, cor: "#3b82f6", bg: "#052e16" };
  }
  if (qtdFinalizados < 10) {
    return { texto: `${qtdFinalizados} casos finalizados hoje. Ótimo trabalho!`, cor: "#3b82f6", bg: "#052e16" };
  }
  return { texto: `${qtdFinalizados} casos finalizados hoje. Você está arrasando!`, cor: "#facc15", bg: "#1c1917" };
}

function definirProximaAcao(status) {
  if (status === "MENSAGEM_ENVIADA") return "AGUARDAR_RETORNO";
  if (status === "RETORNAR_DEPOIS") return "RETORNAR";
  if (status === "ALUNO_EM_NEGOCIACAO_24H") return "RETORNAR";
  if (status === "ACORDO_FECHADO") return "ACOMPANHAR_PAGAMENTO";
  if (status === "NAO_LOCALIZADO") return "TENTAR_NOVO_CONTATO";
  if (status === "SOLICITADO_LINK") return "AGUARDAR_LINK";
  if (status === "AGUARDANDO_LINK") return "AGUARDAR_LINK";
  if (status === "LINK_GERADO") return "ENVIAR_LINK_AO_ALUNO";
  if (status === "LINK_PRONTO_PARA_ENVIO") return "ENVIAR_LINK_AO_ALUNO";
  if (status === "LINK_ENVIADO_ALUNO") return "AGUARDAR_COMPROVANTE";
  if (status === "AGUARDANDO_COMPROVANTE") return "AGUARDAR_COMPROVANTE";
  if (status === "AGUARDANDO_BAIXA") return "AGUARDAR_BAIXA";
  if (status === "BAIXA_REALIZADA") return "BAIXA_REALIZADA";
  if (status === "BAIXA_DEVOLVIDA") return "CORRIGIR_COMPROVANTE";
  if (status === "TERMO_ENVIADO_ALUNO") return "AGUARDAR_ASSINATURA_ALUNO";
  if (status === "TERMO_ENVIADO_ADM") return "AGUARDAR_ADM";
  return "CONTATAR";
}

export default function FilaOperador() {
  const navigate = useNavigate();
  const [usuarioLogado, setUsuarioLogado] = useState(null);
  const [alunos, setAlunos] = useState([]);
  const [saldosPorCpf, setSaldosPorCpf] = useState({});
  const [alunoSelecionado, setAlunoSelecionado] = useState(null);
  const [abaFicha, setAbaFicha] = useState("dados");
  const [movimentacoes, setMovimentacoes] = useState([]);

  const [busca, setBusca] = useState("");
  const [filtro, setFiltro] = useState("MINHA_FILA");

  const [observacao, setObservacao] = useState("");
  const [statusFinalizacao, setStatusFinalizacao] = useState("CONTATAR");
  const [dataRetorno, setDataRetorno] = useState("");
  const [numeroProcesso, setNumeroProcesso] = useState("");
  const [prazoTipo, setPrazoTipo] = useState("DATA");
  const [prazoData, setPrazoData] = useState("");

  const [novoOperadorEmail, setNovoOperadorEmail] = useState("");
  const [motivoAlteracaoOperador, setMotivoAlteracaoOperador] = useState("");
  const [novaDataRetornoAlteracao, setNovaDataRetornoAlteracao] = useState("");
  const [novaTabulacaoAlteracao, setNovaTabulacaoAlteracao] = useState("");

  const [carregando, setCarregando] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState("");
  const [casosFinalizados, setCasosFinalizados] = useState(0);

  useEffect(() => {
    iniciar();
  }, []);

  useEffect(() => {
    if (usuarioLogado) {
      carregarFila();
      carregarCasosFinalizados();
    }
  }, [filtro, usuarioLogado]);

  // Soma o saldo em aberto dos títulos (borderôs) de cada aluno pelo CPF,
  // pra mostrar no card da fila sem precisar abrir a ficha. Feito em lote
  // (uma query só pra todos os CPFs carregados) em vez de uma consulta por
  // aluno. Mais pra frente entra também a soma das parcelas de acordo em
  // aberto (ainda não incluída aqui).
  async function carregarSaldosPorCpf(cpfs) {
    const cpfsUnicos = [...new Set(cpfs.filter(Boolean))];

    if (cpfsUnicos.length === 0) {
      setSaldosPorCpf({});
      return;
    }

    const { data, error } = await supabase
      .from("acordos_titulos")
      .select("cpf, saldo_corrigido, valor_original, situacao")
      .in("cpf", cpfsUnicos);

    if (error) {
      console.error("Erro ao carregar saldos financeiros:", error);
      return;
    }

    const mapa = {};
    (data || []).forEach((titulo) => {
      if (titulo.situacao === "PAGO") return;
      const valor = Number(titulo.saldo_corrigido ?? titulo.valor_original ?? 0);
      mapa[titulo.cpf] = (mapa[titulo.cpf] || 0) + valor;
    });

    setSaldosPorCpf(mapa);
  }

  async function carregarCasosFinalizados() {
    if (!usuarioLogado?.email) return;

    // Tabulacoes de hoje do operador logado, contando uma por CPF (aluno).
    // Considera as finalizacoes de atendimento registradas hoje.
    const inicioHoje = new Date();
    inicioHoje.setHours(0, 0, 0, 0);

    const { data, error } = await supabase
      .from("aluno_movimentacoes")
      .select("aluno_id, registrado_em, tipo")
      .eq("registrado_por_email", usuarioLogado.email)
      .eq("tipo", "FINALIZACAO_ATENDIMENTO")
      .gte("registrado_em", inicioHoje.toISOString());

    if (error) {
      console.error("Erro ao carregar tabulacoes do dia:", error);
      return;
    }

    const cpfsUnicos = new Set((data || []).map((m) => m.aluno_id).filter(Boolean));
    setCasosFinalizados(cpfsUnicos.size);
  }

  async function iniciar() {
    const usuario = await pegarUsuarioLogado();
    setUsuarioLogado(usuario);
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

    const { data: perfilUsuario } = await supabase
      .from("usuarios")
      .select("apelido, foto_url")
      .eq("email", user.email)
      .maybeSingle();

    return {
      nome,
      email: user.email,
      apelido: perfilUsuario?.apelido || null,
      fotoUrl: perfilUsuario?.foto_url || null,
    };
  }

  async function carregarFila() {
    setCarregando(true);
    setErro("");

    try {
      const termo = busca.trim();

      let query = supabase.from("alunos").select("*").limit(500);

      // Casos quitados saem de vez da fila -- tanto o "Quitado (caso
      // antigo)" manual quanto a quitação normal (parcela por parcela até
      // fechar tudo). Diferente de Jurídico/Cancelamento, que ficam
      // listados só travados pra edição, estes somem da lista mesmo --
      // a menos que a pessoa peça especificamente pra ver os quitados.
      if (filtro === "QUITADOS") {
        query = query.in("status_jornada", ["QUITADO_MANUAL", "QUITADO"]);
      } else {
        // Além de quitados, casos aguardando confirmação de pagamento (já
        // mandados pra fila de baixa) e já baixados saem da fila operacional
        // -- não tem cobrança a fazer neles enquanto isso. Se a confirmação
        // for rejeitada, o caso volta pro status normal e reaparece aqui.
        query = query.not(
          "status_jornada",
          "in",
          '("QUITADO_MANUAL","QUITADO","AGUARDANDO_BAIXA","BAIXA_REALIZADA")'
        );
      }

      if (termo) {
        const somenteNumeros = termo.replace(/\D/g, "");

        if (somenteNumeros.length >= 3) {
          query = query.ilike("cpf", `%${somenteNumeros}%`);
        } else {
          query = query.ilike("nome", `%${termo}%`);
        }
      }

      if (filtro === "MINHA_FILA" && usuarioLogado?.email) {
        // Além de quem é responsável atual do aluno, traz também quem tem
        // pelo menos um acordo ativo sob o próprio nome -- pra dar pra
        // acompanhar e mandar lembrete mesmo sem ser o "dono" do caso.
        const { data: acordosDoOperador } = await supabase
          .from("acordos")
          .select("aluno_id")
          .eq("operador_responsavel_email", usuarioLogado.email)
          .eq("status", "ATIVO");

        const idsPorAcordo = [
          ...new Set((acordosDoOperador || []).map((a) => a.aluno_id).filter(Boolean)),
        ];

        if (idsPorAcordo.length > 0) {
          query = query.or(
            `responsavel_atual_email.eq.${usuarioLogado.email},id.in.(${idsPorAcordo.join(",")})`
          );
        } else {
          query = query.eq("responsavel_atual_email", usuarioLogado.email);
        }
      }

      if (filtro === "SEM_RESPONSAVEL") {
        query = query.is("responsavel_atual_email", null);
      }

      if (filtro === "RETORNOS_HOJE") {
        query = query.eq("data_retorno", hojeLocalBR());
      }

      if (filtro === "NEGOCIACAO_24H") {
        query = query.eq("status_jornada", "ALUNO_EM_NEGOCIACAO_24H");
      }

      if (filtro === "JURIDICO_INDETERMINADO") {
        query = query
          .eq("processo_prazo_tipo", "INDETERMINADO")
          .in("status_jornada", ["CANCELAMENTO_COBRANCA", "SUSPENSAO_COBRANCA"]);
      }

      // Prioriza sempre quem está a mais tempo sem acionamento (ou nunca
      // foi acionado) no topo da fila. Data de retorno só desempata entre
      // quem tem o mesmo tempo sem acionamento.
      // Minha fila: casos com data_retorno FUTURA somem ate o dia do retorno.
      // (acionou + agendou retorno -> so reaparece no dia; sem retorno -> segue ciclando no fim da fila)
      if (filtro === "MINHA_FILA") {
        query = query.or(`data_retorno.is.null,data_retorno.lte.${hojeLocalBR()}`);
      }

      query = query
        .order("data_ultimo_acionamento", { ascending: true, nullsFirst: true })
        .order("data_retorno", { ascending: true, nullsFirst: false });

      const { data, error } = await query;

      if (error) {
        console.error("Erro ao carregar fila:", error);
        setErro("Erro ao carregar a fila do operador.");
        setAlunos([]);
        return;
      }

      // Cancelamento de cobrança e jurídico não devem ficar no topo da
      // fila (não são pra acionar) -- manda pro final, mantendo a ordem
      // de prioridade normal entre os dois grupos. Quitado nem isso --
      // sai completamente da Fila Operacional.
      const dados = (data || []).filter((a) => !ehQuitado(a));
      const emCobranca = dados.filter(
        (a) =>
          !STATUS_BLOQUEADOS_ACIONAMENTO.includes(
            pegarCampo(a, ["status_jornada", "status_atual", "status"], "CONTATAR")
          )
      );
      const foraDaCobranca = dados.filter((a) =>
        STATUS_BLOQUEADOS_ACIONAMENTO.includes(
          pegarCampo(a, ["status_jornada", "status_atual", "status"], "CONTATAR")
        )
      );

      // Link respondido (nivel_criticidade "URGENTE") sempre no topo de
      // tudo, na frente até da ordenação normal por tempo sem acionamento.
      const urgentes = emCobranca.filter((a) => a.nivel_criticidade === "URGENTE");
      const resto = emCobranca.filter((a) => a.nivel_criticidade !== "URGENTE");

      setAlunos([...urgentes, ...resto, ...foraDaCobranca]);
      carregarSaldosPorCpf(dados.map((a) => a.cpf));
    } catch (e) {
      console.error("Erro inesperado ao carregar fila:", e);
      setErro("Erro inesperado ao carregar a fila.");
      setAlunos([]);
    } finally {
      setCarregando(false);
    }
  }

  async function abrirAlunoNaFila(aluno) {
    setAbaFicha("dados");
    if (!aluno?.id) {
      alert("Aluno sem ID. Não foi possível abrir a ficha.");
      return;
    }

    setCarregando(true);
    setErro("");

    try {
      const { data, error } = await supabase
        .from("alunos")
        .select("*")
        .eq("id", aluno.id)
        .maybeSingle();

      if (error) {
        console.error("Erro ao abrir aluno:", error);
        alert("Erro ao abrir ficha do aluno.");
        return;
      }

      if (!data) {
        alert("Aluno não encontrado.");
        return;
      }

      prepararAlunoNaTela(data);
      await carregarMovimentacoes(data.id);

      setTimeout(() => {
        const elemento = document.getElementById("ficha-atendimento-operador");
        if (elemento) {
          elemento.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      }, 150);
    } catch (e) {
      console.error("Erro inesperado ao abrir ficha:", e);
      alert("Erro inesperado ao abrir ficha do aluno.");
    } finally {
      setCarregando(false);
    }
  }

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
    setDataRetorno(paraInputDateTime(aluno.data_retorno));
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
      alert("Erro ao registrar movimentação.");
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
      atualizacaoAluno.proxima_acao = definirProximaAcao(statusNovo);
      atualizacaoAluno.data_retorno = paraDataLocalBR(retorno);
    }

    if (observacaoAluno !== null) {
      atualizacaoAluno.observacao = observacaoAluno;
    }

    Object.assign(atualizacaoAluno, extraAluno);

    if (atualizarResponsavel) {
      // Trava de 10 dias: uma vez vinculado, o caso so muda de operador
      // responsavel se ja tiver passado 10 dias desde o ultimo vinculo
      // (ou se nunca teve responsavel). O operador continua conseguindo
      // atender/finalizar o caso normalmente, so nao muda quem e o dono dele.
      const { data: alunoAtual } = await supabase
        .from("alunos")
        .select("responsavel_atual_email, responsavel_atual_em")
        .eq("id", alunoId)
        .maybeSingle();

      const DEZ_DIAS_MS = 10 * 24 * 60 * 60 * 1000;
      const vinculadoEm = alunoAtual?.responsavel_atual_em
        ? new Date(alunoAtual.responsavel_atual_em).getTime()
        : null;
      const dentroDaTrava =
        Boolean(alunoAtual?.responsavel_atual_email) &&
        vinculadoEm !== null &&
        Date.now() - vinculadoEm < DEZ_DIAS_MS;

      if (!dentroDaTrava) {
        atualizacaoAluno.responsavel_atual_nome = usuario.nome;
        atualizacaoAluno.responsavel_atual_email = usuario.email;
        atualizacaoAluno.responsavel_atual_em = agora;
      }
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

    // Sincroniza o retorno com a Agenda Operacional (tabela alunos_unificados),
    // que é uma base separada da fila. Isso é best-effort: se não achar o CPF
    // por lá (ex.: aluno cadastrado manualmente e ainda não importado na base
    // financeira), simplesmente não aparece na agenda, sem travar a fila.
    if (retorno && statusNovo) {
      try {
        const cpfAluno = alunoSelecionado?.cpf || null;

        if (cpfAluno) {
          const dataRetornoObj = new Date(retorno);
          const horaRetorno = Number.isNaN(dataRetornoObj.getTime())
            ? null
            : dataRetornoObj.toLocaleTimeString("pt-BR", {
                hour: "2-digit",
                minute: "2-digit",
              });

          await supabase
            .from("alunos_unificados")
            .update({
              data_retorno: paraDataLocalBR(retorno),
              hora_retorno: horaRetorno,
              status_jornada: statusNovo,
            })
            .eq("cpf_referencia", cpfAluno);
        }
      } catch (syncError) {
        console.warn("Não foi possível sincronizar retorno com a Agenda:", syncError);
      }
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

      await registrarMovimentacao({
        alunoId: alunoSelecionado.id,
        tipo: "ASSUMIU_ATENDIMENTO",
        descricao: "Operador assumiu o atendimento do aluno.",
        statusAnterior,
        statusNovo: "EM_ATENDIMENTO",
        retorno: null,
        atualizarResponsavel: true,
      });

      await recarregarAlunoSelecionado(alunoSelecionado.id);
      await carregarMovimentacoes(alunoSelecionado.id);
      await carregarFila();

      alert("Atendimento assumido com sucesso.");
    } catch (e) {
      console.error(e);
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

    const precisaRetorno =
      statusFinalizacao === "RETORNAR_DEPOIS" ||
      statusFinalizacao === "ALUNO_EM_NEGOCIACAO_24H";

    if (precisaRetorno && !dataRetorno) {
      alert("Informe a data de retorno para esse status.");
      return;
    }

    const ehStatusRestrito = STATUS_BLOQUEADOS_ACIONAMENTO.includes(statusFinalizacao);

    if (ehStatusRestrito && !podeVerTudo(usuarioLogado?.email)) {
      alert("Apenas gestão/supervisão pode definir esse status.");
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

      await registrarMovimentacao({
        alunoId: alunoSelecionado.id,
        tipo: "FINALIZACAO_ATENDIMENTO",
        descricao:
          observacao.trim() ||
          `Atendimento finalizado com status: ${statusFinalizacao}.`,
        statusAnterior,
        statusNovo: statusFinalizacao,
        retorno: retornoIso,
        // Corrigido: ao finalizar, o caso passa a ficar vinculado a quem
        // finalizou (antes ficava só com quem clicou "Assumir atendimento",
        // e se ninguém tivesse assumido, a finalização não contava pra ninguém).
        atualizarResponsavel: true,
        observacaoAluno: ehStatusRestrito ? observacao.trim() : null,
        extraAluno,
      });

      // Tabulou como "aguardando baixa" (pago) direto na fila, sem passar
      // pelo card dedicado "Confirmar pagamento" -- sem isso o aluno ficava
      // com o status de pago mas nunca aparecia na fila de Confirmação de
      // Pagamento (nem em lugar nenhum). Criamos a solicitação aqui pra
      // garantir que todo "pago" realmente cai na fila de confirmação.
      if (statusFinalizacao === "AGUARDANDO_BAIXA") {
        const usuario = await pegarUsuarioLogado();
        const { data: pendenteExistente } = await supabase
          .from("solicitacoes_confirmacao_pagamento")
          .select("id")
          .eq("aluno_id", String(alunoSelecionado.id))
          .eq("status", "AGUARDANDO_CONFIRMACAO")
          .maybeSingle();

        if (!pendenteExistente) {
          const { error: erroSolicitacao } = await supabase
            .from("solicitacoes_confirmacao_pagamento")
            .insert({
              aluno_id: String(alunoSelecionado.id),
              aluno_nome: pegarCampo(alunoSelecionado, ["nome", "nome_aluno", "aluno"], "Aluno sem nome"),
              aluno_cpf: pegarCampo(alunoSelecionado, ["cpf", "CPF"], null),
              operador_email: usuario.email,
              operador_nome: usuario.nome,
              motivo: observacao.trim() || "Tabulado como aguardando baixa direto na fila operacional.",
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

      await recarregarAlunoSelecionado(alunoSelecionado.id);
      await carregarMovimentacoes(alunoSelecionado.id);
      await carregarFila();

      alert("Finalização registrada com sucesso.");
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

    if (!motivo) {
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

      // Opcional: junto da troca de operador, já deixa o caso pronto pro
      // novo operador (nova tabulação + data de retorno) sem ele precisar
      // mexer em nada -- só abrir o caso já vai estar tudo lá.
      // Troca de responsavel via RPC manual segura (executor; so Amanda/Fernanda).
      void usuario; void agora; void anteriorNome; void anteriorEmail;
      const { data: rResp, error: updateError } = await supabase.rpc("alterar_responsavel_aluno", {
        p_aluno_id: alunoSelecionado.id,
        p_novo_email: novoOperador.email,
        p_motivo: motivo,
        p_origem: "fila_operacional",
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
      await carregarFila();

      alert("Operador responsável alterado com sucesso.");
    } catch (e) {
      console.error(e);
      alert("Erro inesperado ao alterar operador.");
    } finally {
      setSalvando(false);
    }
  }

  async function solicitarLinkPagamento() {
    const alunoParaLink =
      (typeof alunoSelecionado !== "undefined" && alunoSelecionado) ||
      (typeof alunoAtual !== "undefined" && alunoAtual) ||
      (typeof alunoAtivo !== "undefined" && alunoAtivo) ||
      (typeof selectedAluno !== "undefined" && selectedAluno) ||
      (typeof estudanteSelecionado !== "undefined" && estudanteSelecionado) ||
      (typeof aluno !== "undefined" && aluno) ||
      null;

    if (!alunoParaLink) {
      alert("Selecione um aluno antes de solicitar o link.");
      return;
    }

    window.dispatchEvent(
      new CustomEvent("REATIVA_ABRIR_LINK_PAGAMENTO", {
        detail: {
          aluno: alunoParaLink
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
      await carregarFila();

      alert("Link marcado como enviado. Agora o caso ficará aguardando comprovante.");
    } catch (e) {
      console.error(e);
      alert("Erro ao marcar link como enviado ao aluno.");
    } finally {
      setSalvando(false);
    }
  }

  const resumo = useMemo(() => {
    const total = alunos.length;

    const semResponsavel = alunos.filter(
      (aluno) => !aluno.responsavel_atual_email
    ).length;

    const retornosHoje = alunos.filter((aluno) => {
      if (!aluno.data_retorno) return false;
      return paraDataLocalBR(aluno.data_retorno) === hojeLocalBR();
    }).length;

    const negociacao24h = alunos.filter(
      (aluno) =>
        aluno.status_jornada === "ALUNO_EM_NEGOCIACAO_24H" ||
        aluno.status_atual === "ALUNO_EM_NEGOCIACAO_24H"
    ).length;

    return {
      total,
      semResponsavel,
      retornosHoje,
      negociacao24h,
    };
  }, [alunos]);

  return (
    <div style={pagina}>
      <FilaReceptivo usuarioLogado={usuarioLogado} />
      <ModuloLinkPagamentoGlobal />
      <MuralAniversariantes />
      <MinhaCarteira usuarioLogado={usuarioLogado} />
      <ResumoDoDia usuarioLogado={usuarioLogado} />
      <ReceberLeads usuarioLogado={usuarioLogado} aoReceber={carregarFila} />
      <PontoOperador usuarioLogado={usuarioLogado} />
      <PainelCarteira embedded />
      <FluxoLinksRapido />

      {erro && <p style={erroTexto}>{erro}</p>}

      {/* Versão antiga da fila operacional (lista "Alunos da fila") foi
          ocultada — a PainelCarteira embedded no topo já cobre busca,
          filtro e listagem dos casos, evitando telas duplicadas. */}
      <div style={{ ...layout, display: "none" }}>
        <div style={caixa}>
          <h2 style={tituloSecao}>Alunos da fila</h2>

          {carregando ? (
            <p style={textoCinza}>Carregando fila...</p>
          ) : alunos.length === 0 ? (
            <div style={vazio}>
              <strong>Nenhum aluno encontrado.</strong>
              <p>
                Verifique o filtro selecionado ou pesquise pelo nome/CPF do aluno.
              </p>
            </div>
          ) : (
            <div style={lista}>
              {alunos.map((aluno) => {
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

                return (
                  <button
                    type="button"
                    key={aluno.id}
                    onClick={() => navigate(`/aluno?alunoId=${encodeURIComponent(aluno.id)}&origem=fila`)}
                    style={{
                      ...cardAluno,
                      background: bloqueado
                        ? "#450a0a"
                        : selecionado
                        ? "#064e3b"
                        : "#1f2937",
                      border: bloqueado
                        ? "1px solid #ef4444"
                        : selecionado
                        ? "1px solid #3b82f6"
                        : "1px solid #374151",
                    }}
                  >
                    <div style={linhaTopoCard}>
                      <div style={{ minWidth: 0, flex: "1 1 200px" }}>
                        <strong style={nomeAluno}>{nome}</strong>
                        <div style={textoCard}>CPF: {cpf}</div>
                      </div>

                      <span
                        style={{
                          ...badgeStatus,
                          ...(bloqueado
                            ? { background: "#ef4444", color: "#fff" }
                            : {}),
                        }}
                      >
                        {STATUS_BLOQUEADOS_LABEL[status] || status}
                      </span>
                    </div>

                    {bloqueado && (
                      <div
                        style={{
                          background: "#7f1d1d",
                          color: "#fecaca",
                          borderRadius: 8,
                          padding: "8px 10px",
                          margin: "8px 0",
                          fontWeight: 700,
                          fontSize: 13,
                        }}
                      >
                        ⚠️ {STATUS_BLOQUEADOS_LABEL[status]} — não acionar.
                        {aluno.observacao ? ` ${aluno.observacao}` : ""}
                      </div>
                    )}

                    <div style={gradeInfo}>
                      <div>
                        <strong>Responsável</strong>
                        <span style={valorGrade}>{responsavel}</span>
                      </div>

                      <div>
                        <strong>Próxima ação</strong>
                        <span style={valorGrade}>{proximaAcao}</span>
                      </div>

                      <div>
                        <strong>Último acionamento</strong>
                        <span style={valorGrade}>{formatarDataHora(aluno.data_ultimo_acionamento)}</span>
                      </div>

                      <div>
                        <strong>Retorno</strong>
                        <span style={valorGrade}>{formatarDataHora(aluno.data_retorno)}</span>
                      </div>

                      <div>
                        <strong>Valor em aberto</strong>
                        <span style={valorGrade}>
                          {aluno.cpf && saldosPorCpf[aluno.cpf] !== undefined
                            ? moeda(saldosPorCpf[aluno.cpf])
                            : moeda(aluno.valor_em_aberto)}
                        </span>
                      </div>
                    </div>

                    <div style={rodapeCard}>
                      Clique para abrir a ficha do aluno
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}

const pagina = {
  minHeight: "100%",
  background: "#020617",
  color: "#ffffff",
  padding: "24px",
  fontFamily: "Arial, sans-serif",
};

const cabecalho = {
  display: "flex",
  justifyContent: "space-between",
  gap: "16px",
  alignItems: "flex-start",
  marginBottom: "24px",
  flexWrap: "wrap",
};

const titulo = {
  margin: 0,
  color: "#3b82f6",
};

const subtitulo = {
  margin: "6px 0 0",
  color: "#cbd5e1",
};

const usuarioTexto = {
  margin: "8px 0 0",
  color: "#94a3b8",
  fontSize: "14px",
};

const cabecalhoModerno = {
  background: "#0b1220",
  border: "1px solid #1f2937",
  borderRadius: "16px",
  padding: "20px",
  marginBottom: "20px",
};

const linhaSaudacao = {
  display: "flex",
  justifyContent: "space-between",
  gap: "16px",
  alignItems: "flex-start",
  flexWrap: "wrap",
  marginBottom: "14px",
};

const tituloSaudacao = {
  margin: 0,
  color: "#f8fafc",
  fontSize: "22px",
};

const subtituloSaudacao = {
  margin: "6px 0 0",
  color: "#94a3b8",
  fontSize: "13px",
};

const bannerIncentivo = {
  border: "1px solid",
  borderRadius: "10px",
  padding: "10px 14px",
  fontSize: "14px",
  fontWeight: "700",
  marginBottom: "16px",
};

const gridResumoModerno = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
  gap: "10px",
};

const cardResumoModerno = {
  background: "#111827",
  borderRadius: "10px",
  padding: "12px 14px",
  display: "grid",
  gap: "6px",
};

const rotuloCardModerno = {
  fontSize: "12px",
  color: "#94a3b8",
  fontWeight: "600",
};

const valorCardModerno = {
  fontSize: "22px",
  fontWeight: "800",
  color: "#f8fafc",
};

const caixa = {
  background: "#111827",
  border: "1px solid #1f2937",
  borderRadius: "14px",
  padding: "16px",
  marginBottom: "20px",
};

const caixaDestaque = {
  background: "#020617",
  border: "1px solid #3b82f6",
  borderRadius: "14px",
  padding: "16px",
  marginBottom: "18px",
};

const caixaLinkPronto = {
  background: "#052e16",
  border: "1px solid #3b82f6",
  borderRadius: "14px",
  padding: "16px",
  marginBottom: "18px",
};

const caixaInterna = {
  background: "#020617",
  border: "1px solid #374151",
  borderRadius: "14px",
  padding: "16px",
  marginBottom: "18px",
};

const tituloSecao = {
  color: "#3b82f6",
  marginTop: 0,
};

const cardsResumo = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
  gap: "12px",
  marginBottom: "20px",
};

const cardResumo = {
  background: "#111827",
  border: "1px solid #3b82f6",
  borderRadius: "14px",
  padding: "14px",
  display: "grid",
  gap: "8px",
};

const label = {
  display: "block",
  marginBottom: "8px",
  color: "#d1d5db",
};

const barraBusca = {
  display: "flex",
  gap: "10px",
  flexWrap: "wrap",
};

const input = {
  flex: "1 1 280px",
  background: "#020617",
  color: "#ffffff",
  border: "1px solid #374151",
  borderRadius: "10px",
  padding: "12px",
  outline: "none",
};

const inputCheio = {
  width: "100%",
  background: "#111827",
  color: "#ffffff",
  border: "1px solid #374151",
  borderRadius: "10px",
  padding: "12px",
  outline: "none",
  marginBottom: "10px",
};

const selectFiltro = {
  width: "220px",
  background: "#020617",
  color: "#ffffff",
  border: "1px solid #374151",
  borderRadius: "10px",
  padding: "12px",
  outline: "none",
};

const select = {
  width: "100%",
  background: "#111827",
  color: "#ffffff",
  border: "1px solid #374151",
  borderRadius: "10px",
  padding: "12px",
  marginBottom: "10px",
};

const textarea = {
  width: "100%",
  background: "#111827",
  color: "#ffffff",
  border: "1px solid #374151",
  borderRadius: "10px",
  padding: "12px",
  resize: "vertical",
  outline: "none",
  marginBottom: "10px",
};

const botaoPrincipal = {
  background: "#3b82f6",
  color: "#020617",
  border: "none",
  borderRadius: "10px",
  padding: "12px 16px",
  fontWeight: "bold",
  cursor: "pointer",
};

const botaoSecundario = {
  background: "#1f2937",
  color: "#ffffff",
  border: "1px solid #3b82f6",
  borderRadius: "10px",
  padding: "12px 14px",
  fontWeight: "bold",
  cursor: "pointer",
};

const layout = {
  display: "grid",
  gridTemplateColumns: "1fr",
  gap: "20px",
  alignItems: "start",
  maxWidth: "760px",
};

const lista = {
  display: "grid",
  gap: "12px",
};

const cardAluno = {
  width: "100%",
  textAlign: "left",
  color: "#ffffff",
  borderRadius: "14px",
  padding: "14px",
  cursor: "pointer",
  overflow: "hidden",
  boxSizing: "border-box",
};

const linhaTopoCard = {
  display: "flex",
  justifyContent: "space-between",
  gap: "12px",
  alignItems: "flex-start",
  marginBottom: "12px",
  flexWrap: "wrap",
};

const nomeAluno = {
  fontSize: "16px",
  color: "#ffffff",
  overflowWrap: "anywhere",
  wordBreak: "break-word",
};

const textoCard = {
  color: "#cbd5e1",
  fontSize: "13px",
  marginTop: "4px",
  overflowWrap: "anywhere",
};

const badgeStatus = {
  background: "#064e3b",
  color: "#93c5fd",
  border: "1px solid #3b82f6",
  borderRadius: "999px",
  padding: "6px 10px",
  fontSize: "12px",
  fontWeight: "bold",
  whiteSpace: "normal",
  overflowWrap: "anywhere",
  textAlign: "center",
  lineHeight: 1.3,
  maxWidth: "220px",
};

const gradeInfo = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
  gap: "10px",
  color: "#d1d5db",
  fontSize: "13px",
};

const valorGrade = {
  overflowWrap: "anywhere",
  wordBreak: "break-word",
  display: "block",
  marginTop: "2px",
};

const rodapeCard = {
  marginTop: "12px",
  paddingTop: "10px",
  borderTop: "1px solid #374151",
  color: "#93c5fd",
  fontSize: "13px",
  fontWeight: "bold",
};

const vazio = {
  background: "#020617",
  border: "1px solid #374151",
  borderRadius: "12px",
  padding: "16px",
  color: "#cbd5e1",
};

const textoCinza = {
  color: "#cbd5e1",
};

const erroTexto = {
  color: "#f87171",
  marginTop: "10px",
};

const topoFicha = {
  display: "flex",
  justifyContent: "space-between",
  gap: "16px",
  alignItems: "start",
  flexWrap: "wrap",
  marginBottom: "18px",
};

const barraAbasFicha = {
  display: "flex",
  gap: "8px",
  flexWrap: "wrap",
  marginBottom: "18px",
  borderBottom: "1px solid #374151",
  paddingBottom: "10px",
};

const abaFichaBase = {
  border: "none",
  borderRadius: "8px",
  padding: "8px 14px",
  fontSize: "13px",
  fontWeight: 700,
  cursor: "pointer",
};

const abaFichaAtiva = {
  ...abaFichaBase,
  background: "#3b82f6",
  color: "#052e16",
};

const abaFichaInativa = {
  ...abaFichaBase,
  background: "#1f2937",
  color: "#d1d5db",
};

const gradeCards = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: "12px",
  marginBottom: "18px",
};

const cardInfo = {
  background: "#020617",
  border: "1px solid #374151",
  borderRadius: "12px",
  padding: "12px",
  color: "#e5e7eb",
};

const textoInfo = {
  color: "#cbd5e1",
  margin: "6px 0",
};

const cardMov = {
  background: "#111827",
  borderRadius: "12px",
  padding: "12px",
  borderLeft: "4px solid #3b82f6",
  color: "#e5e7eb",
};
