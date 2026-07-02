import { useEffect, useMemo, useState } from "react";
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

const STATUS_BLOQUEADOS_ACIONAMENTO = ["CANCELAMENTO_COBRANCA", "SUSPENSAO_COBRANCA", "JURIDICO"];

const STATUS_BLOQUEADOS_LABEL = {
  CANCELAMENTO_COBRANCA: "Cancelamento definitivo de cobrança",
  SUSPENSAO_COBRANCA: "Suspensão de cobrança",
  JURIDICO: "Jurídico",
};

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
    return { texto: `Você já finalizou ${qtdFinalizados} caso${qtdFinalizados > 1 ? "s" : ""} hoje. Bom ritmo!`, cor: "#22c55e", bg: "#052e16" };
  }
  if (qtdFinalizados < 10) {
    return { texto: `${qtdFinalizados} casos finalizados hoje. Ótimo trabalho!`, cor: "#22c55e", bg: "#052e16" };
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
  const [usuarioLogado, setUsuarioLogado] = useState(null);
  const [alunos, setAlunos] = useState([]);
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

  async function carregarCasosFinalizados() {
    if (!usuarioLogado?.email) return;

    // Conta quantos casos esse operador já finalizou com baixa realizada
    // (pagamento confirmado), independente do filtro selecionado na tela.
    const { count, error } = await supabase
      .from("alunos")
      .select("id", { count: "exact", head: true })
      .eq("responsavel_atual_email", usuarioLogado.email)
      .eq("status_jornada", "BAIXA_REALIZADA");

    if (error) {
      console.error("Erro ao carregar casos finalizados:", error);
      return;
    }

    setCasosFinalizados(count || 0);
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

      if (termo) {
        const somenteNumeros = termo.replace(/\D/g, "");

        if (somenteNumeros.length >= 3) {
          query = query.ilike("cpf", `%${somenteNumeros}%`);
        } else {
          query = query.ilike("nome", `%${termo}%`);
        }
      }

      if (filtro === "MINHA_FILA" && usuarioLogado?.email) {
        query = query.eq("responsavel_atual_email", usuarioLogado.email);
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
      // de prioridade normal entre os dois grupos.
      const dados = data || [];
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

  async function salvarObservacao() {
    if (!alunoSelecionado?.id) return;

    const texto = observacao.trim();

    if (!texto) {
      alert("Digite uma observação antes de salvar.");
      return;
    }

    setSalvando(true);

    try {
      const statusAtual = pegarCampo(
        alunoSelecionado,
        ["status_jornada", "status_atual", "status"],
        null
      );

      await registrarMovimentacao({
        alunoId: alunoSelecionado.id,
        tipo: "OBSERVACAO",
        descricao: texto,
        statusAnterior: statusAtual,
        statusNovo: statusAtual,
        retorno: alunoSelecionado.data_retorno || null,
        atualizarResponsavel: false,
      });

      setObservacao("");

      await recarregarAlunoSelecionado(alunoSelecionado.id);
      await carregarMovimentacoes(alunoSelecionado.id);

      alert("Observação salva com sucesso.");
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
      const atualizacaoOperador = {
        responsavel_atual_nome: novoOperador.nome,
        responsavel_atual_email: novoOperador.email,
        responsavel_atual_em: agora,
        registrado_por_nome: usuario.nome,
        registrado_por_email: usuario.email,
        registrado_em: agora,
      };

      if (novaDataRetornoAlteracao) {
        // Mesma correcao do bug de fuso: grava a data-civil em horario de
        // Brasilia (nao em UTC), senao um retorno marcado a noite (21h-23h59)
        // pode salvar o dia seguinte na coluna "date" do banco.
        atualizacaoOperador.data_retorno = paraDataLocalBR(
          new Date(novaDataRetornoAlteracao).toISOString()
        );
      }

      if (novaTabulacaoAlteracao) {
        atualizacaoOperador.status_jornada = novaTabulacaoAlteracao;
        atualizacaoOperador.status_atual = novaTabulacaoAlteracao;
      }

      const { error: updateError } = await supabase
        .from("alunos")
        .update(atualizacaoOperador)
        .eq("id", alunoSelecionado.id);

      if (updateError) {
        console.error("Erro ao alterar operador:", updateError);
        alert("Erro ao alterar operador.");
        return;
      }

      const { error: movError } = await supabase
        .from("aluno_movimentacoes")
        .insert({
          aluno_id: String(alunoSelecionado.id),
          tipo: "ALTERACAO_OPERADOR",
          descricao: `Operador responsável alterado de ${anteriorNome} para ${novoOperador.nome}. Motivo: ${motivo}` +
            (novaDataRetornoAlteracao
              ? ` Nova data de retorno definida: ${new Date(novaDataRetornoAlteracao).toLocaleString("pt-BR")}.`
              : "") +
            (novaTabulacaoAlteracao ? ` Nova tabulação: ${novaTabulacaoAlteracao}.` : ""),
          status_anterior: alunoSelecionado.status_jornada || null,
          status_novo: alunoSelecionado.status_jornada || null,
          registrado_por_nome: usuario.nome,
          registrado_por_email: usuario.email,
          registrado_em: agora,
          operador_anterior_nome: anteriorNome,
          operador_anterior_email: anteriorEmail,
          operador_novo_nome: novoOperador.nome,
          operador_novo_email: novoOperador.email,
        });

      if (movError) {
        console.error("Erro ao registrar movimentação:", movError);
        alert("Operador alterado, mas não registrou movimentação.");
        return;
      }

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
      <ModuloLinkPagamentoGlobal />
      <MuralAniversariantes />
      <MinhaCarteira usuarioLogado={usuarioLogado} />
      <ResumoDoDia usuarioLogado={usuarioLogado} />
      <ReceberLeads usuarioLogado={usuarioLogado} aoReceber={carregarFila} />
      <PontoOperador usuarioLogado={usuarioLogado} />
      <FluxoLinksRapido />
      <FilaReceptivo usuarioLogado={usuarioLogado} />
      {(() => {
        const incentivo = mensagemIncentivo(casosFinalizados);
        return (
          <div style={cabecalhoModerno}>
            <div style={linhaSaudacao}>
              <div>
                <h1 style={tituloSaudacao}>
                  {saudacaoDoDia()}
                  {usuarioLogado?.apelido || usuarioLogado?.nome
                    ? `, ${primeiroNome(usuarioLogado.apelido || usuarioLogado.nome)}`
                    : ""}
                </h1>
                <p style={subtituloSaudacao}>
                  Aqui está o resumo do seu dia.{" "}
                  {usuarioLogado?.email ? `Conectado como ${usuarioLogado.email}.` : ""}
                </p>
              </div>

              <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
                <CadastroNovoAluno />

                <button
                  type="button"
                  onClick={carregarFila}
                  disabled={carregando}
                  style={botaoPrincipal}
                >
                  {carregando ? "Carregando..." : "Atualizar fila"}
                </button>
              </div>
            </div>

            <div style={{ ...bannerIncentivo, background: incentivo.bg, borderColor: incentivo.cor }}>
              <span style={{ color: incentivo.cor }}>{incentivo.texto}</span>
            </div>

            <div style={gridResumoModerno}>
              <div style={cardResumoModerno}>
                <strong style={rotuloCardModerno}>Na fila hoje</strong>
                <span style={valorCardModerno}>{resumo.total}</span>
              </div>

              <div style={{ ...cardResumoModerno, borderLeft: "3px solid #facc15" }}>
                <strong style={rotuloCardModerno}>Retornos para hoje</strong>
                <span style={{ ...valorCardModerno, color: "#facc15" }}>{resumo.retornosHoje}</span>
              </div>

              <div style={{ ...cardResumoModerno, borderLeft: "3px solid #22c55e" }}>
                <strong style={rotuloCardModerno}>Finalizados hoje</strong>
                <span style={{ ...valorCardModerno, color: "#22c55e" }}>{casosFinalizados}</span>
              </div>

              <div style={{ ...cardResumoModerno, borderLeft: "3px solid #94a3b8" }}>
                <strong style={rotuloCardModerno}>Sem responsável</strong>
                <span style={valorCardModerno}>{resumo.semResponsavel}</span>
              </div>

              <div style={{ ...cardResumoModerno, borderLeft: "3px solid #f472b6" }}>
                <strong style={rotuloCardModerno}>Negociação 24h</strong>
                <span style={valorCardModerno}>{resumo.negociacao24h}</span>
              </div>
            </div>
          </div>
        );
      })()}

      <div style={caixa}>
        <label style={label}>Buscar na fila por nome ou CPF</label>

        <div style={barraBusca}>
          <input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") carregarFila();
            }}
            placeholder="Digite nome ou CPF"
            style={input}
          />

          <select
            value={filtro}
            onChange={(e) => setFiltro(e.target.value)}
            style={selectFiltro}
          >
            {FILTROS.filter(
              (item) => !item.somenteGestao || podeVerTudo(usuarioLogado?.email)
            ).map((item) => (
              <option key={item.valor} value={item.valor}>
                {item.label}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={carregarFila}
            disabled={carregando}
            style={botaoPrincipal}
          >
            Pesquisar
          </button>
        </div>

        {erro && <p style={erroTexto}>{erro}</p>}
      </div>

      <div style={layout}>
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
                    onClick={() => abrirAlunoNaFila(aluno)}
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
                        ? "1px solid #22c55e"
                        : "1px solid #374151",
                    }}
                  >
                    <div style={linhaTopoCard}>
                      <div>
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
                        <br />
                        {responsavel}
                      </div>

                      <div>
                        <strong>Próxima ação</strong>
                        <br />
                        {proximaAcao}
                      </div>

                      <div>
                        <strong>Último acionamento</strong>
                        <br />
                        {formatarDataHora(aluno.data_ultimo_acionamento)}
                      </div>

                      <div>
                        <strong>Retorno</strong>
                        <br />
                        {formatarDataHora(aluno.data_retorno)}
                      </div>

                      <div>
                        <strong>Valor em aberto</strong>
                        <br />
                        {moeda(aluno.valor_em_aberto)}
                      </div>

                      <div>
                        <strong>Status acionamento</strong>
                        <br />
                        {aluno.status_acionamento || "-"}
                      </div>
                    </div>

                    <div style={rodapeCard}>
                      Clique para abrir a ficha abaixo
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div id="ficha-atendimento-operador" style={caixa}>
          {!alunoSelecionado ? (
            <div>
              <h2 style={tituloSecao}>Ficha de atendimento</h2>
              <p style={textoCinza}>
                Clique em um aluno da fila para abrir a ficha aqui.
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
                const fichaRestrita =
                  STATUS_BLOQUEADOS_ACIONAMENTO.includes(statusFicha);
                const fichaBloqueadaParaMim =
                  fichaRestrita && !podeVerTudo(usuarioLogado?.email);

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

              <div style={topoFicha}>
                <div>
                  <h2 style={tituloSecao}>
                    {pegarCampo(
                      alunoSelecionado,
                      ["nome", "nome_aluno", "aluno"],
                      "Aluno sem nome"
                    )}
                  </h2>

                  <p style={textoInfo}>
                    CPF: {pegarCampo(alunoSelecionado, ["cpf", "CPF"], "-")}
                  </p>

                  {(alunoSelecionado.telefone || alunoSelecionado.email) && (
                    <p style={textoInfo}>
                      {alunoSelecionado.telefone ? `Tel: ${alunoSelecionado.telefone}` : ""}
                      {alunoSelecionado.telefone && alunoSelecionado.email ? " · " : ""}
                      {alunoSelecionado.email ? `E-mail: ${alunoSelecionado.email}` : ""}
                    </p>
                  )}

                  {(alunoSelecionado.curso || alunoSelecionado.unidade) && (
                    <p style={textoInfo}>
                      {alunoSelecionado.curso || "-"}
                      {alunoSelecionado.unidade ? ` · ${alunoSelecionado.unidade}` : ""}
                    </p>
                  )}

                  <p style={textoInfo}>
                    Status atual:{" "}
                    <strong style={{ color: "#86efac" }}>
                      {pegarCampo(
                        alunoSelecionado,
                        ["status_jornada", "status_atual", "status"],
                        "CONTATAR"
                      )}
                    </strong>
                  </p>
                </div>

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
                    style={botaoPrincipal}
                  >
                    {salvando ? "Salvando..." : "Assumir atendimento"}
                  </button>
                )}
              </div>

              <div style={barraAbasFicha}>
                {[
                  ["dados", "Dados do aluno"],
                  ["tabulacoes", "Tabulações"],
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
              <div style={gradeCards}>
                <div style={cardInfo}>
                  <strong>Responsável atual</strong>
                  <br />
                  {alunoSelecionado.responsavel_atual_nome ||
                    "Sem responsável"}
                </div>

                <div style={cardInfo}>
                  <strong>Última tabulação</strong>
                  <br />
                  {formatarDataHora(alunoSelecionado.registrado_em)}
                </div>

                <div style={cardInfo}>
                  <strong>Último acionamento</strong>
                  <br />
                  {formatarDataHora(alunoSelecionado.data_ultimo_acionamento)}
                </div>

                <div style={cardInfo}>
                  <strong>Próxima ação</strong>
                  <br />
                  {alunoSelecionado.proxima_acao || "CONTATAR"}
                </div>

                <div style={cardInfo}>
                  <strong>Data de retorno</strong>
                  <br />
                  {formatarDataHora(alunoSelecionado.data_retorno)}
                </div>

                <div style={cardInfo}>
                  <strong>Valor em aberto</strong>
                  <br />
                  {moeda(alunoSelecionado.valor_em_aberto)}
                </div>

                <div style={cardInfo}>
                  <strong>Status acionamento</strong>
                  <br />
                  {alunoSelecionado.status_acionamento || "-"}
                </div>
              </div>
              )}

              {abaFicha === "tabulacoes" && (
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

              <LinksPagamentoAluno
                aluno={alunoSelecionado}
                usuarioLogado={usuarioLogado}
                onAtualizar={async () => {
                  await recarregarAlunoSelecionado(alunoSelecionado.id);
                  await carregarMovimentacoes(alunoSelecionado.id);
                  await carregarFila();
                }}
                onSucesso={async () => {
                  await recarregarAlunoSelecionado(alunoSelecionado.id);
                  await carregarMovimentacoes(alunoSelecionado.id);
                  await carregarFila();
                }}
              />

              <div style={caixaDestaque}>
                <h3 style={tituloSecao}>Tabulações</h3>

                <label style={label}>Tabulação</label>

                <select
                  value={statusFinalizacao}
                  onChange={(e) => setStatusFinalizacao(e.target.value)}
                  style={select}
                >
                  {STATUS_FINALIZACAO.filter(
                    (status) =>
                      !STATUS_BLOQUEADOS_ACIONAMENTO.includes(status) ||
                      podeVerTudo(usuarioLogado?.email)
                  ).map((status) => (
                    <option key={status} value={status}>
                      {STATUS_BLOQUEADOS_LABEL[status] || status}
                    </option>
                  ))}
                </select>

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
                        indeterminado" pra Amanda cobrar retorno do jurídico.
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
                  rows={4}
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
                    {salvando ? "Salvando..." : "Finalizar atendimento"}
                  </button>

                  <button
                    type="button"
                    onClick={salvarObservacao}
                    disabled={salvando}
                    style={botaoSecundario}
                  >
                    Salvar só observação
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

              <FinalizacaoTermo aluno={alunoSelecionado} />

              <EnvioFinanceiro aluno={alunoSelecionado} />
              <ConfirmarPagamento aluno={alunoSelecionado} />
              </>
              )}

              {abaFicha === "financeiro" && (
                <FinanceiroAluno aluno={alunoSelecionado} />
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

              <div style={caixaInterna}>
                <h3 style={tituloSecao}>Movimentações</h3>

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
                      </div>
                    ))}
                  </div>
                )}
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
  minHeight: "100vh",
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
  color: "#22c55e",
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
  border: "1px solid #22c55e",
  borderRadius: "14px",
  padding: "16px",
  marginBottom: "18px",
};

const caixaLinkPronto = {
  background: "#052e16",
  border: "1px solid #22c55e",
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
  color: "#22c55e",
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
  border: "1px solid #22c55e",
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
  background: "#22c55e",
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
  border: "1px solid #22c55e",
  borderRadius: "10px",
  padding: "12px 14px",
  fontWeight: "bold",
  cursor: "pointer",
};

const layout = {
  display: "grid",
  gridTemplateColumns: "minmax(320px, 520px) 1fr",
  gap: "20px",
  alignItems: "start",
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
};

const textoCard = {
  color: "#cbd5e1",
  fontSize: "13px",
  marginTop: "4px",
};

const badgeStatus = {
  background: "#064e3b",
  color: "#86efac",
  border: "1px solid #22c55e",
  borderRadius: "999px",
  padding: "6px 10px",
  fontSize: "12px",
  fontWeight: "bold",
};

const gradeInfo = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
  gap: "10px",
  color: "#d1d5db",
  fontSize: "13px",
};

const rodapeCard = {
  marginTop: "12px",
  paddingTop: "10px",
  borderTop: "1px solid #374151",
  color: "#86efac",
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
  background: "#22c55e",
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
  borderLeft: "4px solid #22c55e",
  color: "#e5e7eb",
};
