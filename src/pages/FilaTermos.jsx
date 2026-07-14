import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";

const ADM_AUTORIZADOS = [
  "cobranca04@aelbra.com.br", // Fernanda
  "cobranca07@aelbra.com.br", // Amanda ADM
  "amanda.seibel@aelbra.com.br", // Amanda gestora
];

const STATUS_LABEL = {
  TERMO_ENVIADO_ADM: "Termo enviado ADM",
  TERMO_RECEBIDO_LIBERADO: "Termo recebido - liberado",
  TERMO_REJEITADO: "Termo rejeitado",
  TERMO_LIBERADO_AUTOMATICO_GOV: "Liberado automático (gov.br)",
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
  if (status === "TERMO_RECEBIDO_LIBERADO") {
    return {
      background: "#d1e7dd",
      color: "#0f5132",
      border: "1px solid #badbcc",
    };
  }

  if (status === "TERMO_REJEITADO") {
    return {
      background: "#f8d7da",
      color: "#842029",
      border: "1px solid #f5c2c7",
    };
  }

  if (status === "TERMO_LIBERADO_AUTOMATICO_GOV") {
    return {
      background: "#e0cffc",
      color: "#4b1e8f",
      border: "1px solid #d0bcf5",
    };
  }

  return {
    background: "#cff4fc",
    color: "#055160",
    border: "1px solid #b6effb",
  };
}

