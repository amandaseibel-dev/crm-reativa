import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

const FONTE_TITULO = "'Sora', 'Inter', system-ui, sans-serif";

function formatarData(dataISO) {
  if (!dataISO) return "-";
  return new Date(dataISO).toLocaleString("pt-BR");
}

const CORES_TIPO = {
  Erro: { bg: "#fef2f2", cor: "#dc2626" },
  Melhoria: { bg: "#eff6ff", cor: "#2563eb" },
  "Sugestão / Melhoria": { bg: "#eff6ff", cor: "#2563eb" },
  "Nova ideia": { bg: "#ecfdf5", cor: "#16a34a" },
  "Ajuste de informação": { bg: "#fffbeb", cor: "#b45309" },
  Dúvida: { bg: "#f1f5f9", cor: "#475569" },
};

// Fluxo de tratativa. FEITA é tratada como "Corrigido/Feito".
const STATUS = {
  NOVA: { label: "Novas", chip: "Nova", bg: "#eef2ff", cor: "#4338ca" },
  EM_ANALISE: { label: "Em análise", chip: "Em análise", bg: "#fff7ed", cor: "#c2410c" },
  EM_TRATATIVA: { label: "Em tratativa", chip: "Em tratativa", bg: "#fefce8", cor: "#a16207" },
  FEITA: { label: "Corrigidas", chip: "Corrigido / Feito", bg: "#ecfdf5", cor: "#15803d" },
  DESCARTADA: { label: "Descartadas", chip: "Descartada", bg: "#f1f5f9", cor: "#64748b" },
};
const ORDEM_FILTROS = ["NOVA", "EM_ANALISE", "EM_TRATATIVA", "FEITA", "DESCARTADA", "TODAS"];

