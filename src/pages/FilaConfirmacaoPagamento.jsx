import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { podeBaixarPagamento } from "../utils/operadores";

const STATUS_LABEL = {
  AGUARDANDO_CONFIRMACAO: "Aguardando confirmação",
  PAGAMENTO_CONFIRMADO: "Pagamento confirmado (baixado)",
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
  if (status === "PAGAMENTO_CONFIRMADO") {
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

export default function FilaConfirmacaoPagamento() {
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
      .from("solicitacoes_confirmacao_pagamento")
      .select("*")
      .order("criado_em", { ascending: false });

    if (error) {
      alert("Erro ao carregar fila de confirmação de pagamento: " + error.message);
      setCarregando(false);
      return;
    }

    setSolicitacoes(data || []);
    setCarregando(false);
  }

  async function confirmarPagamento(solicitacao) {
    const observacaoAdm = observacoes[solicitacao.id] || "";
    const agora = new Date().toISOString();

    const { error } = await supabase
      .from("solicitacoes_confirmacao_pagamento")
      .update({
        status: "PAGAMENTO_CONFIRMADO",
        observacao_adm: observacaoAdm,
        confirmado_por: usuario?.email || "",
        confirmado_em: agora,
        atualizado_em: agora,
      })
      .eq("id", solicitacao.id);

    if (error) {
      alert("Erro ao confirmar pagamento: " + error.message);
      return;
    }

    if (solicitacao.aluno_id) {
      await supabase
        .from("alunos")
        .update({
          status_jornada: "BAIXA_REALIZADA",
          status_atual: "BAIXA_REALIZADA",
          status_acionamento: "BAIXA_REALIZADA",
          data_ultimo_acionamento: agora,
        })
        .eq("id", solicitacao.aluno_id);
    }

    alert("Pagamento confirmado e baixado no sistema.");
    carregarSolicitacoes();
  }

  const emailUsuario = usuario?.email || "";
  const podeUsar = podeBaixarPagamento(emailUsuario);

  const contadores = useMemo(() => {
    return {
      pendentes: solicitacoes.filter((s) => s.status === "AGUARDANDO_CONFIRMACAO").length,
      confirmados: solicitacoes.filter((s) => s.status === "PAGAMENTO_CONFIRMADO").length,
      todos: solicitacoes.length,
    };
  }, [solicitacoes]);

  const solicitacoesFiltradas = useMemo(() => {
    if (filtro === "PENDENTES") {
      return solicitacoes.filter((s) => s.status === "AGUARDANDO_CONFIRMACAO");
    }

    if (filtro === "CONFIRMADOS") {
      return solicitacoes.filter((s) => s.status === "PAGAMENTO_CONFIRMADO");
    }

    return solicitacoes;
  }, [solicitacoes, filtro]);

  if (carregando) {
    return <div style={styles.container}>Carregando fila de confirmação de pagamento...</div>;
  }

  if (!podeUsar) {
    return (
      <div style={styles.container}>
        <h1 style={styles.titulo}>Fila de Confirmação de Pagamento</h1>

        <div style={styles.alerta}>
          Seu usuário não tem permissão para acessar esta fila.
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.cabecalho}>
        <div>
          <h1 style={styles.titulo}>Fila de Confirmação de Pagamento</h1>
          <p style={styles.subtitulo}>
            Casos enviados pela operação (tabulação "Confirmar pagamento") aguardando baixa.
          </p>
        </div>

        <button style={styles.botaoAtualizar} onClick={carregarSolicitacoes}>
          Atualizar
        </button>
      </div>

      <div style={styles.cardsIndicadores}>
        <div style={styles.indicador}>
          <span style={styles.numero}>{contadores.pendentes}</span>
          <span style={styles.descricao}>Aguardando confirmação</span>
        </div>

        <div style={styles.indicador}>
          <span style={styles.numero}>{contadores.confirmados}</span>
          <span style={styles.descricao}>Confirmados</span>
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
          Aguardando confirmação
        </button>

        <button
          style={filtro === "CONFIRMADOS" ? styles.filtroAtivo : styles.filtro}
          onClick={() => setFiltro("CONFIRMADOS")}
        >
          Confirmados
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
        const pendente = s.status === "AGUARDANDO_CONFIRMACAO";

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

                {s.valor_informado != null && (
                  <p style={styles.info}>
                    <strong>Valor informado:</strong>{" "}
                    {Number(s.valor_informado).toLocaleString("pt-BR", {
                      style: "currency",
                      currency: "BRL",
                    })}
                  </p>
                )}

                <p style={styles.info}>
                  <strong>Enviado em:</strong> {formatarData(s.criado_em)}
                </p>
              </div>

              <span style={{ ...styles.status, ...corStatus(s.status) }}>
                {traduzStatus(s.status)}
              </span>
            </div>

            <div style={styles.bloco}>
              <strong>Observação do operador:</strong>
              <p style={styles.paragrafo}>{s.motivo || "Sem observação."}</p>
            </div>

            {s.observacao_adm && (
              <div style={styles.blocoRetorno}>
                <strong>Observação de quem confirmou:</strong>
                <p style={styles.paragrafo}>{s.observacao_adm}</p>

                <p style={styles.info}>
                  <strong>Confirmado por:</strong> {s.confirmado_por || "-"}
                </p>

                <p style={styles.info}>
                  <strong>Confirmado em:</strong> {formatarData(s.confirmado_em)}
                </p>
              </div>
            )}

            {pendente && (
              <>
                <div style={styles.bloco}>
                  <label style={styles.label}>Observação (opcional)</label>
                  <textarea
                    style={styles.textarea}
                    placeholder="Exemplo: comprovante conferido no extrato do dia 01/07."
                    value={observacoes[s.id] || ""}
                    onChange={(e) =>
                      setObservacoes({ ...observacoes, [s.id]: e.target.value })
                    }
                  />
                </div>

                <div style={styles.acoes}>
                  <button
                    style={styles.botaoConfirmar}
                    onClick={() => confirmarPagamento(s)}
                  >
                    Confirmar pagamento e dar baixa
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
    margin: 0,
    color: "#4b5563",
  },
  botaoAtualizar: {
    background: "#111827",
    color: "#fff",
    border: "none",
    padding: "10px 16px",
    borderRadius: "8px",
    cursor: "pointer",
    fontWeight: "bold",
    height: "fit-content",
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
    display: "flex",
    flexDirection: "column",
    gap: "4px",
  },
  numero: {
    fontSize: "26px",
    fontWeight: "bold",
    color: "#111827",
  },
  descricao: {
    fontSize: "13px",
    color: "#6b7280",
  },
  filtros: {
    display: "flex",
    gap: "10px",
    marginBottom: "18px",
    flexWrap: "wrap",
  },
  filtro: {
    background: "#fff",
    border: "1px solid #d1d5db",
    color: "#374151",
    padding: "8px 14px",
    borderRadius: "999px",
    cursor: "pointer",
    fontSize: "13px",
  },
  filtroAtivo: {
    background: "#0ea5e9",
    border: "1px solid #0ea5e9",
    color: "#fff",
    padding: "8px 14px",
    borderRadius: "999px",
    cursor: "pointer",
    fontSize: "13px",
    fontWeight: "bold",
  },
  vazio: {
    background: "#fff",
    borderRadius: "12px",
    padding: "20px",
    textAlign: "center",
    color: "#6b7280",
  },
  card: {
    background: "#fff",
    borderRadius: "14px",
    padding: "20px",
    marginBottom: "14px",
    boxShadow: "0 2px 10px rgba(0,0,0,0.06)",
  },
  topoCard: {
    display: "flex",
    justifyContent: "space-between",
    gap: "16px",
    alignItems: "flex-start",
    marginBottom: "10px",
  },
  nome: {
    margin: 0,
    marginBottom: "6px",
    color: "#111827",
  },
  info: {
    margin: "4px 0",
    color: "#374151",
    fontSize: "14px",
  },
  status: {
    padding: "8px 12px",
    borderRadius: "999px",
    fontWeight: "bold",
    fontSize: "13px",
    whiteSpace: "nowrap",
  },
  bloco: {
    marginTop: "12px",
  },
  blocoRetorno: {
    marginTop: "12px",
    background: "#f8fafc",
    border: "1px solid #e5e7eb",
    borderRadius: "10px",
    padding: "12px",
  },
  paragrafo: {
    margin: "6px 0",
    color: "#374151",
    lineHeight: 1.4,
  },
  label: {
    display: "block",
    fontWeight: "bold",
    marginBottom: "6px",
    color: "#111827",
    fontSize: "13px",
  },
  textarea: {
    width: "100%",
    minHeight: "70px",
    padding: "10px",
    borderRadius: "8px",
    border: "1px solid #ccc",
    resize: "vertical",
    boxSizing: "border-box",
    fontFamily: "Arial, sans-serif",
  },
  acoes: {
    marginTop: "12px",
  },
  botaoConfirmar: {
    background: "#198754",
    color: "#fff",
    border: "none",
    padding: "12px 18px",
    borderRadius: "8px",
    cursor: "pointer",
    fontWeight: "bold",
  },
  alerta: {
    background: "#fff3cd",
    color: "#664d03",
    border: "1px solid #ffecb5",
    borderRadius: "10px",
    padding: "16px",
  },
};
