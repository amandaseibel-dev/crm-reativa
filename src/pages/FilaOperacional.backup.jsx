import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";

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
  "TERMO_ENVIADO_ADM",
  "TERMO_RECEBIDO_LIBERADO",
  "TERMO_REJEITADO",
  "ACORDO_FECHADO",
];

function formatarDataHora(data) {
  if (!data) return "-";

  try {
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

function dataInicioHojeISO() {
  const agora = new Date();
  agora.setHours(0, 0, 0, 0);
  return agora.toISOString();
}

function dataFimHojeISO() {
  const agora = new Date();
  agora.setHours(23, 59, 59, 999);
  return agora.toISOString();
}

function definirProximaAcao(status) {
  if (status === "MENSAGEM_ENVIADA") return "AGUARDAR_RETORNO";
  if (status === "RETORNAR_DEPOIS") return "RETORNAR";
  if (status === "ALUNO_EM_NEGOCIACAO_24H") return "RETORNAR";
  if (status === "ACORDO_FECHADO") return "ACOMPANHAR_PAGAMENTO";
  if (status === "NAO_LOCALIZADO") return "TENTAR_NOVO_CONTATO";
  if (status === "SOLICITADO_LINK") return "AGUARDAR_LINK";
  if (status === "AGUARDANDO_LINK") return "AGUARDAR_LINK";
  if (status === "TERMO_ENVIADO_ADM") return "AGUARDAR_ADM";
  return "CONTATAR";
}

export default function FilaOperador() {
  const [usuarioLogado, setUsuarioLogado] = useState(null);
  const [alunos, setAlunos] = useState([]);
  const [alunoSelecionado, setAlunoSelecionado] = useState(null);
  const [movimentacoes, setMovimentacoes] = useState([]);

  const [busca, setBusca] = useState("");
  const [filtro, setFiltro] = useState("MINHA_FILA");

  const [observacao, setObservacao] = useState("");
  const [statusFinalizacao, setStatusFinalizacao] = useState("CONTATAR");
  const [dataRetorno, setDataRetorno] = useState("");

  const [novoOperadorEmail, setNovoOperadorEmail] = useState("");
  const [motivoAlteracaoOperador, setMotivoAlteracaoOperador] = useState("");

  const [carregando, setCarregando] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState("");

  useEffect(() => {
    iniciar();
  }, []);

  useEffect(() => {
    if (usuarioLogado) {
      carregarFila();
    }
  }, [filtro, usuarioLogado]);

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

    return {
      nome,
      email: user.email,
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
        query = query
          .gte("data_retorno", dataInicioHojeISO())
          .lte("data_retorno", dataFimHojeISO());
      }

      if (filtro === "NEGOCIACAO_24H") {
        query = query.eq("status_jornada", "ALUNO_EM_NEGOCIACAO_24H");
      }

      const { data, error } = await query;

      if (error) {
        console.error("Erro ao carregar fila:", error);
        setErro("Erro ao carregar a fila do operador.");
        setAlunos([]);
        return;
      }

      setAlunos(data || []);
    } catch (e) {
      console.error("Erro inesperado ao carregar fila:", e);
      setErro("Erro inesperado ao carregar a fila.");
      setAlunos([]);
    } finally {
      setCarregando(false);
    }
  }

  async function abrirAlunoNaFila(aluno) {
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
    extra = {},
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
      atualizacaoAluno.data_retorno = retorno;
    }

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
      });

      setObservacao("");

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

      const { error: updateError } = await supabase
        .from("alunos")
        .update({
          responsavel_atual_nome: novoOperador.nome,
          responsavel_atual_email: novoOperador.email,
          responsavel_atual_em: agora,
          registrado_por_nome: usuario.nome,
          registrado_por_email: usuario.email,
          registrado_em: agora,
        })
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
          descricao: `Operador responsável alterado de ${anteriorNome} para ${novoOperador.nome}. Motivo: ${motivo}`,
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
        tipo: "SOLICITACAO_LINK_PAGAMENTO",
        descricao: "Operador solicitou geração de link de pagamento.",
        statusAnterior,
        statusNovo: "SOLICITADO_LINK",
        retorno: null,
        atualizarResponsavel: false,
      });

      await recarregarAlunoSelecionado(alunoSelecionado.id);
      await carregarMovimentacoes(alunoSelecionado.id);
      await carregarFila();

      alert("Solicitação de link registrada com sucesso.");
    } catch (e) {
      console.error(e);
    } finally {
      setSalvando(false);
    }
  }

  async function enviarTermoAdm() {
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
        tipo: "TERMO_ENVIADO_ADM",
        descricao: "Termo enviado para validação administrativa.",
        statusAnterior,
        statusNovo: "TERMO_ENVIADO_ADM",
        retorno: null,
        atualizarResponsavel: false,
      });

      await recarregarAlunoSelecionado(alunoSelecionado.id);
      await carregarMovimentacoes(alunoSelecionado.id);
      await carregarFila();

      alert("Termo enviado para ADM com sucesso.");
    } catch (e) {
      console.error(e);
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

      const data = new Date(aluno.data_retorno);
      const inicio = new Date(dataInicioHojeISO());
      const fim = new Date(dataFimHojeISO());

      return data >= inicio && data <= fim;
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
      <div style={cabecalho}>
        <div>
          <h1 style={titulo}>Fila do operador</h1>
          <p style={subtitulo}>
            Clique no aluno para abrir a ficha nesta mesma tela.
          </p>

          <p style={usuarioTexto}>
            Usuário logado:{" "}
            <strong>{usuarioLogado?.nome || "Carregando..."}</strong>
            {usuarioLogado?.email ? ` - ${usuarioLogado.email}` : ""}
          </p>
        </div>

        <button
          type="button"
          onClick={carregarFila}
          disabled={carregando}
          style={botaoPrincipal}
        >
          {carregando ? "Carregando..." : "Atualizar fila"}
        </button>
      </div>

      <div style={cardsResumo}>
        <div style={cardResumo}>
          <strong>Total na visão</strong>
          <span>{resumo.total}</span>
        </div>

        <div style={cardResumo}>
          <strong>Sem responsável</strong>
          <span>{resumo.semResponsavel}</span>
        </div>

        <div style={cardResumo}>
          <strong>Retornos hoje</strong>
          <span>{resumo.retornosHoje}</span>
        </div>

        <div style={cardResumo}>
          <strong>Negociação 24h</strong>
          <span>{resumo.negociacao24h}</span>
        </div>
      </div>

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
            {FILTROS.map((item) => (
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

                return (
                  <button
                    type="button"
                    key={aluno.id}
                    onClick={() => abrirAlunoNaFila(aluno)}
                    style={{
                      ...cardAluno,
                      background: selecionado ? "#064e3b" : "#1f2937",
                      border: selecionado
                        ? "1px solid #3b82f6"
                        : "1px solid #374151",
                    }}
                  >
                    <div style={linhaTopoCard}>
                      <div>
                        <strong style={nomeAluno}>{nome}</strong>
                        <div style={textoCard}>CPF: {cpf}</div>
                      </div>

                      <span style={badgeStatus}>{status}</span>
                    </div>

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

                  <p style={textoInfo}>
                    Status atual:{" "}
                    <strong style={{ color: "#93c5fd" }}>
                      {pegarCampo(
                        alunoSelecionado,
                        ["status_jornada", "status_atual", "status"],
                        "CONTATAR"
                      )}
                    </strong>
                  </p>
                </div>

                <button
                  type="button"
                  onClick={assumirAtendimento}
                  disabled={salvando}
                  style={botaoPrincipal}
                >
                  {salvando ? "Salvando..." : "Assumir atendimento"}
                </button>
              </div>

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
              </div>

              <div style={caixaDestaque}>
                <h3 style={tituloSecao}>Finalização do atendimento</h3>

                <label style={label}>Status da finalização</label>

                <select
                  value={statusFinalizacao}
                  onChange={(e) => setStatusFinalizacao(e.target.value)}
                  style={select}
                >
                  {STATUS_FINALIZACAO.map((status) => (
                    <option key={status} value={status}>
                      {status}
                    </option>
                  ))}
                </select>

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
                    disabled={salvando}
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

                  <button
                    type="button"
                    onClick={enviarTermoAdm}
                    disabled={salvando}
                    style={botaoSecundario}
                  >
                    Enviar termo ADM
                  </button>
                </div>
              </div>

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
  color: "#93c5fd",
  border: "1px solid #3b82f6",
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