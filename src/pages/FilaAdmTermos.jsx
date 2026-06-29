import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

const ADM_AUTORIZADOS = [
  "cobranca04@aelbra.com.br",
  "cobranca07@aelbra.com.br",
  "amanda.seibel@aelbra.com.br",
];

function traduzStatus(status) {
  const mapa = {
    TERMO_ENVIADO_ADM: "Termo enviado ADM",
    TERMO_RECEBIDO_LIBERADO: "Termo recebido - liberado",
    TERMO_REJEITADO: "Termo rejeitado",
  };

  return mapa[status] || status;
}

export default function FilaAdmTermos() {
  const [usuario, setUsuario] = useState(null);
  const [termos, setTermos] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [motivos, setMotivos] = useState({});
  const [observacoes, setObservacoes] = useState({});

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

  async function atualizarStatusAluno(alunoId, novoStatus) {
    if (!alunoId) return;

    await supabase
      .from("alunos")
      .update({
        status_jornada: novoStatus,
      })
      .eq("id", alunoId);
  }

  async function aprovarTermo(termo) {
    const observacaoAdm = observacoes[termo.id] || "";

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

    await atualizarStatusAluno(termo.aluno_id, "Termo recebido - liberado");

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

    await atualizarStatusAluno(termo.aluno_id, "Termo rejeitado");

    alert("Termo rejeitado e devolvido para operação.");
    carregarTermos();
  }

  const emailUsuario = usuario?.email || "";
  const podeValidar = ADM_AUTORIZADOS.includes(emailUsuario);

  if (carregando) {
    return <div style={styles.container}>Carregando fila ADM...</div>;
  }

  if (!podeValidar) {
    return (
      <div style={styles.container}>
        <h1>Fila ADM de Termos</h1>

        <div style={styles.alerta}>
          Seu usuário não tem permissão para validar termos.
        </div>

        <p>
          Usuário logado: <strong>{emailUsuario}</strong>
        </p>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <h1>Fila ADM de Termos</h1>

      <p style={styles.subtitulo}>
        Aqui a Fernanda e a Amanda validam os termos enviados pela operação.
      </p>

      {termos.length === 0 && (
        <div style={styles.vazio}>Nenhum termo enviado até o momento.</div>
      )}

      {termos.map((termo) => (
        <div key={termo.id} style={styles.card}>
          <div style={styles.topoCard}>
            <div>
              <h2 style={styles.nome}>
                {termo.aluno_nome || "Aluno sem nome"}
              </h2>

              <p style={styles.info}>
                CPF: {termo.aluno_cpf || "Não informado"}
              </p>

              <p style={styles.info}>
                Operador:{" "}
                {termo.operador_nome ||
                  termo.operador_email ||
                  "Não informado"}
              </p>
            </div>

            <span style={styles.status}>{traduzStatus(termo.status)}</span>
          </div>

          <div style={styles.bloco}>
            <strong>Observação da operação:</strong>
            <p>{termo.observacao_operador || "Sem observação."}</p>
          </div>

          {termo.arquivo_url && (
            <div style={styles.bloco}>
              <strong>Termo anexado:</strong>
              <br />
              <a href={termo.arquivo_url} target="_blank" rel="noreferrer">
                Abrir termo de acordo
              </a>
            </div>
          )}

          <div style={styles.bloco}>
            <label style={styles.label}>Observação ADM para aprovação:</label>
            <textarea
              style={styles.textarea}
              placeholder="Exemplo: termo conferido e liberado."
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
            <label style={styles.label}>Motivo da rejeição:</label>
            <textarea
              style={styles.textarea}
              placeholder="Obrigatório apenas se for rejeitar."
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
              disabled={termo.status === "TERMO_RECEBIDO_LIBERADO"}
            >
              Aprovar e liberar
            </button>

            <button
              style={styles.botaoRejeitar}
              onClick={() => rejeitarTermo(termo)}
              disabled={termo.status === "TERMO_REJEITADO"}
            >
              Rejeitar termo
            </button>
          </div>
        </div>
      ))}
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
  subtitulo: {
    color: "#555",
    marginBottom: "20px",
  },
  alerta: {
    background: "#fff3cd",
    border: "1px solid #ffe69c",
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
    borderRadius: "12px",
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
    margin: "0 0 6px 0",
  },
  info: {
    margin: "4px 0",
    color: "#555",
  },
  status: {
    background: "#e9f5ff",
    color: "#005fa3",
    padding: "8px 12px",
    borderRadius: "999px",
    fontWeight: "bold",
    fontSize: "13px",
    whiteSpace: "nowrap",
  },
  bloco: {
    marginTop: "14px",
  },
  label: {
    display: "block",
    fontWeight: "bold",
    marginBottom: "6px",
  },
  textarea: {
    width: "100%",
    minHeight: "70px",
    padding: "10px",
    borderRadius: "8px",
    border: "1px solid #ccc",
    resize: "vertical",
    boxSizing: "border-box",
  },
  acoes: {
    display: "flex",
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
};