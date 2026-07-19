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
  "Nova ideia": { bg: "#ecfdf5", cor: "#16a34a" },
  "Ajuste de informação": { bg: "#fffbeb", cor: "#b45309" },
  Dúvida: { bg: "#f1f5f9", cor: "#475569" },
};

export default function SugestoesRecebidas() {
  const [carregando, setCarregando] = useState(true);
  const [lista, setLista] = useState([]);
  const [filtroStatus, setFiltroStatus] = useState("NOVA");

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
    await supabase.from("sugestoes").update({ status }).eq("id", id);
    carregar();
  }

  const filtradas = filtroStatus === "TODAS" ? lista : lista.filter((s) => s.status === filtroStatus);

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
        {["NOVA", "EM_ANALISE", "FEITA", "DESCARTADA", "TODAS"].map((s) => (
          <button
            key={s}
            onClick={() => setFiltroStatus(s)}
            style={filtroStatus === s ? S.filtroAtivo : S.filtro}
          >
            {s === "NOVA" ? "Novas" : s === "EM_ANALISE" ? "Em análise" : s === "FEITA" ? "Feitas" : s === "DESCARTADA" ? "Descartadas" : "Todas"}
          </button>
        ))}
      </div>

      {carregando ? (
        <p style={S.muted}>Carregando...</p>
      ) : filtradas.length === 0 ? (
        <p style={S.muted}>Nenhuma sugestão nesse filtro.</p>
      ) : (
        filtradas.map((s) => {
          const cores = CORES_TIPO[s.tipo] || { bg: "#f1f5f9", cor: "#475569" };
          return (
            <div key={s.id} style={S.card}>
              <div style={S.cardTopo}>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ ...S.badge, background: cores.bg, color: cores.cor }}>{s.tipo}</span>
                  <span style={S.badgeCinza}>{s.area}</span>
                  {s.prioridade && <span style={S.badgeCinza}>Prioridade: {s.prioridade}</span>}
                  {s.tela && <span style={S.badgeCinza}>{s.tela}</span>}
                </div>
                <span style={S.data}>{formatarData(s.criado_em)}</span>
              </div>
              <p style={S.descricao}>{s.descricao}</p>
              <div style={S.rodape}>
                <span style={S.autor}>{s.nome || s.autor_email || "Anônimo"}</span>
                <div style={{ display: "flex", gap: 6 }}>
                  <button style={S.botaoAcao} onClick={() => mudarStatus(s.id, "EM_ANALISE")}>Em análise</button>
                  <button style={S.botaoAcaoVerde} onClick={() => mudarStatus(s.id, "FEITA")}>Feita</button>
                  <button style={S.botaoAcaoCinza} onClick={() => mudarStatus(s.id, "DESCARTADA")}>Descartar</button>
                </div>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

const S = {
  container: { padding: "28px 30px 40px", fontFamily: "'Inter', system-ui, sans-serif", background: "#f4f6fa", minHeight: "100%" },
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
  rodape: { display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 },
  autor: { fontSize: 12, color: "#8a93a3", fontWeight: 600 },
  botaoAcao: { background: "#eff6ff", color: "#2563eb", border: "none", borderRadius: 8, padding: "6px 12px", fontSize: 11.5, fontWeight: 700, cursor: "pointer" },
  botaoAcaoVerde: { background: "#ecfdf5", color: "#16a34a", border: "none", borderRadius: 8, padding: "6px 12px", fontSize: 11.5, fontWeight: 700, cursor: "pointer" },
  botaoAcaoCinza: { background: "#f1f5f9", color: "#64748b", border: "none", borderRadius: 8, padding: "6px 12px", fontSize: 11.5, fontWeight: 700, cursor: "pointer" },
};
