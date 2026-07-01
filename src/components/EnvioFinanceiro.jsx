import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { nomeOperadorPorEmail } from "../utils/operadores";

const STATUS_LABEL = {
  AGUARDANDO_ENVIO_FINANCEIRO: "Aguardando envio ao financeiro",
  ENVIADO_FINANCEIRO: "Enviado ao financeiro",
};

function traduzirStatus(status) {
  return STATUS_LABEL[status] || status || "-";
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

function formatarData(data) {
  if (!data) return "-";

  try {
    return new Date(data).toLocaleString("pt-BR");
  } catch {
    return "-";
  }
}

function pegarNomeAluno(aluno) {
  return (
    aluno?.nome ||
    aluno?.nome_aluno ||
    aluno?.aluno ||
    aluno?.nome_completo ||
    "-"
  );
}

function pegarCpfAluno(aluno) {
  return aluno?.cpf || aluno?.CPF || aluno?.cpf_mascarado || "-";
}

export default function EnvioFinanceiro({ aluno }) {
  const [usuario, setUsuario] = useState(null);
  const [motivo, setMotivo] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [carregando, setCarregando] = useState(false);
  const [solicitacoes, setSolicitacoes] = useState([]);

  const alunoId = aluno?.id ? String(aluno.id) : "";

  useEffect(() => {
    carregarUsuario();
  }, []);

  useEffect(() => {
    if (alunoId) {
      carregarSolicitacoes();
    }
  }, [alunoId]);

  async function carregarUsuario() {
    const { data } = await supabase.auth.getUser();
    setUsuario(data?.user || null);
  }

  async function carregarSolicitacoes() {
    if (!alunoId) return;

    setCarregando(true);

    const { data, error } = await supabase
      .from("solicitacoes_financeiro")
      .select("*")
      .eq("aluno_id", alunoId)
      .order("criado_em", { ascending: false });

    if (error) {
      console.error("Erro ao carregar solicitações financeiro:", error);
      setCarregando(false);
      return;
    }

    setSolicitacoes(data || []);
    setCarregando(false);
  }

  const ultimaSolicitacao = useMemo(() => {
    if (!solicitacoes || solicitacoes.length === 0) return null;
    return solicitacoes[0];
  }, [solicitacoes]);

  const temPendente = useMemo(() => {
    return solicitacoes.some(
      (s) => s.status === "AGUARDANDO_ENVIO_FINANCEIRO"
    );
  }, [solicitacoes]);

  async function enviarAoFinanceiro() {
    if (!aluno?.id) {
      alert("Aluno não localizado.");
      return;
    }

    if (temPendente) {
      alert(
        "Este aluno já possui uma solicitação aguardando envio ao financeiro."
      );
      return;
    }

    if (!motivo.trim()) {
      alert("Informe o motivo da solicitação.");
      return;
    }

    setEnviando(true);

    const { data: userData } = await supabase.auth.getUser();
    const usuarioLogado = userData?.user;
    const emailOperador = usuarioLogado?.email || "";
    const nomeOperador = nomeOperadorPorEmail(emailOperador);

    const { error } = await supabase.from("solicitacoes_financeiro").insert({
      aluno_id: String(aluno.id),
      aluno_nome: pegarNomeAluno(aluno),
      aluno_cpf: pegarCpfAluno(aluno),
      operador_email: emailOperador,
      operador_nome: nomeOperador,
      motivo: motivo.trim(),
      status: "AGUARDANDO_ENVIO_FINANCEIRO",
    });

    if (error) {
      alert("Erro ao enviar solicitação ao financeiro: " + error.message);
      setEnviando(false);
      return;
    }

    await supabase
      .from("alunos")
      .update({
        status_jornada: "Aguardando envio financeiro",
        status_atual: "Aguardando envio financeiro",
        status_acionamento: "Aguardando envio financeiro",
        data_ultimo_acionamento: new Date().toISOString(),
      })
      .eq("id", aluno.id);

    alert("Solicitação enviada para a fila da Amanda ADM.");

    setMotivo("");
    setEnviando(false);
    carregarSolicitacoes();
  }

  return (
    <div style={styles.card}>
      <div style={styles.header}>
        <div>
          <h2 style={styles.titulo}>Tabulação — Enviar ao financeiro</h2>
          <p style={styles.texto}>
            Envia o caso para a Amanda ADM encaminhar ao financeiro. Assim que
            ela confirmar o envio, o retorno deste aluno é agendado
            automaticamente para 7 dias.
          </p>
        </div>

        {ultimaSolicitacao && (
          <span style={{ ...styles.status, ...corStatus(ultimaSolicitacao.status) }}>
            {traduzirStatus(ultimaSolicitacao.status)}
          </span>
        )}
      </div>

      {ultimaSolicitacao && (
        <div style={styles.resumo}>
          <strong>Última solicitação</strong>

          <div style={styles.gridResumo}>
            <div>
              <span style={styles.labelResumo}>Status</span>
              <p style={styles.valorResumo}>
                {traduzirStatus(ultimaSolicitacao.status)}
              </p>
            </div>

            <div>
              <span style={styles.labelResumo}>Enviado em</span>
              <p style={styles.valorResumo}>
                {formatarData(ultimaSolicitacao.criado_em)}
              </p>
            </div>

            <div>
              <span style={styles.labelResumo}>Operador</span>
              <p style={styles.valorResumo}>
                {ultimaSolicitacao.operador_nome ||
                  ultimaSolicitacao.operador_email ||
                  "-"}
              </p>
            </div>

            <div>
              <span style={styles.labelResumo}>Confirmado por</span>
              <p style={styles.valorResumo}>
                {ultimaSolicitacao.enviado_por || "-"}
              </p>
            </div>
          </div>

          {ultimaSolicitacao.status === "ENVIADO_FINANCEIRO" && (
            <div style={styles.caixaAdm}>
              <strong>Confirmação da ADM:</strong>
              <p style={styles.paragrafo}>
                Enviado ao financeiro em{" "}
                {formatarData(ultimaSolicitacao.enviado_em)}. Retorno deste
                aluno já foi agendado para 7 dias depois.
              </p>
              {ultimaSolicitacao.observacao_adm && (
                <p style={styles.paragrafo}>
                  <strong>Observação:</strong> {ultimaSolicitacao.observacao_adm}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {temPendente ? (
        <div style={styles.alertaPendente}>
          Este aluno já está na fila da Amanda ADM aguardando envio ao
          financeiro.
        </div>
      ) : (
        <>
          <div style={styles.bloco}>
            <label style={styles.label}>Motivo da solicitação</label>
            <textarea
              style={styles.textarea}
              placeholder="Exemplo: aluno solicitou revisão do valor cobrado, encaminhar ao financeiro para análise."
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
            />
          </div>

          <button
            style={{
              ...styles.botao,
              opacity: enviando ? 0.7 : 1,
              cursor: enviando ? "not-allowed" : "pointer",
            }}
            onClick={enviarAoFinanceiro}
            disabled={enviando}
          >
            {enviando ? "Enviando..." : "Enviar ao financeiro"}
          </button>
        </>
      )}

      <div style={styles.historico}>
        <h3 style={styles.subtitulo}>Histórico de envios deste aluno</h3>

        {carregando && <p style={styles.texto}>Carregando histórico...</p>}

        {!carregando && solicitacoes.length === 0 && (
          <p style={styles.texto}>Nenhuma solicitação enviada ainda.</p>
        )}

        {!carregando &&
          solicitacoes.map((s) => (
            <div key={s.id} style={styles.itemHistorico}>
              <div style={styles.linhaHistorico}>
                <strong>{traduzirStatus(s.status)}</strong>
                <span style={styles.dataHistorico}>{formatarData(s.criado_em)}</span>
              </div>

              <p style={styles.paragrafo}>
                <strong>Operador:</strong> {s.operador_nome || s.operador_email || "-"}
              </p>

              <p style={styles.paragrafo}>
                <strong>Motivo:</strong> {s.motivo || "-"}
              </p>

              {s.observacao_adm && (
                <p style={styles.paragrafo}>
                  <strong>Observação ADM:</strong> {s.observacao_adm}
                </p>
              )}
            </div>
          ))}
      </div>
    </div>
  );
}

const styles = {
  card: {
    background: "#fff",
    borderRadius: "14px",
    padding: "22px",
    marginTop: "24px",
    marginBottom: "24px",
    boxShadow: "0 2px 10px rgba(0,0,0,0.08)",
    borderLeft: "6px solid #198754",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    gap: "16px",
    alignItems: "flex-start",
    marginBottom: "16px",
  },
  titulo: {
    margin: 0,
    marginBottom: "8px",
    color: "#1f2937",
  },
  subtitulo: {
    marginTop: 0,
    marginBottom: "12px",
    color: "#1f2937",
  },
  texto: {
    color: "#555",
    margin: 0,
    lineHeight: 1.5,
  },
  status: {
    padding: "8px 12px",
    borderRadius: "999px",
    fontWeight: "bold",
    fontSize: "13px",
    whiteSpace: "nowrap",
  },
  resumo: {
    background: "#f8fafc",
    border: "1px solid #e5e7eb",
    borderRadius: "12px",
    padding: "14px",
    marginBottom: "16px",
  },
  gridResumo: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
    gap: "12px",
    marginTop: "12px",
  },
  labelResumo: {
    display: "block",
    fontSize: "12px",
    color: "#6b7280",
    marginBottom: "4px",
  },
  valorResumo: {
    margin: 0,
    fontWeight: "bold",
    color: "#111827",
  },
  caixaAdm: {
    marginTop: "14px",
    background: "#fff",
    border: "1px solid #e5e7eb",
    borderRadius: "10px",
    padding: "12px",
  },
  alertaPendente: {
    background: "#fff3cd",
    color: "#664d03",
    border: "1px solid #ffecb5",
    borderRadius: "10px",
    padding: "12px",
    marginBottom: "16px",
  },
  bloco: {
    marginTop: "14px",
  },
  label: {
    display: "block",
    fontWeight: "bold",
    marginBottom: "6px",
    color: "#111827",
  },
  textarea: {
    width: "100%",
    minHeight: "95px",
    padding: "10px",
    borderRadius: "8px",
    border: "1px solid #ccc",
    resize: "vertical",
    boxSizing: "border-box",
    fontFamily: "Arial, sans-serif",
  },
  botao: {
    marginTop: "16px",
    background: "#198754",
    color: "#fff",
    border: "none",
    padding: "12px 18px",
    borderRadius: "8px",
    cursor: "pointer",
    fontWeight: "bold",
  },
  historico: {
    marginTop: "24px",
    borderTop: "1px solid #e5e7eb",
    paddingTop: "18px",
  },
  itemHistorico: {
    background: "#f9fafb",
    border: "1px solid #e5e7eb",
    borderRadius: "10px",
    padding: "12px",
    marginBottom: "10px",
  },
  linhaHistorico: {
    display: "flex",
    justifyContent: "space-between",
    gap: "10px",
    marginBottom: "8px",
  },
  dataHistorico: {
    fontSize: "12px",
    color: "#6b7280",
  },
  paragrafo: {
    margin: "6px 0",
    color: "#374151",
    lineHeight: 1.4,
  },
};
