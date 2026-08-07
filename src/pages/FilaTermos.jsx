import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { Carregando } from "../ui/estados";
import { urlTermo } from "../utils/documentoFinanceiro";

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

// Motivos padronizados de rejeição (não havia lista oficial no sistema).
const MOTIVOS_REJEICAO = [
  "Assinatura ausente",
  "Arquivo ilegível",
  "Documento incompleto",
  "Assinatura divergente",
  "Termo incorreto",
  "Outro",
];

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

// CPF parcial: só os 3 primeiros e 2 últimos dígitos (evita expor completo).
function cpfParcial(cpf) {
  if (!cpf) return "Não informado";
  const d = String(cpf).replace(/\D/g, "");
  if (d.length < 5) return "***";
  return `${d.slice(0, 3)}.***.***-${d.slice(-2)}`;
}

function extensaoDe(nome) {
  if (!nome) return "";
  const m = String(nome).toLowerCase().match(/\.([a-z0-9]+)(?:\?.*)?$/);
  return m ? m[1] : "";
}

function corStatus(status) {
  if (status === "TERMO_RECEBIDO_LIBERADO") {
    return { background: "#d1e7dd", color: "#0f5132", border: "1px solid #badbcc" };
  }
  if (status === "TERMO_REJEITADO") {
    return { background: "#f8d7da", color: "#842029", border: "1px solid #f5c2c7" };
  }
  if (status === "TERMO_LIBERADO_AUTOMATICO_GOV") {
    return { background: "#e0cffc", color: "#4b1e8f", border: "1px solid #d0bcf5" };
  }
  return { background: "#cff4fc", color: "#055160", border: "1px solid #b6effb" };
}

function mensagemErro(erro) {
  switch (erro) {
    case "acesso_negado":
      return "Seu usuário não tem permissão para validar assinatura.";
    case "motivo_obrigatorio":
      return "Informe o motivo da rejeição.";
    case "status_invalido":
      return "Este termo já foi processado por outro usuário. A fila será atualizada.";
    case "termo_nao_encontrado":
      return "Termo não encontrado. A fila será atualizada.";
    case "decisao_invalida":
      return "Ação inválida.";
    default:
      return "Não foi possível concluir a ação. Tente novamente.";
  }
}

