import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

// Bloco motivacional no topo da Minha Fila: mostra os acionamentos do
// operador logado (hoje, semana, mes) e o recorde (melhor dia). Recarrega
// sozinho a cada 60s. Horario de Brasilia e nome do operador vem do RPC.
export default function MeusAcionamentos() {
  const [d, setD] = useState(null);

  async function carregar() {
    const { data } = await supabase.rpc("meus_acionamentos_resumo");
    if (data && data.ok) setD(data);
  }
  useEffect(() => {
    carregar();
    const t = setInterval(carregar, 60000);
    return () => clearInterval(t);
  }, []);

  if (!d) return null;

  const recordeData = d.recorde_data
    ? new Date(d.recorde_data + "T00:00:00").toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })
    : null;
  const bateuRecorde = d.hoje > 0 && d.hoje >= d.recorde_qtd;

  return (
    <div style={S.wrap}>
      <div style={S.head}>
        <strong style={S.titulo}>📈 Seus acionamentos</strong>
        {bateuRecorde ? <span style={S.recordeHoje}>🔥 Recorde batido hoje!</span> : null}
      </div>
      <div style={S.cards}>
        <Card cor="#60a5fa" valor={d.hoje} rot="Hoje" />
        <Card cor="#38bdf8" valor={d.semana} rot="Últimos 7 dias" />
        <Card cor="#4ade80" valor={d.mes} rot="No mês" />
        <Card cor="#fbbf24" valor={d.recorde_qtd} rot={recordeData ? "🏆 Recorde (" + recordeData + ")" : "🏆 Recorde"} />
        {d.tempo_medio_min != null ? <Card cor="#a78bfa" valor={d.tempo_medio_min + " min"} rot="⏱️ Tempo médio/acion." /> : null}
        {d.projecao_dia != null ? <Card cor="#f472b6" valor={d.projecao_dia} rot="🎯 Projeção do dia (ritmo)" /> : null}
      </div>
    </div>
  );
}

function Card({ cor, valor, rot }) {
  return (
    <div style={S.card}>
      <span style={{ ...S.cardVal, color: cor }}>{typeof valor === "number" ? Number(valor || 0).toLocaleString("pt-BR") : valor}</span>
      <span style={S.cardRot}>{rot}</span>
    </div>
  );
}

const S = {
  wrap: { background: "#0b1220", border: "1px solid #1f2937", borderRadius: 16, padding: "14px 16px", marginBottom: 16 },
  head: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 10, flexWrap: "wrap" },
  titulo: { fontSize: 15, color: "#e5e7eb" },
  recordeHoje: { fontSize: 12.5, color: "#fca5a5", fontWeight: 800 },
  cards: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 10 },
  card: { background: "#111827", border: "1px solid #1f2937", borderRadius: 12, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 3 },
  cardVal: { fontSize: 26, fontWeight: 800, lineHeight: 1.1 },
  cardRot: { fontSize: 12, color: "#94a3b8", fontWeight: 600 },
};
