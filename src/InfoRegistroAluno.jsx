import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

const STATUS_FINALIZACAO = [
  "EM_ATENDIMENTO",
  "ALUNO_EM_NEGOCIACAO_24H",
  "AGUARDANDO_LINK",
  "SOLICITADO_LINK",
  "TERMO_ENVIADO_ADM",
  "TERMO_RECEBIDO_LIBERADO",
  "TERMO_REJEITADO",
  "ACORDO_FECHADO",
  "SEM_RETORNO",
  "NAO_LOCALIZADO",
  "RETORNAR_DEPOIS",
];

function formatarData(data) {
  if (!data) return "-";

  try {
    return new Date(data).toLocaleString("pt-BR");
  } catch {
    return "-";
  }
}

function pegarCampo(objeto, campos, padrao = "-") {
  for (const campo of campos) {
    if (objeto?.[campo] !== undefined && objeto?.[campo] !== null && objeto?.[campo] !== "") {
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
  const [alunos, setAlunos] = useState([]);
  const [alunoSelecionado, setAlunoSelecionado] = useState(null);
  const [movimentacoes, setMovimentacoes] = useState([]);
  const [busca, setBusca] = useState("");
  const [observacao, setObservacao] = useState("");
  const [statusFinalizacao, setStatusFinalizacao] = useState("EM_ATENDIMENTO");
  const [carregando, setCarregando] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState("");

  useEffect(() => {
    carregarAlunos();
  }, []);

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
      let query = supabase.from("alunos").select("*").limit(80);

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
        setErro("Erro ao carregar alunos. Verifique se as colunas nome e cpf existem na tabela alunos.");
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

  async function abrirAluno(aluno) {
    setAlunoSelecionado(aluno);
    setObservacao("");
    setStatusFinalizacao(pegarCampo(aluno, ["status_jornada", "status"], "EM_ATENDIMENTO"));
    await carregarMovimentacoes(aluno.id);
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
      setAlunoSelecionado(data);
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

  async function registrarMovimentacaoAluno({
    alunoId,
    tipo,
    descricao,
    statusAnterior = null,
    statusNovo = null,
    atualizarResponsavel = false,
  }) {
    if (!alunoId) {
      alert("Aluno sem ID. Não foi possível registrar.");
      return null;
    }

    const usuario = await pegarUsuarioLogado();
    const agora = new Date().toISOString();

    const { error: insertError } = await supabase.from("aluno_movimentacoes").insert({
      aluno_id: String(alunoId),
      tipo,
      descricao,
      status_anterior: statusAnterior,
      status_novo: statusNovo,
      registrado_por_nome: usuario.nome,
      registrado_por_email: usuario.email,
      registrado_em: agora,
    });

    if (insertError) {
      console.error("Erro ao registrar movimentação:", insertError);
      alert("Erro ao registrar movimentação.");
      throw insertError;
    }

    const dadosAtualizacao = {
      registrado_por_nome: usuario.nome,
      registrado_por_email: usuario.email,
      registrado_em: agora,
    };

    if (statusNovo) {
      dadosAtualizacao.status_jornada = statusNovo;
    }

    if (atualizarResponsavel) {
      dadosAtualizacao.responsavel_atual_nome = usuario.nome;
      dadosAtualizacao.responsavel_atual_email = usuario.email;
      dadosAtualizacao.responsavel_atual_em = agora;
    }

    const { error: updateError } = await supabase
      .from("alunos")
      .update(dadosAtualizacao)
      .eq("id", alunoId);

    if (updateError) {
      console.error("Erro ao atualizar aluno:", updateError);
      alert("Movimentação registrada, mas houve erro ao atualizar a ficha do aluno.");
      throw updateError;
    }

    return {
      nome: usuario.nome,
      email: usuario.email,
      registrado_em: agora,
    };
  }

  async function assumirAtendimento() {
    if (!alunoSelecionado?.id) return;

    setSalvando(true);

    try {
      await registrarMovimentacaoAluno({
        alunoId: alunoSelecionado.id,
        tipo: "ASSUMIU_ATENDIMENTO",
        descricao: "Usuário assumiu o atendimento do aluno.",
        statusAnterior: pegarCampo(alunoSelecionado, ["status_jornada", "status"], null),
        statusNovo: "EM_ATENDIMENTO",
        atualizarResponsavel: true,
      });

      await recarregarAlunoSelecionado(alunoSelecionado.id);
      await carregarMovimentacoes(alunoSelecionado.id);
      await carregarAlunos();

      alert("Atendimento assumido e registrado com sucesso.");
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
      const statusAtual = pegarCampo(alunoSelecionado, ["status_jornada", "status"], null);

      await registrarMovimentacaoAluno({
        alunoId: alunoSelecionado.id,
        tipo: "OBSERVACAO",
        descricao: texto,
        statusAnterior: statusAtual,
        statusNovo: statusAtual,
        atualizarResponsavel: false,
      });

      setObservacao("");
      await recarregarAlunoSelecionado(alunoSelecionado.id);
      await carregarMovimentacoes(alunoSelecionado.id);
      await carregarAlunos();

      alert("Observação registrada com sucesso.");
    } catch (e) {
      console.error(e);
    } finally {
      setSalvando(false);
    }
  }

  async function finalizarAtendimento() {
    if (!alunoSelecionado?.id) return;

    if (!statusFinalizacao) {
      alert("Selecione um status de finalização.");
      return;
    }

    setSalvando(true);

    try {
      await registrarMovimentacaoAluno({
        alunoId: alunoSelecionado.id,
        tipo: "FINALIZACAO",
        descricao: `Atendimento finalizado com status: ${statusFinalizacao}.`,
        statusAnterior: pegarCampo(alunoSelecionado, ["status_jornada", "status"], null),
        statusNovo: statusFinalizacao,
        atualizarResponsavel: false,
      });

      await recarregarAlunoSelecionado(alunoSelecionado.id);
      await carregarMovimentacoes(alunoSelecionado.id);
      await carregarAlunos();

      alert("Finalização registrada com sucesso.");
    } catch (e) {
      console.error(e);
    } finally {
      setSalvando(false);
    }
  }

  async function solicitarLinkPagamento() {
    if (!alunoSelecionado?.id) return;

    setSalvando(true);

    try {
      await registrarMovimentacaoAluno({
        alunoId: alunoSelecionado.id,
        tipo: "SOLICITACAO_LINK_PAGAMENTO",
        descricao: "Operador solicitou geração de link de pagamento para o aluno.",
        statusAnterior: pegarCampo(alunoSelecionado, ["status_jornada", "status"], null),
        statusNovo: "SOLICITADO_LINK",
        atualizarResponsavel: false,
      });

      await recarregarAlunoSelecionado(alunoSelecionado.id);
      await carregarMovimentacoes(alunoSelecionado.id);
      await carregarAlunos();

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
      await registrarMovimentacaoAluno({
        alunoId: alunoSelecionado.id,
        tipo: "TERMO_ENVIADO_ADM",
        descricao: "Termo enviado para validação administrativa.",
        statusAnterior: pegarCampo(alunoSelecionado, ["status_jornada", "status"], null),
        statusNovo: "TERMO_ENVIADO_ADM",
        atualizarResponsavel: false,
      });

      await recarregarAlunoSelecionado(alunoSelecionado.id);
      await carregarMovimentacoes(alunoSelecionado.id);
      await carregarAlunos();

      alert("Termo enviado para ADM e registrado com sucesso.");
    } catch (e) {
      console.error(e);
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#020617",
        color: "#ffffff",
        padding: "24px",
        fontFamily: "Arial, sans-serif",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: "16px",
          alignItems: "center",
          marginBottom: "24px",
          flexWrap: "wrap",
        }}
      >
        <div>
          <h1 style={{ margin: 0, color: "#3b82f6" }}>Alunos</h1>
          <p style={{ margin: "6px 0 0", color: "#cbd5e1" }}>
            Pesquisa, ficha, registro de responsável e movimentações do aluno.
          </p>
        </div>

        <button
          onClick={carregarAlunos}
          disabled={carregando}
          style={{
            background: "#3b82f6",
            color: "#020617",
            border: "none",
            borderRadius: "10px",
            padding: "12px 16px",
            fontWeight: "bold",
            cursor: "pointer",
          }}
        >
          {carregando ? "Carregando..." : "Atualizar"}
        </button>
      </div>

      <div
        style={{
          background: "#111827",
          border: "1px solid #1f2937",
          borderRadius: "14px",
          padding: "16px",
          marginBottom: "20px",
        }}
      >
        <label style={{ display: "block", marginBottom: "8px", color: "#d1d5db" }}>
          Buscar aluno por nome ou CPF
        </label>

        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
          <input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                carregarAlunos();
              }
            }}
            placeholder="Digite nome ou CPF"
            style={{
              flex: "1 1 280px",
              background: "#020617",
              color: "#ffffff",
              border: "1px solid #374151",
              borderRadius: "10px",
              padding: "12px",
              outline: "none",
            }}
          />

          <button
            onClick={carregarAlunos}
            disabled={carregando}
            style={{
              background: "#3b82f6",
              color: "#020617",
              border: "none",
              borderRadius: "10px",
              padding: "12px 18px",
              fontWeight: "bold",
              cursor: "pointer",
            }}
          >
            Pesquisar
          </button>
        </div>

        {erro && (
          <p style={{ color: "#f87171", marginTop: "10px" }}>
            {erro}
          </p>
        )}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(280px, 420px) 1fr",
          gap: "20px",
          alignItems: "start",
        }}
      >
        <div
          style={{
            background: "#111827",
            border: "1px solid #1f2937",
            borderRadius: "14px",
            padding: "16px",
          }}
        >
          <h2 style={{ color: "#3b82f6", marginTop: 0 }}>
            Lista de alunos
          </h2>

          {carregando ? (
            <p>Carregando alunos...</p>
          ) : alunos.length === 0 ? (
            <p style={{ color: "#cbd5e1" }}>
              Nenhum aluno encontrado.
            </p>
          ) : (
            <div style={{ display: "grid", gap: "10px" }}>
              {alunos.map((aluno) => {
                const nome = pegarCampo(aluno, ["nome", "nome_aluno", "aluno"], "Aluno sem nome");
                const cpf = pegarCampo(aluno, ["cpf", "CPF"], "-");
                const status = pegarCampo(aluno, ["status_jornada", "status"], "Sem status");
                const selecionado = alunoSelecionado?.id === aluno.id;

                return (
                  <button
                    key={aluno.id}
                    onClick={() => abrirAluno(aluno)}
                    style={{
                      textAlign: "left",
                      background: selecionado ? "#064e3b" : "#1f2937",
                      color: "#ffffff",
                      border: selecionado ? "1px solid #3b82f6" : "1px solid #374151",
                      borderRadius: "12px",
                      padding: "12px",
                      cursor: "pointer",
                    }}
                  >
                    <strong style={{ color: "#ffffff" }}>{nome}</strong>

                    <div style={{ color: "#d1d5db", fontSize: "13px", marginTop: "4px" }}>
                      CPF: {cpf}
                    </div>

                    <div style={{ color: "#93c5fd", fontSize: "13px", marginTop: "4px" }}>
                      Status: {status}
                    </div>

                    <div style={{ color: "#cbd5e1", fontSize: "12px", marginTop: "4px" }}>
                      Responsável:{" "}
                      {aluno.responsavel_atual_nome || "Sem responsável"}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div
          style={{
            background: "#111827",
            border: "1px solid #1f2937",
            borderRadius: "14px",
            padding: "16px",
            minHeight: "400px",
          }}
        >
          {!alunoSelecionado ? (
            <div style={{ color: "#cbd5e1" }}>
              <h2 style={{ color: "#3b82f6", marginTop: 0 }}>
                Ficha do aluno
              </h2>
              <p>Selecione um aluno na lista para abrir a ficha.</p>
            </div>
          ) : (
            <>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: "16px",
                  alignItems: "start",
                  flexWrap: "wrap",
                  marginBottom: "18px",
                }}
              >
                <div>
                  <h2 style={{ color: "#3b82f6", margin: 0 }}>
                    {pegarCampo(alunoSelecionado, ["nome", "nome_aluno", "aluno"], "Aluno sem nome")}
                  </h2>

                  <p style={{ color: "#cbd5e1", margin: "8px 0 0" }}>
                    CPF: {pegarCampo(alunoSelecionado, ["cpf", "CPF"], "-")}
                  </p>

                  <p style={{ color: "#cbd5e1", margin: "4px 0 0" }}>
                    Status atual:{" "}
                    <strong style={{ color: "#93c5fd" }}>
                      {pegarCampo(alunoSelecionado, ["status_jornada", "status"], "Sem status")}
                    </strong>
                  </p>
                </div>

                <button
                  onClick={assumirAtendimento}
                  disabled={salvando}
                  style={{
                    background: "#3b82f6",
                    color: "#020617",
                    border: "none",
                    borderRadius: "10px",
                    padding: "12px 16px",
                    fontWeight: "bold",
                    cursor: "pointer",
                  }}
                >
                  {salvando ? "Salvando..." : "Assumir atendimento"}
                </button>
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                  gap: "12px",
                  marginBottom: "18px",
                }}
              >
                <div style={cardInfo}>
                  <strong>Curso</strong>
                  <br />
                  {pegarCampo(alunoSelecionado, ["curso", "nome_curso"], "-")}
                </div>

                <div style={cardInfo}>
                  <strong>Unidade</strong>
                  <br />
                  {pegarCampo(alunoSelecionado, ["unidade", "campus"], "-")}
                </div>

                <div style={cardInfo}>
                  <strong>Valor em aberto</strong>
                  <br />
                  {moeda(pegarCampo(alunoSelecionado, ["valor_em_aberto", "valor_total", "saldo_devedor"], ""))}
                </div>

                <div style={cardInfo}>
                  <strong>Último status</strong>
                  <br />
                  {pegarCampo(alunoSelecionado, ["ultimo_status", "status_jornada", "status"], "-")}
                </div>

                <div style={cardInfo}>
                  <strong>Data de retorno</strong>
                  <br />
                  {formatarData(pegarCampo(alunoSelecionado, ["data_retorno", "retorno_em"], null))}
                </div>

                <div style={cardInfo}>
                  <strong>Telefone</strong>
                  <br />
                  {pegarCampo(alunoSelecionado, ["telefone", "celular", "whatsapp"], "-")}
                </div>
              </div>

              <div
                style={{
                  background: "#020617",
                  border: "1px solid #3b82f6",
                  borderRadius: "14px",
                  padding: "16px",
                  marginBottom: "18px",
                }}
              >
                <h3 style={{ color: "#3b82f6", marginTop: 0 }}>
                  Informações de registro
                </h3>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                    gap: "12px",
                  }}
                >
                  <div>
                    <strong>Último registro por:</strong>
                    <br />
                    {alunoSelecionado.registrado_por_nome || "Ainda não registrado"}
                  </div>

                  <div>
                    <strong>E-mail do registro:</strong>
                    <br />
                    {alunoSelecionado.registrado_por_email || "-"}
                  </div>

                  <div>
                    <strong>Data do registro:</strong>
                    <br />
                    {formatarData(alunoSelecionado.registrado_em)}
                  </div>

                  <div>
                    <strong>Responsável atual:</strong>
                    <br />
                    {alunoSelecionado.responsavel_atual_nome || "Sem responsável definido"}
                  </div>

                  <div>
                    <strong>E-mail do responsável:</strong>
                    <br />
                    {alunoSelecionado.responsavel_atual_email || "-"}
                  </div>

                  <div>
                    <strong>Assumido em:</strong>
                    <br />
                    {formatarData(alunoSelecionado.responsavel_atual_em)}
                  </div>
                </div>
              </div>

              <div
                style={{
                  background: "#020617",
                  border: "1px solid #374151",
                  borderRadius: "14px",
                  padding: "16px",
                  marginBottom: "18px",
                }}
              >
                <h3 style={{ color: "#3b82f6", marginTop: 0 }}>
                  Ações do atendimento
                </h3>

                <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", marginBottom: "14px" }}>
                  <button
                    onClick={solicitarLinkPagamento}
                    disabled={salvando}
                    style={botaoSecundario}
                  >
                    Solicitar link de pagamento
                  </button>

                  <button
                    onClick={enviarTermoAdm}
                    disabled={salvando}
                    style={botaoSecundario}
                  >
                    Enviar termo para ADM
                  </button>
                </div>

                <label style={{ display: "block", marginBottom: "8px" }}>
                  Incluir observação
                </label>

                <textarea
                  value={observacao}
                  onChange={(e) => setObservacao(e.target.value)}
                  placeholder="Digite a observação do atendimento..."
                  rows={4}
                  style={{
                    width: "100%",
                    background: "#111827",
                    color: "#ffffff",
                    border: "1px solid #374151",
                    borderRadius: "10px",
                    padding: "12px",
                    resize: "vertical",
                    outline: "none",
                    marginBottom: "10px",
                  }}
                />

                <button
                  onClick={salvarObservacao}
                  disabled={salvando}
                  style={{
                    background: "#3b82f6",
                    color: "#020617",
                    border: "none",
                    borderRadius: "10px",
                    padding: "12px 16px",
                    fontWeight: "bold",
                    cursor: "pointer",
                    marginBottom: "18px",
                  }}
                >
                  Salvar observação
                </button>

                <div
                  style={{
                    borderTop: "1px solid #374151",
                    paddingTop: "14px",
                  }}
                >
                  <label style={{ display: "block", marginBottom: "8px" }}>
                    Finalizar / alterar status
                  </label>

                  <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
                    <select
                      value={statusFinalizacao}
                      onChange={(e) => setStatusFinalizacao(e.target.value)}
                      style={{
                        flex: "1 1 260px",
                        background: "#111827",
                        color: "#ffffff",
                        border: "1px solid #374151",
                        borderRadius: "10px",
                        padding: "12px",
                      }}
                    >
                      {STATUS_FINALIZACAO.map((status) => (
                        <option key={status} value={status}>
                          {status}
                        </option>
                      ))}
                    </select>

                    <button
                      onClick={finalizarAtendimento}
                      disabled={salvando}
                      style={{
                        background: "#3b82f6",
                        color: "#020617",
                        border: "none",
                        borderRadius: "10px",
                        padding: "12px 16px",
                        fontWeight: "bold",
                        cursor: "pointer",
                      }}
                    >
                      Registrar finalização
                    </button>
                  </div>
                </div>
              </div>

              <div
                style={{
                  background: "#020617",
                  border: "1px solid #374151",
                  borderRadius: "14px",
                  padding: "16px",
                }}
              >
                <h3 style={{ color: "#3b82f6", marginTop: 0 }}>
                  Movimentações do aluno
                </h3>

                {movimentacoes.length === 0 ? (
                  <p style={{ color: "#cbd5e1" }}>
                    Nenhuma movimentação registrada ainda.
                  </p>
                ) : (
                  <div style={{ display: "grid", gap: "10px" }}>
                    {movimentacoes.map((mov) => (
                      <div
                        key={mov.id}
                        style={{
                          background: "#111827",
                          borderRadius: "12px",
                          padding: "12px",
                          borderLeft: "4px solid #3b82f6",
                        }}
                      >
                        <strong style={{ color: "#ffffff" }}>{mov.tipo}</strong>

                        <p style={{ margin: "6px 0", color: "#e5e7eb" }}>
                          {mov.descricao || "-"}
                        </p>

                        {(mov.status_anterior || mov.status_novo) && (
                          <p style={{ margin: "6px 0", color: "#cbd5e1", fontSize: "13px" }}>
                            Status: {mov.status_anterior || "-"} → {mov.status_novo || "-"}
                          </p>
                        )}

                        <small style={{ color: "#cbd5e1" }}>
                          Registrado por:{" "}
                          <strong>{mov.registrado_por_nome || "Não identificado"}</strong>
                          {mov.registrado_por_email ? ` - ${mov.registrado_por_email}` : ""}
                          <br />
                          Em: {formatarData(mov.registrado_em)}
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

const cardInfo = {
  background: "#020617",
  border: "1px solid #374151",
  borderRadius: "12px",
  padding: "12px",
  color: "#e5e7eb",
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