export default function FilaAdmTermos() {
  const [usuario, setUsuario] = useState(null);
  const [termos, setTermos] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [filtro, setFiltro] = useState("PENDENTES");

  // --- Estado do modal de validação em tela única ---
  const [modalTermo, setModalTermo] = useState(null);
  const [previewCampo, setPreviewCampo] = useState("arquivo");
  const [previewUrl, setPreviewUrl] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewErro, setPreviewErro] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [obs, setObs] = useState("");
  const [motivoSel, setMotivoSel] = useState("");
  const [motivoTxt, setMotivoTxt] = useState("");
  const [salvando, setSalvando] = useState(false);

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

  // --- Preview embutido (URL assinada de curta duração; nunca window.open) ---
  async function carregarPreview(termo, campo) {
    setPreviewCampo(campo);
    setPreviewLoading(true);
    setPreviewErro(false);
    setPreviewUrl(null);
    setZoom(1);
    const url = await urlTermo(termo.id, campo);
    if (!url) {
      setPreviewErro(true);
      setPreviewLoading(false);
      return;
    }
    setPreviewUrl(url);
    setPreviewLoading(false);
  }

  function abrirValidacao(termo) {
    setModalTermo(termo);
    setObs("");
    setMotivoSel("");
    setMotivoTxt("");
    carregarPreview(termo, "arquivo");
  }

  async function abrirValidacaoPorId(id) {
    const { data } = await supabase
      .from("termos_acordo")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (data) abrirValidacao(data);
    else fecharModal();
  }

  function fecharModal() {
    setModalTermo(null);
    setPreviewUrl(null);
    setPreviewErro(false);
    setPreviewLoading(false);
  }

  function motivoFinal() {
    if (!motivoSel) return "";
    if (motivoSel === "Outro") return motivoTxt.trim();
    const compl = motivoTxt.trim();
    return compl ? `${motivoSel} — ${compl}` : motivoSel;
  }

  async function decidir(decisao, abrirProximo = false) {
    if (!modalTermo || salvando) return;

    let motivo = null;
    if (decisao === "REJEITAR") {
      motivo = motivoFinal();
      if (!motivo) {
        alert("Selecione o motivo da rejeição (e detalhe, se 'Outro').");
        return;
      }
    }

    const okConfirm = window.confirm(
      decisao === "APROVAR"
        ? "Confirmar: assinatura validada e termo liberado para operação?"
        : "Confirmar rejeição da assinatura e devolução ao operador?"
    );
    if (!okConfirm) return;

    setSalvando(true);
    const { data, error } = await supabase.rpc("validar_assinatura_termo", {
      p_termo_id: modalTermo.id,
      p_decisao: decisao,
      p_observacao: decisao === "APROVAR" ? obs.trim() || null : null,
      p_motivo: motivo,
      p_abrir_proximo: abrirProximo,
    });
    setSalvando(false);

    if (error) {
      alert("Erro ao processar: " + error.message);
      return;
    }
    if (!data?.ok) {
      alert(mensagemErro(data?.erro));
      if (data?.erro === "status_invalido" || data?.erro === "termo_nao_encontrado") {
        await carregarTermos();
        fecharModal();
      }
      return;
    }

    await carregarTermos();
    const proximo = data.proximo && data.proximo.id ? data.proximo : null;
    if (abrirProximo && proximo) {
      abrirValidacaoPorId(proximo.id);
    } else {
      fecharModal();
    }
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
    if (filtro === "PENDENTES") return termos.filter((t) => t.status === "TERMO_ENVIADO_ADM");
    if (filtro === "LIBERADOS") return termos.filter((t) => t.status === "TERMO_RECEBIDO_LIBERADO");
    if (filtro === "REJEITADOS") return termos.filter((t) => t.status === "TERMO_REJEITADO");
    if (filtro === "AUDITORIA") return termos.filter((t) => t.status === "TERMO_LIBERADO_AUTOMATICO_GOV");
    return termos;
  }, [termos, filtro]);

  if (carregando) {
    return <div style={styles.container}><Carregando texto="Carregando fila ADM…" /></div>;
  }

  if (!podeValidar) {
    return (
      <div style={styles.container}>
        <h1 style={styles.titulo}>Fila ADM de Termos</h1>
        <div style={styles.alerta}>Seu usuário não tem permissão para validar termos.</div>
        <p>
          Usuário logado: <strong>{emailUsuario || "Não identificado"}</strong>
        </p>
        <p style={styles.texto}>Usuários autorizados: Fernanda, Amanda ADM e Amanda gestora.</p>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.cabecalho}>
        <div>
          <h1 style={styles.titulo}>Fila ADM de Termos</h1>
          <p style={styles.subtitulo}>Validação dos termos de acordo enviados pela operação.</p>
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
        {["PENDENTES", "LIBERADOS", "REJEITADOS", "AUDITORIA", "TODOS"].map((f) => (
          <button
            key={f}
            style={filtro === f ? styles.filtroAtivo : styles.filtro}
            onClick={() => setFiltro(f)}
          >
            {f === "AUDITORIA" ? "Auditoria (gov.br)" : f.charAt(0) + f.slice(1).toLowerCase()}
          </button>
        ))}
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
                  <strong>CPF:</strong> {cpfParcial(termo.aluno_cpf)}
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
              <p style={styles.paragrafo}>{termo.observacao_operador || "Sem observação."}</p>
            </div>

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

            <div style={styles.acoes}>
              {pendente ? (
                <button style={styles.botaoValidar} onClick={() => abrirValidacao(termo)}>
                  Validar assinatura
                </button>
              ) : (
                termo.arquivo_url && (
                  <button style={styles.botaoVer} onClick={() => abrirValidacao(termo)}>
                    Ver documento
                  </button>
                )
              )}
            </div>
          </div>
        );
      })}

      {modalTermo && (
        <ModalValidacao
          termo={modalTermo}
          previewCampo={previewCampo}
          previewUrl={previewUrl}
          previewLoading={previewLoading}
          previewErro={previewErro}
          zoom={zoom}
          setZoom={setZoom}
          trocarCampo={(campo) => carregarPreview(modalTermo, campo)}
          recarregarPreview={() => carregarPreview(modalTermo, previewCampo)}
          obs={obs}
          setObs={setObs}
          motivoSel={motivoSel}
          setMotivoSel={setMotivoSel}
          motivoTxt={motivoTxt}
          setMotivoTxt={setMotivoTxt}
          salvando={salvando}
          onFechar={fecharModal}
          onDecidir={decidir}
        />
      )}
    </div>
  );
}

