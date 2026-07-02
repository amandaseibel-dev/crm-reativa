import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { nomeOperadorPorEmail } from "../utils/operadores";

const STATUS_LABEL = {
  AGUARDANDO_CONFIRMACAO: "Aguardando confirmação",
  PAGAMENTO_CONFIRMADO: "Pagamento confirmado (baixado)",
};

function traduzirStatus(status) {
  return STATUS_LABEL[status] || status || "-";
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

const OPCAO_NOVO_ACORDO = "NOVO";

export default function ConfirmarPagamento({ aluno }) {
  const [motivo, setMotivo] = useState("");
  const [valorInformado, setValorInformado] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [carregando, setCarregando] = useState(false);
  const [solicitacoes, setSolicitacoes] = useState([]);
  const [parcelasAbertas, setParcelasAbertas] = useState([]);
  const [parcelaEscolhida, setParcelaEscolhida] = useState("");
  const [formaPagamento, setFormaPagamento] = useState("A_VISTA");
  const [qtdParcelas, setQtdParcelas] = useState("1");
  const [valorEntrada, setValorEntrada] = useState("");
  const [entradaPaga, setEntradaPaga] = useState(false);

  const alunoId = aluno?.id ? String(aluno.id) : "";

  useEffect(() => {
    if (alunoId) {
      carregarSolicitacoes();
      carregarParcelasAbertas();
    }
  }, [alunoId]);

  async function carregarParcelasAbertas() {
    if (!alunoId) return;

    const { data, error } = await supabase
      .from("parcelas")
      .select("id, numero, valor, vencimento, status, acordos!inner(id, aluno_id, tipo)")
      .eq("acordos.aluno_id", alunoId)
      .in("status", ["A_VENCER", "VENCIDA"])
      .order("vencimento", { ascending: true });

    if (error) {
      console.error("Erro ao carregar parcelas em aberto:", error);
      return;
    }

    setParcelasAbertas(data || []);
  }

  async function carregarSolicitacoes() {
    if (!alunoId) return;

    setCarregando(true);

    const { data, error } = await supabase
      .from("solicitacoes_confirmacao_pagamento")
      .select("*")
      .eq("aluno_id", alunoId)
      .order("criado_em", { ascending: false });

    if (error) {
      console.error("Erro ao carregar solicitações de confirmação de pagamento:", error);
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
    return solicitacoes.some((s) => s.status === "AGUARDANDO_CONFIRMACAO");
  }, [solicitacoes]);

  async function enviarParaConfirmacao() {
    if (!aluno?.id) {
      alert("Aluno não localizado.");
      return;
    }

    if (temPendente) {
      alert("Este aluno já está na fila aguardando confirmação de pagamento.");
      return;
    }

    const usandoParcelaExistente = parcelaEscolhida && parcelaEscolhida !== OPCAO_NOVO_ACORDO;

    if (!usandoParcelaExistente && formaPagamento === "PARCELADO" && !qtdParcelas) {
      alert("Informe em quantas vezes vai ser parcelado.");
      return;
    }

    setEnviando(true);

    const { data: userData } = await supabase.auth.getUser();
    const usuarioLogado = userData?.user;
    const emailOperador = usuarioLogado?.email || "";
    const nomeOperador = nomeOperadorPorEmail(emailOperador);

    const parcelaSelecionada = usandoParcelaExistente
      ? parcelasAbertas.find((p) => p.id === parcelaEscolhida)
      : null;

    const { error } = await supabase
      .from("solicitacoes_confirmacao_pagamento")
      .insert({
        aluno_id: String(aluno.id),
        aluno_nome: pegarNomeAluno(aluno),
        aluno_cpf: pegarCpfAluno(aluno),
        operador_email: emailOperador,
        operador_nome: nomeOperador,
        valor_informado: valorInformado ? Number(valorInformado.replace(",", ".")) : null,
        motivo: motivo.trim(),
        status: "AGUARDANDO_CONFIRMACAO",
        parcela_id: parcelaSelecionada ? parcelaSelecionada.id : null,
        acordo_id: parcelaSelecionada ? parcelaSelecionada.acordos.id : null,
        forma_pagamento: usandoParcelaExistente ? null : formaPagamento,
        qtd_parcelas: !usandoParcelaExistente && formaPagamento === "PARCELADO" ? Number(qtdParcelas) : null,
        valor_entrada: !usandoParcelaExistente && valorEntrada ? Number(valorEntrada.replace(",", ".")) : null,
        entrada_paga: !usandoParcelaExistente ? entradaPaga : null,
      });

    if (error) {
      alert("Erro ao enviar para confirmação de pagamento: " + error.message);
      setEnviando(false);
      return;
    }

    const agora = new Date().toISOString();

    await supabase
      .from("alunos")
      .update({
        status_jornada: "AGUARDANDO_BAIXA",
        status_atual: "AGUARDANDO_BAIXA",
        status_acionamento: "Aguardando confirmação de pagamento",
        data_ultimo_acionamento: agora,
      })
      .eq("id", aluno.id);

    alert("Enviado para a fila de confirmação de pagamento.");

    setMotivo("");
    setValorInformado("");
    setEnviando(false);
    carregarSolicitacoes();
  }

  return (
    <div style={styles.card}>
      <div style={styles.header}>
        <div>
          <h2 style={styles.titulo}>Tabulação — Confirmar pagamento</h2>
          <p style={styles.texto}>
            Use quando o aluno informar que já pagou. O caso vai para a fila
            de confirmação para dar baixa no sistema.
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
              <p style={styles.valorResumo}>{traduzirStatus(ultimaSolicitacao.status)}</p>
            </div>

            <div>
              <span style={styles.labelResumo}>Enviado em</span>
              <p style={styles.valorResumo}>{formatarData(ultimaSolicitacao.criado_em)}</p>
            </div>

            <div>
              <span style={styles.labelResumo}>Operador</span>
              <p style={styles.valorResumo}>
                {ultimaSolicitacao.operador_nome || ultimaSolicitacao.operador_email || "-"}
              </p>
            </div>

            <div>
              <span style={styles.labelResumo}>Confirmado por</span>
              <p style={styles.valorResumo}>{ultimaSolicitacao.confirmado_por || "-"}</p>
            </div>
          </div>

          {ultimaSolicitacao.status === "PAGAMENTO_CONFIRMADO" && (
            <div style={styles.caixaAdm}>
              <strong>Confirmação:</strong>
              <p style={styles.paragrafo}>
                Pagamento baixado em {formatarData(ultimaSolicitacao.confirmado_em)}.
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
          Este aluno já está na fila de confirmação de pagamento.
        </div>
      ) : (
        <>
          <div style={styles.bloco}>
            <label style={styles.label}>Valor informado pelo aluno (opcional)</label>
            <input
              style={styles.input}
              placeholder="Ex: 350,00"
              value={valorInformado}
              onChange={(e) => setValorInformado(e.target.value)}
            />
          </div>

          <div style={styles.bloco}>
            <label style={styles.label}>Observação</label>
            <textarea
              style={styles.textarea}
              placeholder="Exemplo: aluno mandou comprovante por WhatsApp, pagou via Pix."
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
            onClick={enviarParaConfirmacao}
            disabled={enviando}
          >
            {enviando ? "Enviando..." : "Enviar para confirmação de pagamento"}
          </button>
        </>
      )}

      <div style={styles.historico}>
        <h3 style={styles.subtitulo}>Histórico deste aluno</h3>

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

              {s.valor_informado != null && (
                <p style={styles.paragrafo}>
                  <strong>Valor informado:</strong>{" "}
                  {Number(s.valor_informado).toLocaleString("pt-BR", {
                    style: "currency",
                    currency: "BRL",
                  })}
                </p>
              )}

              <p style={styles.paragrafo}>
                <strong>Observação:</strong> {s.motivo || "-"}
              </p>

              {s.observacao_adm && (
                <p style={styles.paragrafo}>
                  <strong>Observação de quem confirmou:</strong> {s.observacao_adm}
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
    borderLeft: "6px solid #0ea5e9",
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
  input: {
    width: "100%",
    padding: "10px",
    borderRadius: "8px",
    border: "1px solid #ccc",
    boxSizing: "border-box",
    fontFamily: "Arial, sans-serif",
  },
  textarea: {
    width: "100%",
    minHeight: "80px",
    padding: "10px",
    borderRadius: "8px",
    border: "1px solid #ccc",
    resize: "vertical",
    boxSizing: "border-box",
    fontFamily: "Arial, sans-serif",
  },
  botao: {
    marginTop: "16px",
    background: "#0ea5e9",
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
