import { useEffect, useState } from "react";
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

const STATUS_FINALIZACAO = [
  "CONTATAR",
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

export default function Alunos() {
  const [usuarioLogado, setUsuarioLogado] = useState(null);
  const [alunos, setAlunos] = useState([]);
  const [alunoSelecionado, setAlunoSelecionado] = useState(null);
  const [movimentacoes, setMovimentacoes] = useState([]);
  const [busca, setBusca] = useState("");
  const [observacao, setObservacao] = useState("");
  const [statusFinalizacao, setStatusFinalizacao] = useState("CONTATAR");
  const [dataRetorno, setDataRetorno] = useState("");
  const [novoOperadorEmail, setNovoOperadorEmail] = useState("");
  const [motivoAlteracaoOperador, setMotivoAlteracaoOperador] = useState("");
  const [carregando, setCarregando] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState("");
  const [origemAbertura, setOrigemAbertura] = useState("");

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
          style={botaoPrincipal}
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
            style={botaoPrincipal}
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
            <div style={{ display: "grid", gap: "10px" }}>
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

                const selecionado = alunoSelecionado?.id === aluno.id;

                return (
                  <button
                    type="button"
                    key={aluno.id}
                    onClick={() => abrirAluno(aluno)}
                    style={{
                      ...cardAlunoLista,
                      background: selecionado ? "#064e3b" : "#1f2937",
                      border: selecionado
                        ? "1px solid #22c55e"
                        : "1px solid #374151",
                    }}
                  >
                    <strong>{nome}</strong>
                    <span>CPF: {cpf}</span>
                    <span>Status: {status}</span>
                    <span>
                      Responsável:{" "}
                      {aluno.responsavel_atual_nome || "Sem responsável"}
                    </span>
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
                    <strong style={{ color: "#86efac" }}>
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
  alignItems: "center",
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

const origemTexto = {
  margin: "8px 0 0",
  color: "#86efac",
  fontSize: "13px",
};

const tituloSecao = {
  color: "#22c55e",
  marginTop: 0,
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

const caixaInterna = {
  background: "#020617",
  border: "1px solid #374151",
  borderRadius: "14px",
  padding: "16px",
  marginBottom: "18px",
};

const layout = {
  display: "grid",
  gridTemplateColumns: "minmax(300px, 420px) 1fr",
  gap: "20px",
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

const cardAlunoLista = {
  textAlign: "left",
  color: "#ffffff",
  borderRadius: "12px",
  padding: "12px",
  cursor: "pointer",
  display: "grid",
  gap: "4px",
};

const cardMov = {
  background: "#111827",
  borderRadius: "12px",
  padding: "12px",
  borderLeft: "4px solid #22c55e",
  color: "#e5e7eb",
};

const textoInfo = {
  color: "#cbd5e1",
  margin: "6px 0",
};

const textoCinza = {
  color: "#cbd5e1",
};

const label = {
  display: "block",
  marginBottom: "8px",
  color: "#d1d5db",
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