function ModalValidacao(props) {
  const {
    termo, previewCampo, previewUrl, previewLoading, previewErro, zoom, setZoom,
    trocarCampo, recarregarPreview, obs, setObs, motivoSel, setMotivoSel,
    motivoTxt, setMotivoTxt, salvando, onFechar, onDecidir,
  } = props;

  const pendente = termo.status === "TERMO_ENVIADO_ADM";
  const podeDecidir = pendente && !!previewUrl && !previewLoading; // sem doc -> só rejeição

  const nomeCampo =
    previewCampo === "rg" ? termo.arquivo_rg_nome
      : previewCampo === "verso" ? termo.arquivo_verso_nome
      : termo.arquivo_nome;
  const ext = extensaoDe(nomeCampo) || extensaoDe(previewUrl);
  const ehImagem = ["png", "jpg", "jpeg", "gif", "webp"].includes(ext);

  const campos = [
    { chave: "arquivo", rotulo: "Termo", tem: !!termo.arquivo_url },
    { chave: "rg", rotulo: "RG", tem: !!termo.arquivo_rg_url },
    { chave: "verso", rotulo: "Verso", tem: !!termo.arquivo_verso_url },
  ].filter((c) => c.tem);

  return (
    <div style={styles.overlay} onClick={onFechar}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        {/* LADO ESQUERDO: documento */}
        <div style={styles.painelDoc}>
          <div style={styles.docToolbar}>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {campos.map((c) => (
                <button
                  key={c.chave}
                  onClick={() => trocarCampo(c.chave)}
                  style={previewCampo === c.chave ? styles.abaAtiva : styles.aba}
                >
                  {c.rotulo}
                </button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <button style={styles.zoomBtn} onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))}>
                −
              </button>
              <span style={{ fontSize: 12, minWidth: 42, textAlign: "center" }}>
                {Math.round(zoom * 100)}%
              </span>
              <button style={styles.zoomBtn} onClick={() => setZoom((z) => Math.min(3, +(z + 0.25).toFixed(2)))}>
                +
              </button>
            </div>
          </div>

          <div style={styles.docViewport}>
            {previewLoading && <div style={styles.docEstado}>Carregando documento...</div>}
            {previewErro && !previewLoading && (
              <div style={styles.docEstado}>
                Documento indisponível.
                <br />
                <button style={styles.botaoVer} onClick={recarregarPreview}>
                  Tentar novamente
                </button>
              </div>
            )}
            {!previewLoading && !previewErro && previewUrl && (
              <div
                style={{
                  transform: `scale(${zoom})`,
                  transformOrigin: "top center",
                  width: "100%",
                  height: ehImagem ? "auto" : "100%",
                }}
              >
                {ehImagem ? (
                  <img src={previewUrl} alt="Documento assinado" style={styles.docImg} />
                ) : (
                  <iframe src={previewUrl} title="Documento assinado" style={styles.docIframe} />
                )}
              </div>
            )}
            {!previewLoading && !previewErro && !previewUrl && (
              <div style={styles.docEstado}>Este termo foi enviado sem anexo localizado.</div>
            )}
          </div>
        </div>

        {/* LADO DIREITO: validação */}
        <div style={styles.painelValidacao}>
          <div style={styles.validacaoTopo}>
            <h2 style={{ margin: 0, fontSize: 18 }}>{termo.aluno_nome || "Aluno sem nome"}</h2>
            <button style={styles.fechar} onClick={onFechar}>
              ✕
            </button>
          </div>

          <span style={{ ...styles.status, ...corStatus(termo.status), alignSelf: "flex-start" }}>
            {traduzStatus(termo.status)}
          </span>

          <div style={styles.validacaoDados}>
            <p style={styles.info}>
              <strong>CPF:</strong> {cpfParcial(termo.aluno_cpf)}
            </p>
            <p style={styles.info}>
              <strong>Operador:</strong> {termo.operador_nome || termo.operador_email || "-"}
            </p>
            <p style={styles.info}>
              <strong>Enviado em:</strong> {formatarData(termo.criado_em)}
            </p>
            <p style={styles.info}>
              <strong>Assinatura:</strong>{" "}
              {termo.tipo_assinatura === "GOV_BR" ? "Gov.br (eletrônica)" : "Manual + RG"}
            </p>
            {termo.observacao_operador && (
              <p style={styles.info}>
                <strong>Obs. operação:</strong> {termo.observacao_operador}
              </p>
            )}
          </div>

          {pendente ? (
            <div style={styles.validacaoAcoes}>
              <label style={styles.label}>Observação (aprovação)</label>
              <textarea
                style={styles.textarea}
                placeholder="Ex.: termo conferido, dados compatíveis."
                value={obs}
                onChange={(e) => setObs(e.target.value)}
              />

              <label style={{ ...styles.label, marginTop: 12 }}>Motivo (rejeição)</label>
              <select
                style={styles.select}
                value={motivoSel}
                onChange={(e) => setMotivoSel(e.target.value)}
              >
                <option value="">Selecione o motivo...</option>
                {MOTIVOS_REJEICAO.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <textarea
                style={{ ...styles.textarea, marginTop: 8 }}
                placeholder={
                  motivoSel === "Outro"
                    ? "Descreva o motivo (obrigatório para 'Outro')."
                    : "Observação complementar (opcional)."
                }
                value={motivoTxt}
                onChange={(e) => setMotivoTxt(e.target.value)}
              />

              <div style={styles.botoesDecisao}>
                <button
                  style={{ ...styles.botaoAprovar, opacity: podeDecidir && !salvando ? 1 : 0.6 }}
                  disabled={!podeDecidir || salvando}
                  onClick={() => onDecidir("APROVAR", false)}
                >
                  {salvando ? "Processando..." : "Assinatura validada"}
                </button>
                <button
                  style={{ ...styles.botaoRejeitar, opacity: salvando ? 0.6 : 1 }}
                  disabled={salvando}
                  onClick={() => onDecidir("REJEITAR", false)}
                >
                  Rejeitar assinatura
                </button>
              </div>
              <button
                style={{ ...styles.botaoProximo, opacity: podeDecidir && !salvando ? 1 : 0.6 }}
                disabled={!podeDecidir || salvando}
                onClick={() => onDecidir("APROVAR", true)}
              >
                Validar e abrir próximo
              </button>
              {!previewUrl && !previewLoading && (
                <p style={{ color: "#b45309", fontSize: 13, marginTop: 8 }}>
                  Sem documento carregado: aprovação bloqueada. É possível rejeitar por arquivo
                  ilegível/ausente.
                </p>
              )}
            </div>
          ) : (
            <div style={styles.blocoRetorno}>
              <strong>Termo já processado.</strong>
              {termo.observacao_adm && <p style={styles.paragrafo}>{termo.observacao_adm}</p>}
              <p style={styles.info}>
                <strong>Validado por:</strong> {termo.validado_por || "-"}
              </p>
              <p style={styles.info}>
                <strong>Validado em:</strong> {formatarData(termo.validado_em)}
              </p>
            </div>
          )}
        </div>
      </div>
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
  titulo: { margin: 0, marginBottom: "6px", color: "#111827" },
  subtitulo: { color: "#555", margin: 0 },
  texto: { color: "#555" },
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
  numero: { display: "block", fontSize: "28px", fontWeight: "bold", color: "#111827" },
  descricao: { display: "block", color: "#6b7280", marginTop: "4px" },
  filtros: { display: "flex", flexWrap: "wrap", gap: "8px", marginBottom: "18px" },
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
  vazio: { background: "#fff", padding: "18px", borderRadius: "10px" },
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
  nome: { margin: "0 0 8px 0", color: "#111827" },
  info: { margin: "5px 0", color: "#555" },
  status: {
    padding: "8px 12px",
    borderRadius: "999px",
    fontWeight: "bold",
    fontSize: "13px",
    whiteSpace: "nowrap",
  },
  bloco: { marginTop: "14px" },
  blocoRetorno: {
    marginTop: "14px",
    background: "#f8fafc",
    border: "1px solid #e5e7eb",
    borderRadius: "10px",
    padding: "12px",
  },
  paragrafo: { color: "#374151", lineHeight: 1.4, margin: "8px 0" },
  label: { display: "block", fontWeight: "bold", marginBottom: "6px", color: "#111827" },
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
  select: {
    width: "100%",
    padding: "10px",
    borderRadius: "8px",
    border: "1px solid #ccc",
    boxSizing: "border-box",
    fontFamily: "Arial, sans-serif",
    background: "#fff",
  },
  acoes: { display: "flex", flexWrap: "wrap", gap: "10px", marginTop: "16px" },
  botaoValidar: {
    background: "#0d6efd",
    color: "#fff",
    border: "none",
    padding: "12px 18px",
    borderRadius: "8px",
    cursor: "pointer",
    fontWeight: "bold",
  },
  botaoVer: {
    background: "#fff",
    color: "#0d6efd",
    border: "1px solid #0d6efd",
    padding: "10px 16px",
    borderRadius: "8px",
    cursor: "pointer",
    fontWeight: "bold",
  },
  botaoAprovar: {
    flex: 1,
    background: "#198754",
    color: "#fff",
    border: "none",
    padding: "12px 16px",
    borderRadius: "8px",
    cursor: "pointer",
    fontWeight: "bold",
  },
  botaoRejeitar: {
    flex: 1,
    background: "#dc3545",
    color: "#fff",
    border: "none",
    padding: "12px 16px",
    borderRadius: "8px",
    cursor: "pointer",
    fontWeight: "bold",
  },
  botaoProximo: {
    marginTop: 10,
    width: "100%",
    background: "#111827",
    color: "#fff",
    border: "none",
    padding: "11px 16px",
    borderRadius: "8px",
    cursor: "pointer",
    fontWeight: "bold",
  },
  // --- Modal tela única ---
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.55)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
    padding: "2vh 2vw",
  },
  modal: {
    background: "#fff",
    borderRadius: "14px",
    width: "100%",
    maxWidth: "1280px",
    height: "96vh",
    display: "flex",
    overflow: "hidden",
    boxShadow: "0 10px 40px rgba(0,0,0,0.35)",
  },
  painelDoc: {
    flex: "1 1 62%",
    display: "flex",
    flexDirection: "column",
    background: "#3a3f45",
    minWidth: 0,
  },
  docToolbar: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
    padding: "10px 12px",
    background: "#2b2f34",
    color: "#fff",
  },
  aba: {
    background: "transparent",
    color: "#cbd5e1",
    border: "1px solid #4b5563",
    padding: "6px 12px",
    borderRadius: "6px",
    cursor: "pointer",
    fontWeight: "bold",
    fontSize: 13,
  },
  abaAtiva: {
    background: "#0d6efd",
    color: "#fff",
    border: "1px solid #0d6efd",
    padding: "6px 12px",
    borderRadius: "6px",
    cursor: "pointer",
    fontWeight: "bold",
    fontSize: 13,
  },
  zoomBtn: {
    background: "#fff",
    color: "#111827",
    border: "none",
    width: 30,
    height: 30,
    borderRadius: "6px",
    cursor: "pointer",
    fontWeight: "bold",
    fontSize: 16,
  },
  docViewport: {
    flex: 1,
    overflow: "auto",
    display: "flex",
    justifyContent: "center",
    alignItems: "flex-start",
    padding: 12,
  },
  docIframe: { width: "100%", height: "100%", minHeight: "70vh", border: "none", background: "#fff" },
  docImg: { width: "100%", height: "auto", display: "block", background: "#fff" },
  docEstado: {
    color: "#e5e7eb",
    textAlign: "center",
    margin: "auto",
    fontSize: 15,
    lineHeight: 1.8,
  },
  painelValidacao: {
    flex: "1 1 38%",
    display: "flex",
    flexDirection: "column",
    padding: "18px",
    gap: 10,
    overflowY: "auto",
    minWidth: 320,
  },
  validacaoTopo: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
  },
  fechar: {
    background: "#f3f4f6",
    border: "none",
    width: 34,
    height: 34,
    borderRadius: "8px",
    cursor: "pointer",
    fontSize: 16,
    fontWeight: "bold",
  },
  validacaoDados: {
    background: "#f8fafc",
    border: "1px solid #e5e7eb",
    borderRadius: "10px",
    padding: "12px",
  },
  validacaoAcoes: { display: "flex", flexDirection: "column" },
  botoesDecisao: { display: "flex", gap: 10, marginTop: 16 },
};
