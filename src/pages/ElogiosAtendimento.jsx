import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

function formatarDataHora(iso) {
  if (!iso) return "-";
  try {
    return new Date(iso).toLocaleString("pt-BR");
  } catch {
    return "-";
  }
}

function hojeISO() {
  return new Date().toISOString().slice(0, 10);
}

function maisDias(dataISO, dias) {
  const d = new Date(dataISO + "T00:00:00");
  d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0, 10);
}

const STATUS_LABEL = {
  PENDENTE_ANALISE: { texto: "Aguardando análise", cor: "#b45309", bg: "#fffbeb", borda: "#fde68a" },
  APROVADO_TV: { texto: "Aprovado (na fila da TV)", cor: "#0f7a4f", bg: "#f0fdf4", borda: "#bbf7d0" },
  PUBLICADO_TV: { texto: "Publicado na TV", cor: "#1d4ed8", bg: "#eff6ff", borda: "#bfdbfe" },
  REJEITADO: { texto: "Rejeitado", cor: "#b91c1c", bg: "#fef2f2", borda: "#fecaca" },
  ARQUIVADO: { texto: "Arquivado", cor: "#475569", bg: "#f8fafc", borda: "#e2e8f0" },
};

export default function ElogiosAtendimento() {
  const [carregando, setCarregando] = useState(true);
  const [elogios, setElogios] = useState([]);
  const [filtroStatus, setFiltroStatus] = useState("PENDENTE_ANALISE");
  const [busca, setBusca] = useState("");
  const [modalAprovar, setModalAprovar] = useState(null);
  const [modalRejeitar, setModalRejeitar] = useState(null);
  const [textoFinal, setTextoFinal] = useState("");
  const [exibirDe, setExibirDe] = useState(hojeISO());
  const [exibirAte, setExibirAte] = useState(maisDias(hojeISO(), 30));
  const [motivoRejeicao, setMotivoRejeicao] = useState("");
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    carregar();
  }, []);

  async function carregar() {
    setCarregando(true);

    const { data, error } = await supabase
      .from("elogios_atendimento")
      .select(
        "id, aluno_id, operador_email, operador_nome, print_path, print_nome_arquivo, observacao_operador, texto_final_tv, status, motivo_rejeicao, analisado_por_nome, analisado_em, exibir_de, exibir_ate, publicado_em, registrado_por_nome, registrado_em"
      )
      .order("registrado_em", { ascending: false })
      .limit(500);

    if (error) {
      console.error("Erro ao carregar elogios:", error);
      setCarregando(false);
      return;
    }

    const lista = data || [];
    const idsAlunos = [...new Set(lista.map((m) => m.aluno_id).filter(Boolean))];
    let nomesPorId = {};
    if (idsAlunos.length > 0) {
      const { data: alunos } = await supabase
        .from("alunos")
        .select("id, nome")
        .in("id", idsAlunos);
      nomesPorId = Object.fromEntries((alunos || []).map((a) => [String(a.id), a.nome]));
    }

    setElogios(lista.map((m) => ({ ...m, aluno_nome: nomesPorId[String(m.aluno_id)] || "Aluno" })));
    setCarregando(false);
  }

  async function abrirAnexo(path) {
    const { data, error } = await supabase.storage
      .from("elogios-prints")
      .createSignedUrl(path, 3600);

    if (error || !data?.signedUrl) {
      alert("Erro ao abrir o anexo: " + (error?.message || "não encontrado"));
      return;
    }

    window.open(data.signedUrl, "_blank");
  }

  function abrirModalAprovar(elogio) {
    setModalAprovar(elogio);
    setTextoFinal(elogio.observacao_operador || "");
    setExibirDe(hojeISO());
    setExibirAte(maisDias(hojeISO(), 30));
  }

  async function confirmarAprovacao() {
    if (!modalAprovar) return;
    if (!textoFinal.trim()) {
      alert('Informe o "Texto final para TV" antes de aprovar.');
      return;
    }
    setSalvando(true);
    const { error } = await supabase.rpc("elogio_aprovar", {
      p_id: modalAprovar.id,
      p_texto_final: textoFinal.trim(),
      p_exibir_de: exibirDe || null,
      p_exibir_ate: exibirAte || null,
    });
    setSalvando(false);

    if (error) {
      alert("Erro ao aprovar elogio: " + error.message);
      return;
    }

    setModalAprovar(null);
    carregar();
  }

  function abrirModalRejeitar(elogio) {
    setModalRejeitar(elogio);
    setMotivoRejeicao("");
  }

  async function confirmarRejeicao() {
    if (!modalRejeitar) return;
    setSalvando(true);
    const { error } = await supabase.rpc("elogio_rejeitar", {
      p_id: modalRejeitar.id,
      p_motivo: motivoRejeicao.trim() || null,
    });
    setSalvando(false);

    if (error) {
      alert("Erro ao rejeitar elogio: " + error.message);
      return;
    }

    setModalRejeitar(null);
    carregar();
  }

  async function publicarNaTv(elogio) {
    const { error } = await supabase.rpc("elogio_publicar", { p_id: elogio.id });
    if (error) {
      alert("Erro ao publicar elogio: " + error.message);
      return;
    }
    carregar();
  }

  async function arquivar(elogio) {
    if (!window.confirm("Arquivar este elogio? Ele deixa de aparecer na TV.")) return;
    const { error } = await supabase.rpc("elogio_arquivar", { p_id: elogio.id });
    if (error) {
      alert("Erro ao arquivar elogio: " + error.message);
      return;
    }
    carregar();
  }

  const filtrados = elogios.filter((e) => {
    if (filtroStatus !== "TODOS" && e.status !== filtroStatus) return false;
    if (busca.trim()) {
      const termo = busca.toLowerCase();
      if (
        !String(e.aluno_nome || "").toLowerCase().includes(termo) &&
        !String(e.operador_nome || "").toLowerCase().includes(termo) &&
        !String(e.observacao_operador || "").toLowerCase().includes(termo)
      ) {
        return false;
      }
    }
    return true;
  });

  const pendentesCount = elogios.filter((e) => e.status === "PENDENTE_ANALISE").length;

  if (carregando) {
    return <div style={estilos.container}>Carregando elogios de atendimento...</div>;
  }

  return (
    <div style={estilos.container}>
      <div style={estilos.cabecalho}>
        <div>
          <h1 style={estilos.titulo}>💚 Elogios de Atendimento</h1>
          <p style={estilos.subtitulo}>
            Aprovar aqui envia o elogio pra fila da TV ReATIVA. É preciso escrever o texto final antes de aprovar.
          </p>
        </div>
        <button style={estilos.botaoAtualizar} onClick={carregar}>
          Atualizar
        </button>
      </div>

      <div style={estilos.grid}>
        <div style={estilos.card}>
          <span style={estilos.numero}>{pendentesCount}</span>
          <span style={estilos.descricao}>Aguardando análise</span>
        </div>
        <div style={estilos.card}>
          <span style={estilos.numero}>{elogios.filter((e) => e.status === "APROVADO_TV").length}</span>
          <span style={estilos.descricao}>Aprovados (fila da TV)</span>
        </div>
        <div style={estilos.card}>
          <span style={estilos.numero}>{elogios.filter((e) => e.status === "PUBLICADO_TV").length}</span>
          <span style={estilos.descricao}>Publicados na TV</span>
        </div>
      </div>

      <div style={estilos.filtros}>
        <input
          style={estilos.input}
          placeholder="Buscar por aluno, operador ou observação..."
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
        />
        <select style={estilos.select} value={filtroStatus} onChange={(e) => setFiltroStatus(e.target.value)}>
          <option value="TODOS">Todos os status</option>
          <option value="PENDENTE_ANALISE">Aguardando análise</option>
          <option value="APROVADO_TV">Aprovado (fila da TV)</option>
          <option value="PUBLICADO_TV">Publicado na TV</option>
          <option value="REJEITADO">Rejeitado</option>
          <option value="ARQUIVADO">Arquivado</option>
        </select>
      </div>

      {filtrados.length === 0 && <p style={estilos.vazio}>Nenhum elogio encontrado com esse filtro.</p>}

      <div style={estilos.lista}>
        {filtrados.map((e) => {
          const s = STATUS_LABEL[e.status] || STATUS_LABEL.PENDENTE_ANALISE;
          return (
            <div key={e.id} style={{ ...estilos.card2, borderColor: s.borda, background: s.bg }}>
              <div style={estilos.topoCard}>
                <div>
                  <p style={estilos.nomeAluno}>
                    {e.aluno_nome}
                    <span style={{ ...estilos.badge, color: s.cor, background: s.bg, borderColor: s.borda }}>
                      {s.texto}
                    </span>
                  </p>
                  <p style={estilos.meta}>
                    Operador <strong>{e.operador_nome}</strong> · registrado em {formatarDataHora(e.registrado_em)}
                    {e.analisado_por_nome && (
                      <>
                        {" "}
                        · analisado por <strong>{e.analisado_por_nome}</strong> em {formatarDataHora(e.analisado_em)}
                      </>
                    )}
                  </p>
                  {e.observacao_operador && <p style={estilos.descricaoTexto}>{e.observacao_operador}</p>}
                  {e.texto_final_tv && e.status !== "PENDENTE_ANALISE" && (
                    <p style={estilos.textoFinalMostrado}>📺 "{e.texto_final_tv}"</p>
                  )}
                  {e.status === "APROVADO_TV" || e.status === "PUBLICADO_TV" ? (
                    <p style={estilos.meta}>
                      Exibindo de {e.exibir_de || "-"} até {e.exibir_ate || "sem limite"}
                    </p>
                  ) : null}
                  {e.status === "REJEITADO" && e.motivo_rejeicao && (
                    <p style={estilos.meta}>Motivo: {e.motivo_rejeicao}</p>
                  )}
                </div>

                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {e.print_path && (
                    <button style={estilos.botaoAnexo} onClick={() => abrirAnexo(e.print_path)}>
                      📎 Ver anexo{e.print_nome_arquivo ? `: ${e.print_nome_arquivo}` : ""}
                    </button>
                  )}

                  {e.status === "PENDENTE_ANALISE" && (
                    <>
                      <button style={estilos.botaoAprovar} onClick={() => abrirModalAprovar(e)}>
                        ✅ Aprovar para TV
                      </button>
                      <button style={estilos.botaoRejeitar} onClick={() => abrirModalRejeitar(e)}>
                        ✖ Rejeitar
                      </button>
                    </>
                  )}

                  {e.status === "APROVADO_TV" && (
                    <>
                      <button style={estilos.botaoAprovar} onClick={() => publicarNaTv(e)}>
                        📺 Publicar agora
                      </button>
                      <button style={estilos.botaoDesaprovar} onClick={() => arquivar(e)}>
                        Arquivar
                      </button>
                    </>
                  )}

                  {e.status === "PUBLICADO_TV" && (
                    <button style={estilos.botaoDesaprovar} onClick={() => arquivar(e)}>
                      Arquivar
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {modalAprovar && (
        <div style={estilos.overlay}>
          <div style={estilos.modal}>
            <h3 style={estilos.modalTitulo}>Aprovar elogio para a TV</h3>
            <p style={estilos.meta}>
              {modalAprovar.aluno_nome} · operador {modalAprovar.operador_nome}
            </p>

            <label style={estilos.label}>Texto final para TV *</label>
            <textarea
              style={estilos.textarea}
              value={textoFinal}
              onChange={(e) => setTextoFinal(e.target.value)}
              placeholder="Como o texto vai aparecer na tela da TV..."
              rows={4}
            />

            <div style={{ display: "flex", gap: 12 }}>
              <div style={{ flex: 1 }}>
                <label style={estilos.label}>Exibir de</label>
                <input
                  type="date"
                  style={estilos.inputData}
                  value={exibirDe}
                  onChange={(e) => setExibirDe(e.target.value)}
                />
              </div>
              <div style={{ flex: 1 }}>
                <label style={estilos.label}>Exibir até</label>
                <input
                  type="date"
                  style={estilos.inputData}
                  value={exibirAte}
                  onChange={(e) => setExibirAte(e.target.value)}
                />
              </div>
            </div>

            <div style={estilos.modalBotoes}>
              <button style={estilos.botaoCancelar} onClick={() => setModalAprovar(null)} disabled={salvando}>
                Cancelar
              </button>
              <button style={estilos.botaoAprovar} onClick={confirmarAprovacao} disabled={salvando}>
                {salvando ? "Salvando..." : "Confirmar aprovação"}
              </button>
            </div>
          </div>
        </div>
      )}

      {modalRejeitar && (
        <div style={estilos.overlay}>
          <div style={estilos.modal}>
            <h3 style={estilos.modalTitulo}>Rejeitar elogio</h3>
            <p style={estilos.meta}>
              {modalRejeitar.aluno_nome} · operador {modalRejeitar.operador_nome}
            </p>

            <label style={estilos.label}>Motivo (opcional)</label>
            <textarea
              style={estilos.textarea}
              value={motivoRejeicao}
              onChange={(e) => setMotivoRejeicao(e.target.value)}
              rows={3}
            />

            <div style={estilos.modalBotoes}>
              <button style={estilos.botaoCancelar} onClick={() => setModalRejeitar(null)} disabled={salvando}>
                Cancelar
              </button>
              <button style={estilos.botaoRejeitar} onClick={confirmarRejeicao} disabled={salvando}>
                {salvando ? "Salvando..." : "Confirmar rejeição"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const estilos = {
  container: {
    padding: "28px 30px 40px",
    fontFamily: "'Inter', system-ui, sans-serif",
    background: "#f4f6fa",
    minHeight: "100%",
  },
  cabecalho: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: "16px",
    marginBottom: "20px",
    flexWrap: "wrap",
  },
  titulo: {
    margin: 0,
    color: "#0d1321",
    fontFamily: "'Sora', 'Inter', system-ui, sans-serif",
    fontSize: 26,
    fontWeight: 800,
    letterSpacing: "-0.03em",
  },
  subtitulo: {
    margin: "5px 0 0",
    color: "#8a93a3",
    fontSize: 13.5,
    maxWidth: 520,
  },
  botaoAtualizar: {
    background: "#0f9d6b",
    color: "#fff",
    border: "none",
    borderRadius: 10,
    padding: "10px 18px",
    fontWeight: 700,
    fontSize: 13,
    cursor: "pointer",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
    gap: "14px",
    marginBottom: "18px",
    maxWidth: 620,
  },
  card: {
    background: "#fff",
    borderRadius: 16,
    padding: "16px 18px",
    boxShadow: "0 1px 2px rgba(16,24,40,0.04), 0 1px 3px rgba(16,24,40,0.05)",
    border: "1px solid #edf0f5",
  },
  numero: {
    display: "block",
    fontSize: 26,
    fontWeight: 800,
    color: "#0d1321",
    fontFamily: "'Sora', 'Inter', system-ui, sans-serif",
  },
  descricao: {
    fontSize: 12.5,
    color: "#8a93a3",
    fontWeight: 600,
  },
  filtros: {
    display: "flex",
    gap: "10px",
    flexWrap: "wrap",
    marginBottom: "18px",
  },
  input: {
    flex: 1,
    minWidth: 220,
    padding: "10px 13px",
    borderRadius: 10,
    border: "1px solid #e3e7ee",
    fontSize: 13,
  },
  select: {
    padding: "10px 13px",
    borderRadius: 10,
    border: "1px solid #e3e7ee",
    fontSize: 13,
    background: "#fff",
  },
  vazio: {
    color: "#8a93a3",
    fontSize: 13.5,
  },
  lista: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
  },
  card2: {
    borderRadius: 14,
    padding: "14px 18px",
    border: "1px solid #edf0f5",
    boxShadow: "0 1px 2px rgba(16,24,40,0.04)",
  },
  topoCard: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: "12px",
    flexWrap: "wrap",
  },
  nomeAluno: {
    margin: 0,
    fontWeight: 700,
    color: "#101828",
    fontSize: 14.5,
  },
  meta: {
    margin: "4px 0 0",
    fontSize: 12,
    color: "#8a93a3",
  },
  descricaoTexto: {
    margin: "10px 0 0",
    fontSize: 13,
    color: "#475569",
  },
  textoFinalMostrado: {
    margin: "8px 0 0",
    fontSize: 13,
    color: "#0d1321",
    fontStyle: "italic",
  },
  botaoAnexo: {
    background: "#f0fdf4",
    border: "1px solid #bbf7d0",
    color: "#15803d",
    borderRadius: 8,
    padding: "6px 10px",
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
  },
  badge: {
    marginLeft: 8,
    fontSize: 11,
    fontWeight: 700,
    borderRadius: 999,
    padding: "2px 9px",
    border: "1px solid",
  },
  botaoAprovar: {
    background: "#0f9d6b",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "6px 10px",
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
  },
  botaoRejeitar: {
    background: "#fff",
    color: "#475569",
    border: "1px solid #cbd5e1",
    borderRadius: 8,
    padding: "6px 10px",
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
  },
  botaoDesaprovar: {
    background: "#fff",
    color: "#b91c1c",
    border: "1px solid #fca5a5",
    borderRadius: 8,
    padding: "6px 10px",
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
  },
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(13,19,33,0.5)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
  },
  modal: {
    background: "#fff",
    borderRadius: 16,
    padding: "24px 26px",
    width: "min(480px, 92vw)",
    boxShadow: "0 20px 60px rgba(0,0,0,0.25)",
  },
  modalTitulo: {
    margin: "0 0 4px",
    fontSize: 18,
    fontWeight: 800,
    color: "#0d1321",
    fontFamily: "'Sora', 'Inter', system-ui, sans-serif",
  },
  label: {
    display: "block",
    fontSize: 12,
    fontWeight: 700,
    color: "#475569",
    margin: "14px 0 6px",
  },
  textarea: {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 10,
    border: "1px solid #e3e7ee",
    fontSize: 13.5,
    fontFamily: "inherit",
    resize: "vertical",
    boxSizing: "border-box",
  },
  inputData: {
    width: "100%",
    padding: "9px 12px",
    borderRadius: 10,
    border: "1px solid #e3e7ee",
    fontSize: 13,
    boxSizing: "border-box",
  },
  modalBotoes: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 10,
    marginTop: 20,
  },
  botaoCancelar: {
    background: "#fff",
    color: "#475569",
    border: "1px solid #cbd5e1",
    borderRadius: 8,
    padding: "8px 16px",
    fontSize: 13,
    fontWeight: 700,
    cursor: "pointer",
  },
};
