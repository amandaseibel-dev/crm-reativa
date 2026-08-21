import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { nomeOperadorPorEmail } from "../utils/operadores";
import { enviarTermo } from "../utils/documentoFinanceiro";

const STATUS_LABEL = {
  TERMO_ENVIADO_ADM: "Termo enviado ADM",
  TERMO_RECEBIDO_LIBERADO: "Termo recebido - liberado",
  TERMO_REJEITADO: "Termo rejeitado",
  TERMO_LIBERADO_AUTOMATICO_GOV: "Liberado automático (gov.br)",
};

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
    aluno?.Nome ||
    "-"
  );
}

function pegarCpfAluno(aluno) {
  return aluno?.cpf || aluno?.CPF || aluno?.cpf_mascarado || "-";
}

function traduzirStatus(status) {
  return STATUS_LABEL[status] || status || "-";
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

// onEnviado avisa a ficha que nasceu uma acao que ainda da para desfazer --
// sem isso a faixa "Da para desfazer" so apareceria no proximo reload.
export default function FinalizacaoTermo({ aluno, onEnviado }) {
  const [usuario, setUsuario] = useState(null);
  const [observacao, setObservacao] = useState("");
  const [arquivo, setArquivo] = useState(null);
  const [arquivoRg, setArquivoRg] = useState(null);
  const [arquivoVerso, setArquivoVerso] = useState(null);
  const [tipoAssinatura, setTipoAssinatura] = useState("MANUAL_RG");
  const [enviando, setEnviando] = useState(false);
  const [carregando, setCarregando] = useState(false);
  const [termos, setTermos] = useState([]);
  const [avisoGovAberto, setAvisoGovAberto] = useState(false);

  const alunoId = aluno?.id ? String(aluno.id) : "";

  useEffect(() => {
    carregarUsuario();
  }, []);

  useEffect(() => {
    if (alunoId) {
      carregarTermosDoAluno();
    }
  }, [alunoId]);

  async function carregarUsuario() {
    const { data } = await supabase.auth.getUser();
    setUsuario(data?.user || null);
  }

  async function carregarTermosDoAluno() {
    if (!alunoId) return;

    setCarregando(true);

    const { data, error } = await supabase
      .from("termos_acordo")
      .select("*")
      .eq("aluno_id", alunoId)
      .order("criado_em", { ascending: false });

    if (error) {
      console.error("Erro ao carregar termos:", error);
      setCarregando(false);
      return;
    }

    setTermos(data || []);
    setCarregando(false);
  }

  const ultimoTermo = useMemo(() => {
    if (!termos || termos.length === 0) return null;
    return termos[0];
  }, [termos]);

  const temTermoPendente = useMemo(() => {
    return termos.some((termo) => termo.status === "TERMO_ENVIADO_ADM");
  }, [termos]);

  async function atualizarStatusAluno(novoStatus) {
    if (!aluno?.id) return;

    // Mesmo código padrão (maiúsculo, sem espaço) usado no resto do sistema
    // (ex.: fila ADM de termos) -- senão o caso muda de status mas some das
    // filas que dependem desse valor pra filtrar.
    const { error } = await supabase
      .from("alunos")
      .update({
        status_jornada: novoStatus,
        status_atual: novoStatus,
        status_acionamento: novoStatus,
        data_ultimo_acionamento: new Date().toISOString(),
      })
      .eq("id", aluno.id);

    if (error) {
      console.error("Erro ao atualizar status do aluno:", error);
    }
  }

  async function enviarTermoAdm() {
    if (!aluno?.id) {
      alert("Aluno não localizado.");
      return;
    }

    if (temTermoPendente) {
      alert(
        "Este aluno já possui um termo pendente na fila da Fernanda/Amanda. Aguarde a validação antes de enviar outro."
      );
      return;
    }

    if (!observacao.trim()) {
      alert("Informe uma observação para enviar o termo ao ADM.");
      return;
    }

    // gov.br já é validado eletronicamente pelo governo: libera na hora,
    // não exige anexo do termo nem envio para conferência do ADM.
    const ehGovBr = tipoAssinatura === "GOV_BR";

    if (!ehGovBr && !arquivo) {
      alert("Anexe o termo de acordo antes de enviar para ADM.");
      return;
    }

    // RG só é obrigatório na assinatura manual -- gov.br já valida a
    // identidade eletronicamente, não precisa do documento em foto.
    if (tipoAssinatura === "MANUAL_RG" && !arquivoRg) {
      alert("Anexe o RG (documento de identidade) junto com o termo assinado.");
      return;
    }

    setEnviando(true);

    const { data: userData } = await supabase.auth.getUser();
    const usuarioLogado = userData?.user;
    const emailOperador = usuarioLogado?.email || "";
    const nomeOperador = nomeOperadorPorEmail(emailOperador);

    // Nomes dos arquivos (campo de exibicao; nao entram no caminho). Os arquivos
    // sobem DEPOIS de criar a linha do termo, via upload autorizado pelo servidor
    // (vinculo pelo termo_id + campo). Bucket/caminho/UUID resolvidos no servidor.
    const arquivoNome = arquivo ? arquivo.name : null;
    const arquivoRgNome = arquivoRg ? arquivoRg.name : null;
    const arquivoVersoNome = arquivoVerso ? arquivoVerso.name : null;

    // Assinatura via gov.br ja vem validada eletronicamente; libera na hora.
    // Manual + RG precisa de conferencia humana antes de liberar.
    const statusInicial = ehGovBr
      ? "TERMO_LIBERADO_AUTOMATICO_GOV"
      : "TERMO_ENVIADO_ADM";

    const { data: termoCriado, error } = await supabase
      .from("termos_acordo")
      .insert({
        aluno_id: String(aluno.id),
        aluno_nome: pegarNomeAluno(aluno),
        aluno_cpf: pegarCpfAluno(aluno),
        operador_email: emailOperador,
        operador_nome: nomeOperador,
        observacao_operador: observacao,
        arquivo_nome: arquivoNome,
        arquivo_url: null,
        arquivo_rg_nome: arquivoRgNome,
        arquivo_rg_url: null,
        arquivo_verso_nome: arquivoVersoNome,
        arquivo_verso_url: null,
        tipo_assinatura: tipoAssinatura,
        status: statusInicial,
        ...(ehGovBr
          ? { validado_por: "AUTOMATICO_GOV_BR", validado_em: new Date().toISOString() }
          : {}),
      })
      .select("id")
      .single();

    if (error) {
      alert("Erro ao enviar termo para ADM: " + error.message);
      setEnviando(false);
      return;
    }

    // Uploads autorizados pelo servidor, vinculados ao termo recem-criado.
    const termoId = termoCriado?.id;
    const anexos = [
      [arquivo, "arquivo", "termo"],
      [arquivoRg, "rg", "RG"],
      [arquivoVerso, "verso", "verso do termo"],
    ];
    for (const [file, campo, rotulo] of anexos) {
      if (!file || !termoId) continue;
      const r = await enviarTermo(termoId, campo, file);
      if (!r.ok) {
        alert("Termo registrado, mas nao foi possivel anexar o " + rotulo + ". Reenvie o anexo na fila de termos.");
        setEnviando(false);
        return;
      }
    }

    await atualizarStatusAluno(statusInicial);

    if (ehGovBr) {
      // Documento enviado via gov.br: a área ADM ainda precisa validar a
      // assinatura. Avisa o operador para NÃO liberar o boleto/link até lá.
      setAvisoGovAberto(true);
    } else {
      alert("Termo enviado para fila ADM da Fernanda/Amanda.");
    }

    setObservacao("");
    setArquivo(null);
    setArquivoRg(null);
    setArquivoVerso(null);
    setTipoAssinatura("MANUAL_RG");
    setEnviando(false);
    carregarTermosDoAluno();
    if (onEnviado) onEnviado();
  }

  return (
    <div style={styles.card}>
      <div style={styles.header}>
        <div>
          <h2 style={styles.titulo}>Finalização — Termo de Acordo</h2>
          <p style={styles.texto}>
            Área usada pela operação para enviar o termo de acordo para validação da Fernanda/Amanda ADM.
          </p>
        </div>

        {ultimoTermo && (
          <span style={{ ...styles.status, ...corStatus(ultimoTermo.status) }}>
            {traduzirStatus(ultimoTermo.status)}
          </span>
        )}
      </div>

      {ultimoTermo && (
        <div style={styles.resumo}>
          <strong>Última movimentação do termo</strong>

          <div style={styles.gridResumo}>
            <div>
              <span style={styles.labelResumo}>Status</span>
              <p style={styles.valorResumo}>{traduzirStatus(ultimoTermo.status)}</p>
            </div>

            <div>
              <span style={styles.labelResumo}>Enviado em</span>
              <p style={styles.valorResumo}>{formatarData(ultimoTermo.criado_em)}</p>
            </div>

            <div>
              <span style={styles.labelResumo}>Operador</span>
              <p style={styles.valorResumo}>
                {ultimoTermo.operador_nome || ultimoTermo.operador_email || "-"}
              </p>
            </div>

            <div>
              <span style={styles.labelResumo}>Validado por</span>
              <p style={styles.valorResumo}>{ultimoTermo.validado_por || "-"}</p>
            </div>
          </div>

          {ultimoTermo.observacao_adm && (
            <div style={styles.caixaAdm}>
              <strong>Retorno da ADM:</strong>
              <p style={styles.paragrafo}>{ultimoTermo.observacao_adm}</p>
            </div>
          )}

          {ultimoTermo.arquivo_url && (
            <a
              href={ultimoTermo.arquivo_url}
              target="_blank"
              rel="noreferrer"
              style={styles.linkArquivo}
            >
              Abrir último termo anexado
            </a>
          )}

          {ultimoTermo.arquivo_rg_url && (
            <a
              href={ultimoTermo.arquivo_rg_url}
              target="_blank"
              rel="noreferrer"
              style={{ ...styles.linkArquivo, marginLeft: 12 }}
            >
              Abrir RG anexado
            </a>
          )}

          {ultimoTermo.arquivo_verso_url && (
            <a
              href={ultimoTermo.arquivo_verso_url}
              target="_blank"
              rel="noreferrer"
              style={{ ...styles.linkArquivo, marginLeft: 12 }}
            >
              Abrir verso do termo
            </a>
          )}
        </div>
      )}

      {temTermoPendente && (
        <div style={styles.alertaPendente}>
          Este aluno já está na fila ADM com status <strong>Termo enviado ADM</strong>.
          Aguarde a Fernanda/Amanda aprovar ou rejeitar antes de enviar outro termo.
        </div>
      )}

      {!temTermoPendente && (
        <>
          <div style={styles.bloco}>
            <label style={styles.label}>Observação da operação</label>
            <textarea
              style={styles.textarea}
              placeholder="Exemplo: aluno aceitou a proposta, termo conferido pela operação e anexado para validação ADM."
              value={observacao}
              onChange={(e) => setObservacao(e.target.value)}
            />
          </div>

          <div style={styles.bloco}>
            <label style={styles.label}>Tipo de assinatura</label>
            <select
              style={styles.select}
              value={tipoAssinatura}
              onChange={(e) => setTipoAssinatura(e.target.value)}
            >
              <option value="MANUAL_RG">Assinatura manual + RG</option>
              <option value="GOV_BR">Assinatura via gov.br</option>
            </select>
            <p style={styles.dicaTipo}>
              {tipoAssinatura === "GOV_BR"
                ? "Assinatura gov.br já é validada eletronicamente: o termo é liberado na hora e só entra na fila de auditoria do ADM."
                : "Assinatura manual + RG precisa de conferência da Fernanda/Amanda ADM antes de liberar."}
            </p>
          </div>

          <div style={styles.bloco}>
            <label style={styles.label}>
              Anexar termo assinado{tipoAssinatura === "GOV_BR" ? " (opcional)" : ""}
            </label>
            <input
              type="file"
              accept=".pdf,.png,.jpg,.jpeg,.doc,.docx"
              onChange={(e) => setArquivo(e.target.files?.[0] || null)}
            />

            {arquivo && (
              <p style={styles.arquivoSelecionado}>
                Arquivo selecionado: <strong>{arquivo.name}</strong>
              </p>
            )}
          </div>

          <div style={styles.bloco}>
            <label style={styles.label}>Anexar verso do termo (opcional)</label>
            <input
              type="file"
              accept=".pdf,.png,.jpg,.jpeg,.doc,.docx"
              onChange={(e) => setArquivoVerso(e.target.files?.[0] || null)}
            />

            {arquivoVerso && (
              <p style={styles.arquivoSelecionado}>
                Arquivo selecionado: <strong>{arquivoVerso.name}</strong>
              </p>
            )}
          </div>

          {tipoAssinatura === "MANUAL_RG" && (
            <div style={styles.bloco}>
              <label style={styles.label}>Anexar RG (documento de identidade)</label>
              <input
                type="file"
                accept=".pdf,.png,.jpg,.jpeg"
                onChange={(e) => setArquivoRg(e.target.files?.[0] || null)}
              />

              {arquivoRg && (
                <p style={styles.arquivoSelecionado}>
                  Arquivo selecionado: <strong>{arquivoRg.name}</strong>
                </p>
              )}
            </div>
          )}

          <button
            style={{
              ...styles.botao,
              opacity: enviando ? 0.7 : 1,
              cursor: enviando ? "not-allowed" : "pointer",
            }}
            onClick={enviarTermoAdm}
            disabled={enviando}
          >
            {enviando
              ? "Enviando..."
              : tipoAssinatura === "GOV_BR"
              ? "Enviar (gov.br) para auditoria"
              : "Enviar termo para ADM"}
          </button>
        </>
      )}

      <div style={styles.historico}>
        <h3 style={styles.subtitulo}>Histórico de termos deste aluno</h3>

        {carregando && <p style={styles.texto}>Carregando histórico de termos...</p>}

        {!carregando && termos.length === 0 && (
          <p style={styles.texto}>Nenhum termo enviado para este aluno ainda.</p>
        )}

        {!carregando &&
          termos.map((termo) => (
            <div key={termo.id} style={styles.itemHistorico}>
              <div style={styles.linhaHistorico}>
                <strong>{traduzirStatus(termo.status)}</strong>
                <span style={styles.dataHistorico}>{formatarData(termo.criado_em)}</span>
              </div>

              <p style={styles.paragrafo}>
                <strong>Operador:</strong>{" "}
                {termo.operador_nome || termo.operador_email || "-"}
              </p>

              <p style={styles.paragrafo}>
                <strong>Observação operação:</strong>{" "}
                {termo.observacao_operador || "-"}
              </p>

              {termo.observacao_adm && (
                <p style={styles.paragrafo}>
                  <strong>Observação ADM:</strong> {termo.observacao_adm}
                </p>
              )}

              {termo.arquivo_url && (
                <a
                  href={termo.arquivo_url}
                  target="_blank"
                  rel="noreferrer"
                  style={styles.linkPequeno}
                >
                  Abrir anexo
                </a>
              )}
            </div>
          ))}
      </div>

      {avisoGovAberto && (
        <div style={styles.overlay} onClick={() => setAvisoGovAberto(false)}>
          <div style={styles.modalBox} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalIcone}>⚠️</div>
            <h3 style={styles.modalTitulo}>Não libere o boleto ainda</h3>
            <p style={styles.modalTexto}>
              O documento foi enviado via <strong>gov.br</strong>. A área ADM
              ainda precisa <strong>validar a assinatura</strong> antes da
              liberação.
            </p>
            <p style={styles.modalTexto}>
              <strong>Aguarde a validação da assinatura</strong> pela ADM antes
              de gerar ou enviar o boleto/link de pagamento ao aluno.
            </p>
            <p style={styles.modalTexto}>
              Você receberá uma <strong>notificação</strong> assim que a ADM
              validar o documento e liberar o acordo.
            </p>
            <button
              style={styles.modalBotao}
              onClick={() => setAvisoGovAberto(false)}
            >
              Entendi
            </button>
          </div>
        </div>
      )}
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
    borderLeft: "6px solid #0d6efd",
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
  select: {
    width: "100%",
    padding: "10px",
    borderRadius: "8px",
    border: "1px solid #ccc",
    boxSizing: "border-box",
    fontFamily: "Arial, sans-serif",
    fontSize: "14px",
  },
  dicaTipo: {
    marginTop: "8px",
    color: "#6b7280",
    fontSize: "13px",
    lineHeight: 1.4,
  },
  arquivoSelecionado: {
    marginTop: "8px",
    color: "#374151",
  },
  botao: {
    marginTop: "16px",
    background: "#0d6efd",
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
  linkArquivo: {
    display: "inline-block",
    marginTop: "12px",
    color: "#0d6efd",
    fontWeight: "bold",
  },
  linkPequeno: {
    display: "inline-block",
    marginTop: "6px",
    color: "#0d6efd",
    fontWeight: "bold",
    fontSize: "14px",
  },
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(2,6,23,0.55)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 9999,
    padding: "16px",
  },
  modalBox: {
    background: "#fff",
    borderRadius: "14px",
    padding: "24px",
    maxWidth: "440px",
    width: "100%",
    boxShadow: "0 12px 40px rgba(0,0,0,0.28)",
    borderTop: "6px solid #f59e0b",
    textAlign: "center",
  },
  modalIcone: {
    fontSize: "40px",
    lineHeight: 1,
    marginBottom: "8px",
  },
  modalTitulo: {
    margin: "0 0 12px",
    color: "#92400e",
    fontSize: "20px",
  },
  modalTexto: {
    margin: "0 0 12px",
    color: "#374151",
    lineHeight: 1.5,
    fontSize: "15px",
  },
  modalBotao: {
    marginTop: "8px",
    background: "#f59e0b",
    color: "#111827",
    border: "none",
    padding: "12px 22px",
    borderRadius: "8px",
    cursor: "pointer",
    fontWeight: "bold",
    fontSize: "15px",
  },
};
