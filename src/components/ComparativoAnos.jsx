import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

function moeda(v) {
  return Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
}
function num(v) {
  return Number(v || 0).toLocaleString("pt-BR");
}
const MESES = ["", "Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];

export default function ComparativoAnos() {
  const [d, setD] = useState(null);
  const [carregando, setCarregando] = useState(true);

  useEffect(() => {
    let ativo = true;
    (async () => {
      const { data } = await supabase.rpc("dashboard_ano_vs_ano");
      if (!ativo) return;
      setD(data);
      setCarregando(false);
    })();
    return () => { ativo = false; };
  }, []);

  if (carregando) return <section style={S.wrap}><p style={S.muted}>Carregando comparativo 2025 x 2026...</p></section>;
  if (!d) return null;

  const meses = d.por_mes || [];
  const maxMes = Math.max(1, ...meses.map((m) => Math.max(Number(m.rec_2025) || 0, Number(m.rec_2026) || 0)));
  const proj = d.projecao_2026 || {};
  const tg = d.totais_gerais || {};
  const varTotal = d.total_2025 > 0 ? ((d.total_2026 - d.total_2025) / d.total_2025) * 100 : 0;
  const projVs2025 = d.total_2025 > 0 ? ((proj.projecao_fim_ano - d.total_2025) / d.total_2025) * 100 : 0;

  return (
    <section style={S.wrap}>
      <h2 style={S.tituloSecao}>Recuperação — consolidado</h2>
      <div style={S.kpiRow}>
        <Kpi rot="Valor total pago" val={moeda(tg.valor_pago)} cor="#16a34a" destaque />
        <Kpi rot="Honorários" val={moeda(tg.honorarios)} cor="#0ea5e9" />
        <Kpi rot="Alunos pagos (únicos)" val={num(tg.alunos_unicos)} cor="#7c3aed" />
        <Kpi rot="Parcelas pagas" val={num(tg.parcelas)} cor="#d97706" />
      </div>

      <h2 style={{ ...S.tituloSecao, marginTop: 24 }}>Recuperação — 2025 x 2026</h2>

      <div style={S.heroRow}>
        <Hero rot="Recuperado 2025" val={moeda(d.total_2025)} cor="#94a3b8" nota="abr–dez/2025" />
        <Hero rot="Recuperado 2026 (até hoje)" val={moeda(d.total_2026)} cor="#16a34a"
              nota={`jan–${MESES[proj.mes_ref]}/2026`} />
        <Hero rot="Projeção fim de 2026" val={moeda(proj.projecao_fim_ano)} cor="#7c3aed"
              nota={projVs2025 >= 0 ? `+${projVs2025.toFixed(0)}% vs 2025` : `${projVs2025.toFixed(0)}% vs 2025`} />
      </div>

      <div style={S.card}>
        <div style={S.legend}>
          <span><span style={{ ...S.dot, background: "#cbd5e1" }} />2025</span>
          <span><span style={{ ...S.dot, background: "#16a34a" }} />2026</span>
        </div>
        {meses.map((m) => (
          <div key={m.mes} style={S.linha}>
            <div style={S.linhaTopo}>
              <span style={{ width: 34, display: "inline-block", fontWeight: 600 }}>{MESES[m.mes]}</span>
              <span style={S.vals}>
                <span style={{ color: "#64748b" }}>{moeda(m.rec_2025)}</span>
                <strong style={{ color: "#16a34a" }}>{moeda(m.rec_2026)}</strong>
              </span>
            </div>
            <div style={S.par}>
              <div style={S.track}>
                <div style={{ ...S.fill, width: Math.max(1, (Number(m.rec_2025) / maxMes) * 100) + "%", background: "#cbd5e1" }} />
              </div>
              <div style={S.track}>
                <div style={{ ...S.fill, width: Math.max(1, (Number(m.rec_2026) / maxMes) * 100) + "%", background: "#16a34a" }} />
              </div>
            </div>
          </div>
        ))}
      </div>

      <div style={S.card}>
        <h3 style={S.h3}>Como chegamos na projeção de {moeda(proj.projecao_fim_ano)}</h3>
        <div style={S.statsRow}>
          <Stat rot={`Realizado até ${proj.dia_ref}/${MESES[proj.mes_ref]}`} val={moeda(proj.realizado_ate_hoje)} />
          <Stat rot="Média mensal (2026)" val={moeda(proj.media_mensal)} />
          <Stat rot={`${MESES[proj.mes_ref]} projetado (mês cheio)`} val={moeda(proj.mes_atual_projetado)} />
        </div>
        <p style={S.rodape}>
          Projeção = meses já fechados + mês atual estimado pelo ritmo diário + média mensal nos meses restantes.
          No acumulado parcial, 2026 está {varTotal >= 0 ? "+" : ""}{varTotal.toFixed(0)}% vs o mesmo bloco de 2025.
        </p>
      </div>
    </section>
  );
}

function Kpi({ rot, val, cor, destaque }) {
  return (
    <div style={S.kpi}>
      <div style={{ ...S.kpiFaixa, background: cor }} />
      <div style={S.kpiCorpo}>
        <span style={S.kpiRot}>{rot}</span>
        <span style={{ ...S.kpiVal, color: destaque ? cor : "#111827", fontSize: destaque ? 28 : 24 }}>{val}</span>
      </div>
    </div>
  );
}

function Hero({ rot, val, cor, nota }) {
  return (
    <div style={S.hero}>
      <span style={{ ...S.heroVal, color: cor }}>{val}</span>
      <span style={S.heroRot}>{rot}</span>
      {nota ? <span style={S.heroNota}>{nota}</span> : null}
    </div>
  );
}
function Stat({ rot, val }) {
  return (
    <div style={S.stat}>
      <span style={S.statVal}>{val}</span>
      <span style={S.statRot}>{rot}</span>
    </div>
  );
}

const S = {
  wrap: { marginBottom: 26 },
  tituloSecao: { margin: "0 0 12px 0", color: "#334155", fontSize: 14, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em" },
  kpiRow: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14, marginBottom: 6 },
  kpi: { background: "#fff", borderRadius: 14, boxShadow: "0 1px 3px rgba(15,23,42,0.06)", border: "1px solid #eef2f7", overflow: "hidden", display: "flex" },
  kpiFaixa: { width: 4, flexShrink: 0 },
  kpiCorpo: { padding: "16px 18px", flex: 1, display: "flex", flexDirection: "column", gap: 8 },
  kpiRot: { fontSize: 12.5, color: "#64748b", fontWeight: 600 },
  kpiVal: { fontWeight: 800, lineHeight: 1.1 },
  heroRow: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14, marginBottom: 14 },
  hero: { background: "#fff", border: "1px solid #eef2f7", borderRadius: 14, padding: "16px 18px", display: "flex", flexDirection: "column", gap: 4, boxShadow: "0 1px 3px rgba(15,23,42,0.06)" },
  heroVal: { fontSize: 26, fontWeight: 800, lineHeight: 1.1 },
  heroRot: { fontSize: 12.5, color: "#64748b", fontWeight: 600 },
  heroNota: { fontSize: 12, color: "#94a3b8", fontWeight: 600 },
  statsRow: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 8 },
  stat: { background: "#f8fafc", borderRadius: 12, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 4 },
  statVal: { fontSize: 20, fontWeight: 800, color: "#111827" },
  statRot: { fontSize: 12, color: "#64748b", fontWeight: 600 },
  card: { background: "#fff", border: "1px solid #eef2f7", borderRadius: 14, padding: 18, marginBottom: 14, boxShadow: "0 1px 3px rgba(15,23,42,0.06)" },
  h3: { margin: "0 0 14px", fontSize: 15, fontWeight: 700, color: "#0f172a" },
  linha: { marginBottom: 12 },
  linhaTopo: { display: "flex", justifyContent: "space-between", gap: 10, fontSize: 13, color: "#334155", marginBottom: 5, alignItems: "center" },
  vals: { display: "flex", gap: 14 },
  par: { display: "flex", flexDirection: "column", gap: 3 },
  track: { background: "#f1f5f9", borderRadius: 999, height: 9, overflow: "hidden" },
  fill: { height: "100%", borderRadius: 999 },
  legend: { display: "flex", gap: 16, fontSize: 12, color: "#64748b", marginBottom: 10 },
  dot: { display: "inline-block", width: 10, height: 10, borderRadius: 2, marginRight: 4 },
  muted: { color: "#64748b" },
  rodape: { color: "#8a93a3", fontSize: 12, marginTop: 8 },
};