export default function SugestoesRecebidas() {
  const [carregando, setCarregando] = useState(true);
  const [lista, setLista] = useState([]);
  const [filtroStatus, setFiltroStatus] = useState("NOVA");
  const [rascunho, setRascunho] = useState({}); // id -> texto em edição
  const [salvandoObs, setSalvandoObs] = useState(null);

  useEffect(() => {
    carregar();
  }, []);

  async function carregar() {
    setCarregando(true);
    const { data } = await supabase.from("sugestoes").select("*").order("criado_em", { ascending: false });
    setLista(data || []);
    setCarregando(false);
  }

  async function mudarStatus(id, status) {
    const { data: userData } = await supabase.auth.getUser();
    await supabase
      .from("sugestoes")
      .update({ status, status_em: new Date().toISOString(), status_por: userData?.user?.email || null })
      .eq("id", id);
    carregar();
  }

  async function salvarObservacao(id) {
    setSalvandoObs(id);
    const { data: userData } = await supabase.auth.getUser();
    await supabase
      .from("sugestoes")
      .update({
        observacao_tratativa: (rascunho[id] || "").trim() || null,
        status_em: new Date().toISOString(),
        status_por: userData?.user?.email || null,
      })
      .eq("id", id);
    setSalvandoObs(null);
    setRascunho((r) => {
      const novo = { ...r };
      delete novo[id];
      return novo;
    });
    carregar();
  }

  async function abrirAnexo(path) {
    const { data, error } = await supabase.storage
      .from("sugestoes-prints")
      .createSignedUrl(path, 60);
    if (error || !data?.signedUrl) {
      alert("Não foi possível abrir o print agora.");
      return;
    }
    window.open(data.signedUrl, "_blank", "noopener");
  }

  const filtradas = filtroStatus === "TODAS" ? lista : lista.filter((s) => (s.status || "NOVA") === filtroStatus);

  return (
    <div style={S.container}>
      <div style={S.cabecalho}>
        <div>
          <h1 style={S.titulo}>💡 Sugestões Recebidas</h1>
          <p style={S.subtitulo}>Ideias, ajustes e melhorias enviadas pela equipe pelo Portal Operacional.</p>
        </div>
        <button style={S.botaoAtualizar} onClick={carregar}>Atualizar</button>
      </div>

      <div style={S.filtros}>
        {ORDEM_FILTROS.map((s) => {
          const qtd = s === "TODAS" ? lista.length : lista.filter((x) => (x.status || "NOVA") === s).length;
          return (
            <button
              key={s}
              onClick={() => setFiltroStatus(s)}
              style={filtroStatus === s ? S.filtroAtivo : S.filtro}
            >
              {s === "TODAS" ? "Todas" : STATUS[s].label} ({qtd})
            </button>
          );
        })}
      </div>

      {carregando ? (
        <p style={S.muted}>Carregando...</p>
      ) : filtradas.length === 0 ? (
        <p style={S.muted}>Nenhuma sugestão nesse filtro.</p>
      ) : (
        filtradas.map((s) => {
          const cores = CORES_TIPO[s.tipo] || { bg: "#f1f5f9", cor: "#475569" };
          const st = STATUS[s.status || "NOVA"] || STATUS.NOVA;
          const atual = s.status || "NOVA";
          return (
            <div key={s.id} style={S.card}>
              <div style={S.cardTopo}>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ ...S.badge, background: st.bg, color: st.cor }}>{st.chip}</span>
                  <span style={{ ...S.badge, background: cores.bg, color: cores.cor }}>{s.tipo}</span>
                  <span style={S.badgeCinza}>{s.area}</span>
                  {s.prioridade && <span style={S.badgeCinza}>Prioridade: {s.prioridade}</span>}
                  {s.tela && <span style={S.badgeCinza}>{s.tela}</span>}
                </div>
                <span style={S.data}>{formatarData(s.criado_em)}</span>
              </div>
              <p style={S.descricao}>{s.descricao}</p>
              {s.anexo_path && (
                <button style={S.botaoAnexo} onClick={() => abrirAnexo(s.anexo_path)}>
                  📎 Ver print{s.anexo_nome ? `: ${s.anexo_nome}` : ""}
                </button>
              )}

              <div style={S.blocoObs}>
                {s.observacao_tratativa && rascunho[s.id] === undefined && (
                  <p style={S.obsTexto}>💬 {s.observacao_tratativa}</p>
                )}
                {rascunho[s.id] !== undefined ? (
                  <>
                    <textarea
                      style={S.obsInput}
                      placeholder="Escreva a tratativa / resposta desta sugestão..."
                      value={rascunho[s.id]}
                      onChange={(e) => setRascunho((r) => ({ ...r, [s.id]: e.target.value }))}
                    />
                    <div style={{ display: "flex", gap: 6 }}>
                      <button style={S.obsSalvar} disabled={salvandoObs === s.id} onClick={() => salvarObservacao(s.id)}>
                        {salvandoObs === s.id ? "Salvando..." : "Salvar tratativa"}
                      </button>
                      <button style={S.obsCancelar} onClick={() => setRascunho((r) => { const n = { ...r }; delete n[s.id]; return n; })}>
                        Cancelar
                      </button>
                    </div>
                  </>
                ) : (
                  <button style={S.obsEditar} onClick={() => setRascunho((r) => ({ ...r, [s.id]: s.observacao_tratativa || "" }))}>
                    {s.observacao_tratativa ? "✏️ Editar tratativa" : "➕ Adicionar tratativa"}
                  </button>
                )}
              </div>

              <div style={S.rodape}>
                <span style={S.autor}>
                  {s.nome || s.autor_email || "Anônimo"}
                  {s.status_em && (
                    <span style={S.tratativa}> · {st.chip.toLowerCase()} em {formatarData(s.status_em)}{s.status_por ? ` por ${s.status_por}` : ""}</span>
                  )}
                </span>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <button style={botaoStatus(atual, "EM_ANALISE")} onClick={() => mudarStatus(s.id, "EM_ANALISE")}>Em análise</button>
                  <button style={botaoStatus(atual, "EM_TRATATIVA")} onClick={() => mudarStatus(s.id, "EM_TRATATIVA")}>Em tratativa</button>
                  <button style={botaoStatus(atual, "FEITA")} onClick={() => mudarStatus(s.id, "FEITA")}>Corrigido</button>
                  <button style={botaoStatus(atual, "DESCARTADA")} onClick={() => mudarStatus(s.id, "DESCARTADA")}>Descartar</button>
                </div>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

// Botão de status: destaca o estado atual e apaga levemente os demais.
function botaoStatus(atual, alvo) {
  const ativo = atual === alvo;
  const st = STATUS[alvo];
  return {
    background: ativo ? st.cor : st.bg,
    color: ativo ? "#fff" : st.cor,
    border: "none",
    borderRadius: 8,
    padding: "6px 12px",
    fontSize: 11.5,
    fontWeight: 700,
    cursor: "pointer",
    opacity: ativo ? 1 : 0.92,
  };
}

const S = {
  container: { padding: "28px 30px 40px", fontFamily: "'Inter', system-ui, sans-serif", background: "#f4f6fa", minHeight: "100%" },
  tratativa: { color: "#94a3b8", fontWeight: 500 },
  cabecalho: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, marginBottom: 18, flexWrap: "wrap" },
  titulo: { margin: 0, color: "#0d1321", fontFamily: FONTE_TITULO, fontSize: 26, fontWeight: 800, letterSpacing: "-0.03em" },
  subtitulo: { margin: "5px 0 0", color: "#8a93a3", fontSize: 13.5 },
  botaoAtualizar: { background: "#2563eb", color: "#fff", border: "none", borderRadius: 10, padding: "10px 18px", fontWeight: 700, fontSize: 13, cursor: "pointer" },
  filtros: { display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" },
  filtro: { background: "#fff", color: "#334155", border: "1px solid #e2e8f0", borderRadius: 10, padding: "8px 14px", fontWeight: 700, fontSize: 12.5, cursor: "pointer" },
  filtroAtivo: { background: "#2563eb", color: "#fff", border: "1px solid #2563eb", borderRadius: 10, padding: "8px 14px", fontWeight: 700, fontSize: 12.5, cursor: "pointer" },
  muted: { color: "#8a93a3" },
  card: { background: "#fff", border: "1px solid #edf0f5", borderRadius: 16, padding: "18px 20px", marginBottom: 14, boxShadow: "0 1px 2px rgba(16,24,40,0.04)" },
  cardTopo: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, flexWrap: "wrap", marginBottom: 10 },
  badge: { fontSize: 11, fontWeight: 800, padding: "3px 10px", borderRadius: 999 },
  badgeCinza: { fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 999, background: "#f1f5f9", color: "#64748b" },
  data: { fontSize: 12, color: "#8a93a3" },
  descricao: { fontSize: 13.5, color: "#334155", lineHeight: 1.55, margin: "0 0 12px" },
  botaoAnexo: { background: "#f8fafc", color: "#2563eb", border: "1px solid #dbeafe", borderRadius: 8, padding: "6px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer", marginBottom: 12 },
  blocoObs: { background: "#f8fafc", border: "1px solid #eef2f7", borderRadius: 10, padding: "10px 12px", marginBottom: 12, display: "flex", flexDirection: "column", gap: 8 },
  obsTexto: { margin: 0, fontSize: 13, color: "#334155", lineHeight: 1.5, whiteSpace: "pre-wrap" },
  obsInput: { width: "100%", boxSizing: "border-box", minHeight: 64, resize: "vertical", padding: "8px 10px", borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 13, fontFamily: "inherit" },
  obsEditar: { alignSelf: "flex-start", background: "transparent", color: "#2563eb", border: "none", padding: 0, fontSize: 12.5, fontWeight: 700, cursor: "pointer" },
  obsSalvar: { background: "#2563eb", color: "#fff", border: "none", borderRadius: 8, padding: "7px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer" },
  obsCancelar: { background: "#f1f5f9", color: "#64748b", border: "none", borderRadius: 8, padding: "7px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer" },
  rodape: { display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 },
  autor: { fontSize: 12, color: "#8a93a3", fontWeight: 600 },
  botaoAcao: { background: "#eff6ff", color: "#2563eb", border: "none", borderRadius: 8, padding: "6px 12px", fontSize: 11.5, fontWeight: 700, cursor: "pointer" },
  botaoAcaoVerde: { background: "#ecfdf5", color: "#16a34a", border: "none", borderRadius: 8, padding: "6px 12px", fontSize: 11.5, fontWeight: 700, cursor: "pointer" },
  botaoAcaoCinza: { background: "#f1f5f9", color: "#64748b", border: "none", borderRadius: 8, padding: "6px 12px", fontSize: 11.5, fontWeight: 700, cursor: "pointer" },
};