export default function FilaAdmTermos() {
  const [usuario, setUsuario] = useState(null);
  const [termos, setTermos] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [motivos, setMotivos] = useState({});
  const [observacoes, setObservacoes] = useState({});
  const [filtro, setFiltro] = useState("PENDENTES");

  useEffect(() => {
    carregarUsuario();
    carregarTermos();
  }, []);

  async function carregarUsuario() {
    const { data } = await supabase.auth.getUser();
    setUsuario(data?.user || null);
  }

  async function carregarTermos() {
    setCarregando(true);

    const { data, error } = await supabase
      .from("termos_acordo")
      .select("*")
      .order("criado_em", { ascending: false });

    if (error) {
      alert("Erro ao carregar fila ADM: " + error.message);
      setCarregando(false);
      return;
    }

    setTermos(data || []);
    setCarregando(false);
  }

  async function atualizarStatusAluno(alunoId, novoStatus, statusAcionamento, termo) {
    if (!alunoId) return;

    // Mesma lógica do link de pagamento: ao concluir a ação da ADM, o caso
    // volta pro topo da fila do operador com prioridade máxima. Os campos
    // de status precisam do código padrão (maiúsculo, sem espaço) --
    // senão nada no resto do sistema reconhece esse valor. E o
    // responsável atual precisa voltar a ser o operador que enviou o
    // termo -- sem isso, o caso muda de status mas nunca aparece na fila
    // de quem deveria receber de volta.
    // Devolucao via RPC segura (executor): status direto + responsavel roteado.
    const { data: rTermo, error } = await supabase.rpc("sistema_retorno_termo", {
      p_aluno_id: alunoId,
      p_status: novoStatus,
      p_status_acionamento: statusAcionamento || novoStatus,
      p_operador_email: termo?.operador_email || null,
      p_operador_nome: termo?.operador_nome || termo?.operador_email || null,
    });
    if (error || !rTermo?.ok) {
      console.error("Erro ao atualizar status do aluno:", rTermo?.erro || error?.message);
    }
  }

  async function aprovarTermo(termo) {
    const observacaoAdm =
      observacoes[termo.id] || "Termo conferido e liberado pela ADM.";

    const { error } = await supabase
      .from("termos_acordo")
      .update({
        status: "TERMO_RECEBIDO_LIBERADO",
        observacao_adm: observacaoAdm,
        validado_por: usuario?.email || "ADM",
        validado_em: new Date().toISOString(),
        atualizado_em: new Date().toISOString(),
      })
      .eq("id", termo.id);

    if (error) {
      alert("Erro ao aprovar termo: " + error.message);
      return;
    }

    await atualizarStatusAluno(termo.aluno_id, "TERMO_RECEBIDO_LIBERADO", "TERMO_RECEBIDO_LIBERADO", termo);

    alert("Termo aprovado e liberado para operação.");
    carregarTermos();
  }

  async function rejeitarTermo(termo) {
    const motivo = motivos[termo.id];

    if (!motivo || motivo.trim() === "") {
      alert("Informe o motivo da rejeição.");
      return;
    }

    const { error } = await supabase
      .from("termos_acordo")
      .update({
        status: "TERMO_REJEITADO",
        observacao_adm: motivo,
        validado_por: usuario?.email || "ADM",
        validado_em: new Date().toISOString(),
        atualizado_em: new Date().toISOString(),
      })
      .eq("id", termo.id);

    if (error) {
      alert("Erro ao rejeitar termo: " + error.message);
      return;
    }

    await atualizarStatusAluno(termo.aluno_id, "TERMO_REJEITADO", "TERMO_REJEITADO", termo);

    alert("Termo rejeitado e devolvido para operação.");
    carregarTermos();
  }

  const emailUsuario = usuario?.email || "";
  const podeValidar = ADM_AUTORIZADOS.includes(emailUsuario);

  const contadores = useMemo(() => {
    return {
      pendentes: termos.filter((t) => t.status === "TERMO_ENVIADO_ADM").length,
      liberados: termos.filter((t) => t.status === "TERMO_RECEBIDO_LIBERADO").length,
      rejeitados: termos.filter((t) => t.status === "TERMO_REJEITADO").length,
      auditoria: termos.filter((t) => t.status === "TERMO_LIBERADO_AUTOMATICO_GOV").length,
      todos: termos.length,
    };
  }, [termos]);

  const termosFiltrados = useMemo(() => {
    if (filtro === "PENDENTES") {
      return termos.filter((t) => t.status === "TERMO_ENVIADO_ADM");
    }

    if (filtro === "LIBERADOS") {
      return termos.filter((t) => t.status === "TERMO_RECEBIDO_LIBERADO");
    }

    if (filtro === "REJEITADOS") {
      return termos.filter((t) => t.status === "TERMO_REJEITADO");
    }

    if (filtro === "AUDITORIA") {
      return termos.filter((t) => t.status === "TERMO_LIBERADO_AUTOMATICO_GOV");
    }

    return termos;
  }, [termos, filtro]);

  if (carregando) {
    return <div style={styles.container}>Carregando fila ADM...</div>;
  }

  if (!podeValidar) {
    return (
      <div style={styles.container}>
        <h1 style={styles.titulo}>Fila ADM de Termos</h1>

        <div style={styles.alerta}>
          Seu usuário não tem permissão para validar termos.
        </div>

        <p>
          Usuário logado: <strong>{emailUsuario || "Não identificado"}</strong>
        </p>

        <p style={styles.texto}>
          Usuários autorizados: Fernanda, Amanda ADM e Amanda gestora.
        </p>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.cabecalho}>
        <div>
          <h1 style={styles.titulo}>Fila ADM de Termos</h1>
          <p style={styles.subtitulo}>
            Validação dos termos de acordo enviados pela operação.
          </p>
        </div>

        <button style={styles.botaoAtualizar} onClick={carregarTermos}>
          Atualizar fila
        </button>
      </div>

      <div style={styles.cardsIndicadores}>
        <div style={styles.indicador}>
          <span style={styles.numero}>{contadores.pendentes}</span>
          <span style={styles.descricao}>Pendentes</span>
        </div>

        <div style={styles.indicador}>
          <span style={styles.numero}>{contadores.liberados}</span>
          <span style={styles.descricao}>Liberados</span>
        </div>

        <div style={styles.indicador}>
          <span style={styles.numero}>{contadores.rejeitados}</span>
          <span style={styles.descricao}>Rejeitados</span>
        </div>

        <div style={styles.indicador}>
          <span style={styles.numero}>{contadores.auditoria}</span>
          <span style={styles.descricao}>Auditoria (gov.br)</span>
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
          Pendentes
        </button>

        <button
          style={filtro === "LIBERADOS" ? styles.filtroAtivo : styles.filtro}
          onClick={() => setFiltro("LIBERADOS")}
        >
          Liberados
        </button>

        <button
          style={filtro === "REJEITADOS" ? styles.filtroAtivo : styles.filtro}
          onClick={() => setFiltro("REJEITADOS")}
        >
          Rejeitados
        </button>

        <button
          style={filtro === "AUDITORIA" ? styles.filtroAtivo : styles.filtro}
          onClick={() => setFiltro("AUDITORIA")}
        >
          Auditoria (gov.br)
        </button>

        <button
          style={filtro === "TODOS" ? styles.filtroAtivo : styles.filtro}
          onClick={() => setFiltro("TODOS")}
        >
          Todos
        </button>
      </div>

      {termosFiltrados.length === 0 && (
        <div style={styles.vazio}>Nenhum termo encontrado neste filtro.</div>
      )}

      {termosFiltrados.map((termo) => {
        const pendente = termo.status === "TERMO_ENVIADO_ADM";

        return (
          <div key={termo.id} style={styles.card}>
            <div style={styles.topoCard}>
              <div>
                <h2 style={styles.nome}>{termo.aluno_nome || "Aluno sem nome"}</h2>

                <p style={styles.info}>
                  <strong>CPF:</strong> {termo.aluno_cpf || "Não informado"}
                </p>

                <p style={styles.info}>
                  <strong>Operador:</strong>{" "}
                  {termo.operador_nome || termo.operador_email || "Não informado"}
                </p>

                <p style={styles.info}>
                  <strong>Enviado em:</strong> {formatarData(termo.criado_em)}
                </p>

                <p style={styles.info}>
                  <strong>Assinatura:</strong>{" "}
                  {termo.tipo_assinatura === "GOV_BR"
                    ? "Gov.br (validada eletronicamente)"
                    : "Manual + RG"}
                </p>
              </div>

              <span style={{ ...styles.status, ...corStatus(termo.status) }}>
                {traduzStatus(termo.status)}
              </span>
            </div>

            <div style={styles.bloco}>
              <strong>Observação da operação:</strong>
              <p style={styles.paragrafo}>
                {termo.observacao_operador || "Sem observação."}
              </p>
            </div>

            {termo.arquivo_url ? (
              <div style={styles.bloco}>
                <strong>Termo anexado:</strong>
                <br />
                <a
                  href={termo.arquivo_url}
                  target="_blank"
                  rel="noreferrer"
                  style={styles.link}
                >
                  Abrir termo de acordo
                </a>

                {termo.arquivo_rg_url && (
                  <>
                    {" "}
                    <a
                      href={termo.arquivo_rg_url}
                      target="_blank"
                      rel="noreferrer"
                      style={styles.link}
                    >
                      Abrir RG anexado
                    </a>
                  </>
                )}

                {termo.tipo_assinatura === "MANUAL_RG" && !termo.arquivo_rg_url && (
                  <p style={{ color: "#b45309", fontSize: 13, marginTop: 6 }}>
                    Termo antigo, enviado antes do RG virar anexo separado -- confira o RG
                    dentro do próprio arquivo do termo, se estiver junto.
                  </p>
                )}
              </div>
            ) : (
              <div style={styles.alerta}>
                Este termo foi enviado sem anexo localizado.
              </div>
            )}

            {termo.observacao_adm && (
              <div style={styles.blocoRetorno}>
                <strong>Retorno ADM:</strong>
                <p style={styles.paragrafo}>{termo.observacao_adm}</p>

                <p style={styles.info}>
                  <strong>Validado por:</strong> {termo.validado_por || "-"}
                </p>

                <p style={styles.info}>
                  <strong>Validado em:</strong> {formatarData(termo.validado_em)}
                </p>
              </div>
            )}

            {pendente && (
              <>
                <div style={styles.bloco}>
                  <label style={styles.label}>Observação ADM para aprovação</label>
                  <textarea
                    style={styles.textarea}
                    placeholder="Exemplo: termo conferido, dados compatíveis e acordo liberado."
                    value={observacoes[termo.id] || ""}
                    onChange={(e) =>
                      setObservacoes({
                        ...observacoes,
                        [termo.id]: e.target.value,
                      })
                    }
                  />
                </div>

                <div style={styles.bloco}>
                  <label style={styles.label}>Motivo da rejeição</label>
                  <textarea
                    style={styles.textarea}
                    placeholder="Obrigatório apenas se for rejeitar. Exemplo: termo ilegível, falta assinatura, dados divergentes..."
                    value={motivos[termo.id] || ""}
                    onChange={(e) =>
                      setMotivos({
                        ...motivos,
                        [termo.id]: e.target.value,
                      })
                    }
                  />
                </div>

                <div style={styles.acoes}>
                  <button
                    style={styles.botaoAprovar}
                    onClick={() => aprovarTermo(termo)}
                  >
                    Aprovar e liberar para operação
                  </button>

                  <button
                    style={styles.botaoRejeitar}
                    onClick={() => rejeitarTermo(termo)}
                  >
                    Rejeitar e devolver com motivo
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
    minHeight: "100%",
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
    background: "#0d6efd",
    color: "#fff",
    border: "1px solid #0d6efd",
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
    minHeight: "75px",
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
  botaoAprovar: {
    background: "#198754",
    color: "#fff",
    border: "none",
    padding: "12px 16px",
    borderRadius: "8px",
    cursor: "pointer",
    fontWeight: "bold",
  },
  botaoRejeitar: {
    background: "#dc3545",
    color: "#fff",
    border: "none",
    padding: "12px 16px",
    borderRadius: "8px",
    cursor: "pointer",
    fontWeight: "bold",
  },
  link: {
    display: "inline-block",
    marginTop: "6px",
    color: "#0d6efd",
    fontWeight: "bold",
  },
};
