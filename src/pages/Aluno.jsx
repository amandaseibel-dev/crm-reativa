import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../services/supabase";
import { podeVerTudo } from "../utils/operadores";
import FinalizacaoTermo from "../components/FinalizacaoTermo";
import EnvioFinanceiro from "../components/EnvioFinanceiro";
import FinanceiroAluno from "../components/FinanceiroAluno";
import ConfirmarPagamento from "../components/ConfirmarPagamento";
import LinksPagamentoAluno from "../components/LinksPagamentoAluno";

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
  CANCELAMENTO_COBRANCA: "Cancelamento definitivo de cobrança",
  SUSPENSAO_COBRANCA: "Suspensão de cobrança",
  JURIDICO: "Jurídico",
  QUITADO_MANUAL: "Quitado",
};

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

export default function Alunos() {
  const navigate = useNavigate();
  const [vindoDaFila, setVindoDaFila] = useState(false);
  const [usuarioLogado, setUsuarioLogado] = useState(null);
  const [alunos, setAlunos] = useState([]);
  const [alunoSelecionado, setAlunoSelecionado] = useState(null);
  const [finAlunos, setFinAlunos] = useState({});
  const [abaFicha, setAbaFicha] = useState("dados");
  const [editandoCadastro, setEditandoCadastro] = useState(false);
  const [nomeEditado, setNomeEditado] = useState("");
  const [cpfEditado, setCpfEditado] = useState("");
  const [salvandoCadastro, setSalvandoCadastro] = useState(false);
  const [movimentacoes, setMovimentacoes] = useState([]);
  const [busca, setBusca] = useState("");
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
        fin[id] = { mensalidades: 0, acordos: 0, total: 0, temDetalhe: false };
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
        const { data } = await supabase
          .from("acordos_titulos")
          .select("aluno_id,status,valor_em_aberto,saldo_corrigido,valor_original")
          .in("aluno_id", lote)
          .eq("status", "em_aberto");
        for (const t of data || []) {
          const id = String(t.aluno_id);
          if (!fin[id]) continue;
          fin[id].mensalidades += Number(
            t.valor_em_aberto ?? t.saldo_corrigido ?? t.valor_original ?? 0
          );
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
      alunoIdDaUrl || alunoIdLocalStorage || alunoIdSessionStorage;

    if (parametros.get("origem") === "fila") {
      setVindoDaFila(true);
    }

    if (alunoId) {
      setOrigemAbertura(`Abrindo aluno recebido da fila: ${alunoId}`);

      localStorage.removeItem("reativa_aluno_abrir_id");
      sessionStorage.removeItem("reativa_aluno_abrir_id");

      await abrirAlunoPorId(alunoId);
      return;
    }

    await carregarAlunos();
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

    try {
      const termo = busca.trim();

      let query = supabase.from("alunos").select("*").limit(150);

      if (termo) {
        const somenteNumeros = termo.replace(/\D/g, "");

        if (somenteNumeros.length >= 3) {
          query = query.ilike("cpf", `%${somenteNumeros}%`);
        } else {
          query = query.ilike("nome", `%${termo}%`);
        }
      }

      const { data, error } = await query;

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
      const { data, error } = await supabase
        .from("alunos")
        .select("*")
        .eq("id", alunoId)
        .maybeSingle();

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

  function abrirEdicaoCadastro() {
    if (!alunoSelecionado) return;

    setNomeEditado(
      pegarCampo(alunoSelecionado, ["nome", "nome_aluno", "aluno"], "")
    );
    setCpfEditado(pegarCampo(alunoSelecionado, ["cpf", "CPF"], ""));
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

    const { error } = await supabase
      .from("alunos")
      .update({
        nome: nomeEditado.trim(),
        cpf: cpfEditado.trim(),
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
      descricao: `Cadastro corrigido. Nome: "${nomeAnterior}" -> "${nomeEditado.trim()}". CPF: "${cpfAnterior}" -> "${cpfEditado.trim()}".`,
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

      if (
        statusNovo === "RETORNAR_DEPOIS" ||
        statusNovo === "ALUNO_EM_NEGOCIACAO_24H"
      ) {
        atualizacaoAluno.proxima_acao = "RETORNAR";
      } else if (statusNovo === "ACORDO_FECHADO") {
        atualizacaoAluno.proxima_acao = "ACOMPANHAR_PAGAMENTO";
      } else if (statusNovo === "NAO_LOCALIZADO") {
        atualizacaoAluno.proxima_acao = "TENTAR_NOVO_CONTATO";
      } else {
        atualizacaoAluno.proxima_acao = "CONTATAR";
      }
    }

    if (retorno) {
      atualizacaoAluno.data_retorno = paraDataLocalBR(retorno);
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
  async function quitarManual() {
    if (!alunoSelecionado?.id) return;
    if (!podeQuitarManual(usuarioLogado?.email)) return;

    const confirmado = window.confirm(
      "Marcar como quitado e tirar da fila? A ficha fica amarela e sai da fila ativa. Só volta se subir um título novo dele em algum bordero."
    );
    if (!confirmado) return;

    setSalvando(true);

    try {
      const statusAnterior = pegarCampo(
        alunoSelecionado,
        ["status_jornada", "status_atual", "status"],
        null
      );

      await registrarMovimentacao({
        alunoId: alunoSelecionado.id,
        tipo: "QUITADO_MANUAL",
        descricao: "Caso marcado como quitado manualmente para sair da fila ativa.",
        statusAnterior,
        statusNovo: STATUS_QUITADO_MANUAL,
        retorno: null,
        atualizarResponsavel: false,
        extraAluno: {
          status_jornada: STATUS_QUITADO_MANUAL,
          status_atual: STATUS_QUITADO_MANUAL,
          status_acionamento: STATUS_QUITADO_MANUAL,
          proxima_acao: "NENHUMA",
          valor_em_aberto: 0,
        },
      });

      const agoraIso = new Date().toISOString();

      // Zera os títulos soltos (que nunca entraram num acordo).
      await supabase
        .from("acordos_titulos")
        .update({
          situacao: "PAGO",
          status: "quitada",
          saldo_corrigido: 0,
          valor_em_aberto: 0,
          motivo_ajuste: "Quitado manualmente (saiu da fila) por " + (usuarioLogado?.email || "Amanda"),
          atualizado_em: agoraIso,
        })
        .eq("aluno_id", String(alunoSelecionado.id))
        .neq("situacao", "PAGO");

      // Zera os acordos ativos e as parcelas que ainda estavam em aberto.
      const { data: acordosAtivos } = await supabase
        .from("acordos")
        .select("id")
        .eq("aluno_id", String(alunoSelecionado.id))
        .eq("status", "ATIVO");

      const idsAcordos = (acordosAtivos || []).map((a) => a.id);

      if (idsAcordos.length > 0) {
        await supabase
          .from("acordos")
          .update({ status: "QUITADO", saldo: 0, atualizado_em: agoraIso })
          .in("id", idsAcordos);

        // pago_em fica null de propósito -- não é um recebimento de
        // verdade neste mês, é só regularização de um caso antigo. Deixar
        // null impede que isso conte como "recebido este mês" em qualquer
        // KPI que filtre por data de pagamento.
        await supabase
          .from("parcelas")
          .update({ status: "PAGO", pago_em: null, atualizado_em: agoraIso })
          .in("acordo_id", idsAcordos)
          .neq("status", "PAGO");
      }

      await supabase
        .from("carteira_operador")
        .update({ status: "quitado_saiu", saiu_em: agoraIso })
        .eq("aluno_id", String(alunoSelecionado.id))
        .eq("status", "ativo");

      await recarregarAlunoSelecionado(alunoSelecionado.id);
      await carregarMovimentacoes(alunoSelecionado.id);

      alert("Caso marcado como quitado -- valores zerados e removido da fila ativa.");
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
        extraAluno,
      });

      setObservacao("");
      setNumeroProcesso("");
      setPrazoTipo("DATA");
      setPrazoData("");

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
            placeholder="Digite nome ou CPF"
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
                        ? "#ecfdf5"
                        : quitado
                        ? "#fffbeb"
                        : bloqueado
                        ? "#fef2f2"
                        : "#fff",
                      borderColor: selecionado
                        ? "#86efac"
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
                        {STATUS_BLOQUEADOS_LABEL[status] || status}
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
          {!alunoSelecionado ? (
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
                <div>
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
                      <h2 style={tituloSecao}>
                        {pegarCampo(
                          alunoSelecionado,
                          ["nome", "nome_aluno", "aluno"],
                          "Aluno sem nome"
                        )}
                      </h2>

                      <p style={textoInfo}>
                        CPF: {pegarCampo(alunoSelecionado, ["cpf", "CPF"], "-")}
                        <button
                          type="button"
                          onClick={abrirEdicaoCadastro}
                          style={{
                            marginLeft: 10,
                            background: "none",
                            border: "none",
                            color: "#93c5fd",
                            cursor: "pointer",
                            textDecoration: "underline",
                            fontSize: 13,
                          }}
                        >
                          Corrigir nome/CPF
                        </button>
                      </p>

                      {(alunoSelecionado.telefone || alunoSelecionado.email) && (
                        <p style={textoInfo}>
                          {alunoSelecionado.telefone ? `Tel: ${alunoSelecionado.telefone}` : ""}
                          {alunoSelecionado.telefone && alunoSelecionado.email ? " · " : ""}
                          {alunoSelecionado.email ? `E-mail: ${alunoSelecionado.email}` : ""}
                        </p>
                      )}

                      {(alunoSelecionado.unidade || alunoSelecionado.curso) && (
                        <p style={textoInfo}>
                          {[alunoSelecionado.unidade, alunoSelecionado.curso].filter(Boolean).join(" · ")}
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
                    </>
                  )}
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
                      style={{ ...botaoPrincipal, background: "#6b21a8", marginLeft: 8 }}
                    >
                      💰 Quitar tudo (sai da fila)
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
                  await carregarAlunos();
                }}
                onSucesso={async () => {
                  await recarregarAlunoSelecionado(alunoSelecionado.id);
                  await carregarMovimentacoes(alunoSelecionado.id);
                  await carregarAlunos();
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
  minHeight: "100%",
  background: "#f4f6fa",
  color: "#334155",
  padding: "28px 28px 40px",
  fontFamily: "Inter, Arial, sans-serif",
};

const cabecalho = {
  display: "flex",
  justifyContent: "space-between",
  gap: "16px",
  alignItems: "center",
  marginBottom: "24px",
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

const caixa = {
  background: "#fff",
  border: "1px solid #eef2f6",
  borderRadius: "16px",
  padding: "18px",
  marginBottom: "18px",
  boxShadow: "0 1px 3px rgba(15,23,42,0.05)",
};

const caixaDestaque = {
  background: "#f0fdf4",
  border: "1px solid #86efac",
  borderRadius: "14px",
  padding: "16px",
  marginBottom: "18px",
};

const caixaLinkPronto = {
  background: "#f0fdf4",
  border: "1px solid #86efac",
  borderRadius: "14px",
  padding: "16px",
  marginBottom: "18px",
};

const caixaInterna = {
  background: "#f8fafc",
  border: "1px solid #e6eaf0",
  borderRadius: "14px",
  padding: "16px",
  marginBottom: "18px",
};

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
  marginBottom: "18px",
};

const barraAbasFicha = {
  display: "flex",
  gap: "8px",
  flexWrap: "wrap",
  marginBottom: "18px",
  borderBottom: "1px solid #e6eaf0",
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
  background: "#eef2ff",
  color: "#2563eb",
};

const abaFichaInativa = {
  ...abaFichaBase,
  background: "#f1f5f9",
  color: "#64748b",
};

const gradeCards = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: "12px",
  marginBottom: "18px",
};

const cardInfo = {
  background: "#f8fafc",
  border: "1px solid #e6eaf0",
  borderRadius: "12px",
  padding: "12px",
  color: "#475569",
};

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

const cardMov = {
  background: "#f8fafc",
  border: "1px solid #eef2f6",
  borderRadius: "12px",
  padding: "12px",
  borderLeft: "4px solid #2563eb",
  color: "#475569",
};

const textoInfo = {
  color: "#475569",
  margin: "6px 0",
};

const textoCinza = {
  color: "#94a3b8",
};

const label = {
  display: "block",
  marginBottom: "8px",
  color: "#475569",
  fontSize: 12.5,
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
  borderRadius: "10px",
  padding: "12px",
  outline: "none",
  marginBottom: "10px",
};

const select = {
  width: "100%",
  background: "#f8fafc",
  color: "#334155",
  border: "1px solid #e6eaf0",
  borderRadius: "10px",
  padding: "12px",
  marginBottom: "10px",
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
  marginBottom: "10px",
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
