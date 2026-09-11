import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import { Carregando } from "../ui/estados";

const FONTE_TITULO = "'Sora', 'Inter', system-ui, sans-serif";

function formatarData(dataISO) {
  if (!dataISO) return "-";
  return new Date(dataISO).toLocaleString("pt-BR");
}

const CORES_TIPO = {
  Erro: { bg: "var(--rv-vermelho-fundo)", cor: "var(--rv-vermelho)" },
  Melhoria: { bg: "var(--rv-azul-fundo)", cor: "var(--rv-azul)" },
  "Sugestão / Melhoria": { bg: "var(--rv-azul-fundo)", cor: "var(--rv-azul)" },
  "Nova ideia": { bg: "var(--rv-verde-ok-fundo)", cor: "var(--rv-verde-ok)" },
  "Ajuste de informação": { bg: "var(--rv-ambar-fundo)", cor: "var(--rv-ambar-texto)" },
  Dúvida: { bg: "var(--rv-fundo-suave)", cor: "var(--rv-texto)" },
};

// Fluxo de tratativa. FEITA é tratada como "Corrigido/Feito".
const STATUS = {
  NOVA: { label: "Novas", chip: "Nova", bg: "var(--rv-roxo-fundo)", cor: "var(--rv-roxo-texto)" },
  REABERTO: { label: "Reabertas", chip: "Reaberto (persiste)", bg: "var(--rv-vermelho-fundo)", cor: "var(--rv-vermelho)" },
  EM_ANALISE: { label: "Em análise", chip: "Em análise", bg: "var(--rv-ambar-fundo)", cor: "var(--rv-ambar-texto)" },
  EM_TRATATIVA: { label: "Em tratativa", chip: "Em tratativa", bg: "var(--rv-ambar-fundo)", cor: "var(--rv-ambar-texto)" },
  AGUARDANDO_VALIDACAO: { label: "Aguardando validação", chip: "Aguardando validação", bg: "var(--rv-azul-fundo)", cor: "var(--rv-azul-texto)" },
  FEITA: { label: "Corrigidas", chip: "Corrigido / Feito", bg: "var(--rv-verde-ok-fundo)", cor: "var(--rv-verde-ok-texto)" },
  DESCARTADA: { label: "Descartadas", chip: "Descartada", bg: "var(--rv-fundo-suave)", cor: "var(--rv-texto-suave)" },
};
const ORDEM_FILTROS = ["NOVA", "REABERTO", "EM_ANALISE", "EM_TRATATIVA", "AGUARDANDO_VALIDACAO", "FEITA", "DESCARTADA", "TODAS"];

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

  async function alternarVisibilidade(id, atual) {
    await supabase.from("sugestoes").update({ visivel_equipe: !atual }).eq("id", id);
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
        <Carregando texto="Carregando…" />
      ) : filtradas.length === 0 ? (
        <p style={S.muted}>Nenhuma sugestão nesse filtro.</p>
      ) : (
        filtradas.map((s) => {
          const cores = CORES_TIPO[s.tipo] || { bg: "var(--rv-fundo-suave)", cor: "var(--rv-texto)" };
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
                  {s.visivel_equipe && <span style={S.badgeVisivel}>👁️ Visível p/ equipe</span>}
                </div>
                <span style={S.data}>{formatarData(s.criado_em)}</span>
              </div>
              <p style={S.descricao}>{s.descricao}</p>
              {s.retorno_operador && (
                <p style={S.retornoOperador}>❌ Operador reportou que o erro persiste: {s.retorno_operador}</p>
              )}
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
                  <button style={botaoStatus(atual, "AGUARDANDO_VALIDACAO")} onClick={() => mudarStatus(s.id, "AGUARDANDO_VALIDACAO")}>Enviar p/ validação</button>
                  <button style={botaoStatus(atual, "FEITA")} onClick={() => mudarStatus(s.id, "FEITA")}>Corrigido</button>
                  <button style={botaoStatus(atual, "DESCARTADA")} onClick={() => mudarStatus(s.id, "DESCARTADA")}>Descartar</button>
                  {s.tipo === "Erro" && (
                    <button style={S.botaoVisibilidade} onClick={() => alternarVisibilidade(s.id, s.visivel_equipe)}>
                      {s.visivel_equipe ? "🙈 Ocultar da equipe" : "👁️ Mostrar p/ equipe"}
                    </button>
                  )}
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
  container: { padding: "28px 30px 40px", fontFamily: "'Inter', system-ui, sans-serif", background: "var(--rv-fundo)", minHeight: "100%" },
  tratativa: { color: "var(--rv-texto-fraco)", fontWeight: 500 },
  badgeVisivel: { fontSize: 11, fontWeight: 800, padding: "3px 10px", borderRadius: 999, background: "var(--rv-azul-fundo)", color: "var(--rv-azul-texto)" },
  retornoOperador: { margin: "0 0 12px", background: "var(--rv-vermelho-fundo)", border: "1px solid var(--rv-vermelho-borda)", color: "var(--rv-vermelho-texto)", borderRadius: 10, padding: "9px 12px", fontSize: 13, lineHeight: 1.5 },
  botaoVisibilidade: { background: "var(--rv-fundo-cartao)", color: "var(--rv-texto)", border: "1px solid var(--rv-borda)", borderRadius: 8, padding: "6px 12px", fontSize: 11.5, fontWeight: 700, cursor: "pointer" },
  cabecalho: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, marginBottom: 18, flexWrap: "wrap" },
  titulo: { margin: 0, color: "var(--rv-tinta)", fontFamily: FONTE_TITULO, fontSize: 26, fontWeight: 800, letterSpacing: "-0.03em" },
  subtitulo: { margin: "5px 0 0", color: "var(--rv-texto-fraco)", fontSize: 13.5 },
  botaoAtualizar: { background: "#2563eb", color: "#fff", border: "none", borderRadius: 10, padding: "10px 18px", fontWeight: 700, fontSize: 13, cursor: "pointer" },
  filtros: { display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" },
  filtro: { background: "var(--rv-superficie)", color: "var(--rv-texto-forte)", border: "1px solid var(--rv-borda)", borderRadius: 10, padding: "8px 14px", fontWeight: 700, fontSize: 12.5, cursor: "pointer" },
  filtroAtivo: { background: "#2563eb", color: "#fff", border: "1px solid #2563eb", borderRadius: 10, padding: "8px 14px", fontWeight: 700, fontSize: 12.5, cursor: "pointer" },
  muted: { color: "var(--rv-texto-fraco)" },
  card: { background: "var(--rv-superficie)", border: "1px solid var(--rv-borda-suave)", borderRadius: 16, padding: "18px 20px", marginBottom: 14, boxShadow: "0 1px 2px rgba(16,24,40,0.04)" },
  cardTopo: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, flexWrap: "wrap", marginBottom: 10 },
  badge: { fontSize: 11, fontWeight: 800, padding: "3px 10px", borderRadius: 999 },
  badgeCinza: { fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 999, background: "var(--rv-fundo-suave)", color: "var(--rv-texto-suave)" },
  data: { fontSize: 12, color: "var(--rv-texto-fraco)" },
  descricao: { fontSize: 13.5, color: "var(--rv-texto-forte)", lineHeight: 1.55, margin: "0 0 12px" },
  botaoAnexo: { background: "var(--rv-fundo-cartao)", color: "var(--rv-azul)", border: "1px solid var(--rv-azul-borda)", borderRadius: 8, padding: "6px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer", marginBottom: 12 },
  blocoObs: { background: "var(--rv-fundo-cartao)", border: "1px solid var(--rv-borda-suave)", borderRadius: 10, padding: "10px 12px", marginBottom: 12, display: "flex", flexDirection: "column", gap: 8 },
  obsTexto: { margin: 0, fontSize: 13, color: "var(--rv-texto-forte)", lineHeight: 1.5, whiteSpace: "pre-wrap" },
  obsInput: { width: "100%", boxSizing: "border-box", minHeight: 64, resize: "vertical", padding: "8px 10px", borderRadius: 8, border: "1px solid var(--rv-borda)", fontSize: 13, fontFamily: "inherit" },
  obsEditar: { alignSelf: "flex-start", background: "transparent", color: "var(--rv-azul)", border: "none", padding: 0, fontSize: 12.5, fontWeight: 700, cursor: "pointer" },
  obsSalvar: { background: "#2563eb", color: "#fff", border: "none", borderRadius: 8, padding: "7px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer" },
  obsCancelar: { background: "var(--rv-fundo-suave)", color: "var(--rv-texto-suave)", border: "none", borderRadius: 8, padding: "7px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer" },
  rodape: { display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 },
  autor: { fontSize: 12, color: "var(--rv-texto-fraco)", fontWeight: 600 },
  botaoAcao: { background: "var(--rv-azul-fundo)", color: "var(--rv-azul)", border: "none", borderRadius: 8, padding: "6px 12px", fontSize: 11.5, fontWeight: 700, cursor: "pointer" },
  botaoAcaoVerde: { background: "var(--rv-verde-ok-fundo)", color: "var(--rv-verde-ok)", border: "none", borderRadius: 8, padding: "6px 12px", fontSize: 11.5, fontWeight: 700, cursor: "pointer" },
  botaoAcaoCinza: { background: "var(--rv-fundo-suave)", color: "var(--rv-texto-suave)", border: "none", borderRadius: 8, padding: "6px 12px", fontSize: 11.5, fontWeight: 700, cursor: "pointer" },
};
