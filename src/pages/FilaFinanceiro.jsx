import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { podeGerirFinanceiro } from "../utils/operadores";

const STATUS_LABEL = {
  AGUARDANDO_ENVIO_FINANCEIRO: "Aguardando envio",
  ENVIADO_FINANCEIRO: "Enviado ao financeiro",
};

function traduzStatus(status) {
  return STATUS_LABEL[status] || status || "-";
}

function formatarData(data) {
  if (!data) return "-";

  try {
    return new Date(data).toLocaleString("pt-BR");
  } catch {
    return "-";
  }
}

function corStatus(status) {
  if (status === "ENVIADO_FINANCEIRO") {
    return {
      background: "#d1e7dd",
      color: "#0f5132",
      border: "1px solid #badbcc",
    };
  }

  return {
    background: "#fff3cd",
    color: "#664d03",
    border: "1px solid #ffe69c",
  };
}

export default function FilaFinanceiro() {
  const [usuario, setUsuario] = useState(null);
  const [solicitacoes, setSolicitacoes] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [observacoes, setObservacoes] = useState({});
  const [filtro, setFiltro] = useState("PENDENTES");

  useEffect(() => {
    carregarUsuario();
    carregarSolicitacoes();
  }, []);

  async function carregarUsuario() {
    const { data } = await supabase.auth.getUser();
    setUsuario(data?.user || null);
  }

  async function carregarSolicitacoes() {
    setCarregando(true);

    const { data, error } = await supabase
      .from("solicitacoes_financeiro")
      .select("*")
      .order("criado_em", { ascending: false });

    if (error) {
      alert("Erro ao carregar fila do financeiro: " + error.message);
      setCarregando(false);
      return;
    }

    setSolicitacoes(data || []);
    setCarregando(false);
  }

  async function agendarRetornoAluno(alunoId) {
    if (!alunoId) return;

    const daquiA7Dias = new Date();
    daquiA7Dias.setDate(daquiA7Dias.getDate() + 7);

    const { error } = await supabase
      .from("alunos")
      .update({
        data_retorno: daquiA7Dias.toISOString(),
        status_jornada: "Enviado ao financeiro",
        status_atual: "Enviado ao financeiro",
        status_acionamento: "Enviado ao financeiro",
        proxima_acao: "RETORNAR",
        atualizado_em: new Date().toISOString(),
      })
      .eq("id", alunoId);

    if (error) {
      console.error("Erro ao agendar retorno do aluno:", error);
    }
  }

  async function marcarComoEnviado(solicitacao) {
    const observacaoAdm = observacoes[solicitacao.id] || "";

    const { error } = await supabase
      .from("solicitacoes_financeiro")
      .update({
        status: "ENVIADO_FINANCEIRO",
        observacao_adm: observacaoAdm,
        enviado_por: usuario?.email || "ADM",
        enviado_em: new Date().toISOString(),
        atualizado_em: new Date().toISOString(),
      })
      .eq("id", solicitacao.id);

    if (error) {
      alert("Erro ao confirmar envio: " + error.message);
      return;
    }

    await agendarRetornoAluno(solicitacao.aluno_id);

    alert(
      "Envio confirmado. Retorno deste aluno já foi agendado para daqui a 7 dias."
    );

    carregarSolicitacoes();
  }

  const emailUsuario = usuario?.email || "";
  const podeUsar = podeGerirFinanceiro(emailUsuario);

  const contadores = useMemo(() => {
    return {
      pendentes: solicitacoes.filter(
        (s) => s.status === "AGUARDANDO_ENVIO_FINANCEIRO"
      ).length,
      enviados: solicitacoes.filter((s) => s.status === "ENVIADO_FINANCEIRO")
        .length,
      todos: solicitacoes.length,
    };
  }, [solicitacoes]);

  const solicitacoesFiltradas = useMemo(() => {
    if (filtro === "PENDENTES") {
      return solicitacoes.filter(
        (s) => s.status === "AGUARDANDO_ENVIO_FINANCEIRO"
      );
    }

    if (filtro === "ENVIADOS") {
      return solicitacoes.filter((s) => s.status === "ENVIADO_FINANCEIRO");
    }

    return solicitacoes;
  }, [solicitacoes, filtro]);

  if (carregando) {
    return <div style={styles.container}>Carregando fila do financeiro...</div>;
  }

  if (!podeUsar) {
    return (
      <div style={styles.container}>
        <h1 style={styles.titulo}>Fila do Financeiro</h1>

        <div style={styles.alerta}>
          Seu usuário não tem permissão para acessar esta fila.
        </div>

        <p style={styles.texto}>
          Usuários autorizados: Amanda ADM e Amanda gestora.
        </p>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.cabecalho}>
        <div>
          <h1 style={styles.titulo}>Fila do Financeiro</h1>
          <p style={styles.subtitulo}>
            Solicitações enviadas pela operação (tabulação "Enviar ao financeiro").
          </p>
        </div>

        <button style={styles.botaoAtualizar} onClick={carregarSolicitacoes}>
          Atualizar
        </button>
      </div>

      <div style={styles.cardsIndicadores}>
        <div style={styles.indicador}>
          <span style={styles.numero}>{contadores.pendentes}</span>
          <span style={styles.descricao}>Aguardando envio</span>
        </div>

        <div style={styles.indicador}>
          <span style={styles.numero}>{contadores.enviados}</span>
          <span style={styles.descricao}>Enviados</span>
        </div>

        <div style={styles.indicador}>
          <span style={styles.numero}>{contadores.todos}</span>
          <span style={styles.descricao}>Total</span>
        </div>
      </div>

      <div style={styles.filtros}>
        <button
          style={filtro === "PENDENTES" ? styles.filtroAtivo : styles.filtro}
          onClick={() => setFiltro("PENDENTES")}
        >
          Aguardando envio
        </button>

        <button
          style={filtro === "ENVIADOS" ? styles.filtroAtivo : styles.filtro}
          onClick={() => setFiltro("ENVIADOS")}
        >
          Enviados
        </button>

        <button
          style={filtro === "TODOS" ? styles.filtroAtivo : styles.filtro}
          onClick={() => setFiltro("TODOS")}
        >
          Todos
        </button>
      </div>

      {solicitacoesFiltradas.length === 0 && (
        <div style={styles.vazio}>Nenhuma solicitação neste filtro.</div>
      )}

      {solicitacoesFiltradas.map((s) => {
        const pendente = s.status === "AGUARDANDO_ENVIO_FINANCEIRO";

        return (
          <div key={s.id} style={styles.card}>
            <div style={styles.topoCard}>
              <div>
                <h2 style={styles.nome}>{s.aluno_nome || "Aluno sem nome"}</h2>

                <p style={styles.info}>
                  <strong>CPF:</strong> {s.aluno_cpf || "Não informado"}
                </p>

                <p style={styles.info}>
                  <strong>Operador:</strong>{" "}
                  {s.operador_nome || s.operador_email || "Não informado"}
                </p>

                <p style={styles.info}>
                  <strong>Solicitado em:</strong> {formatarData(s.criado_em)}
                </p>
              </div>

              <span style={{ ...styles.status, ...corStatus(s.status) }}>
                {traduzStatus(s.status)}
              </span>
            </div>

            <div style={styles.bloco}>
              <strong>Motivo:</strong>
              <p style={styles.paragrafo}>{s.motivo || "Sem motivo informado."}</p>
            </div>

            {s.observacao_adm && (
              <div style={styles.blocoRetorno}>
                <strong>Observação ao enviar:</strong>
                <p style={styles.paragrafo}>{s.observacao_adm}</p>

                <p style={styles.info}>
                  <strong>Enviado por:</strong> {s.enviado_por || "-"}
                </p>

                <p style={styles.info}>
                  <strong>Enviado em:</strong> {formatarData(s.enviado_em)}
                </p>
              </div>
            )}

            {pendente && (
              <>
                <div style={styles.bloco}>
                  <label style={styles.label}>Observação (opcional)</label>
                  <textarea
                    style={styles.textarea}
                    placeholder="Exemplo: enviado por e-mail ao financeiro em 01/07."
                    value={observacoes[s.id] || ""}
                    onChange={(e) =>
                      setObservacoes({ ...observacoes, [s.id]: e.target.value })
                    }
                  />
                </div>

                <div style={styles.acoes}>
                  <button
                    style={styles.botaoConfirmar}
                    onClick={() => marcarComoEnviado(s)}
                  >
                    Marcar como enviado ao financeiro
                  </button>
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

const styles = {
  container: {
    padding: "24px",
    fontFamily: "Arial, sans-serif",
    background: "#f4f6f8",
    minHeight: "100vh",
  },
  cabecalho: {
    display: "flex",
    justifyContent: "space-between",
    gap: "16px",
    alignItems: "flex-start",
    marginBottom: "18px",
  },
  titulo: {
    margin: 0,
    marginBottom: "6px",
    color: "#111827",
  },
  subtitulo: {
    color: "#555",
    margin: 0,
  },
  texto: {
    color: "#555",
  },
  botaoAtualizar: {
    background: "#111827",
    color: "#fff",
    border: "none",
    padding: "11px 16px",
    borderRadius: "8px",
    cursor: "pointer",
    fontWeight: "bold",
  },
  cardsIndicadores: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
    gap: "12px",
    marginBottom: "18px",
  },
  indicador: {
    background: "#fff",
    borderRadius: "12px",
    padding: "16px",
    boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
  },
  numero: {
    display: "block",
    fontSize: "28px",
    fontWeight: "bold",
    color: "#111827",
  },
  descricao: {
    display: "block",
    color: "#6b7280",
    marginTop: "4px",
  },
  filtros: {
    display: "flex",
    flexWrap: "wrap",
    gap: "8px",
    marginBottom: "18px",
  },
  filtro: {
    background: "#fff",
    color: "#111827",
    border: "1px solid #d1d5db",
    padding: "9px 14px",
    borderRadius: "999px",
    cursor: "pointer",
    fontWeight: "bold",
  },
  filtroAtivo: {
    background: "#198754",
    color: "#fff",
    border: "1px solid #198754",
    padding: "9px 14px",
    borderRadius: "999px",
    cursor: "pointer",
    fontWeight: "bold",
  },
  alerta: {
    background: "#fff3cd",
    border: "1px solid #ffe69c",
    color: "#664d03",
    padding: "14px",
    borderRadius: "8px",
    marginBottom: "16px",
  },
  vazio: {
    background: "#fff",
    padding: "18px",
    borderRadius: "10px",
  },
  card: {
    background: "#fff",
    borderRadius: "14px",
    padding: "20px",
    marginBottom: "18px",
    boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
  },
  topoCard: {
    display: "flex",
    justifyContent: "space-between",
    gap: "12px",
    alignItems: "flex-start",
    marginBottom: "16px",
  },
  nome: {
    margin: "0 0 8px 0",
    color: "#111827",
  },
  info: {
    margin: "5px 0",
    color: "#555",
  },
  status: {
    padding: "8px 12px",
    borderRadius: "999px",
    fontWeight: "bold",
    fontSize: "13px",
    whiteSpace: "nowrap",
  },
  bloco: {
    marginTop: "14px",
  },
  blocoRetorno: {
    marginTop: "14px",
    background: "#f8fafc",
    border: "1px solid #e5e7eb",
    borderRadius: "10px",
    padding: "12px",
  },
  paragrafo: {
    color: "#374151",
    lineHeight: 1.4,
    margin: "8px 0",
  },
  label: {
    display: "block",
    fontWeight: "bold",
    marginBottom: "6px",
    color: "#111827",
  },
  textarea: {
    width: "100%",
    minHeight: "60px",
    padding: "10px",
    borderRadius: "8px",
    border: "1px solid #ccc",
    resize: "vertical",
    boxSizing: "border-box",
    fontFamily: "Arial, sans-serif",
  },
  acoes: {
    display: "flex",
    flexWrap: "wrap",
    gap: "10px",
    marginTop: "18px",
  },
  botaoConfirmar: {
    background: "#198754",
    color: "#fff",
    border: "none",
    padding: "12px 16px",
    borderRadius: "8px",
    cursor: "pointer",
    fontWeight: "bold",
  },
};
