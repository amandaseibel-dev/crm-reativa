import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import ComparativoAnos from "../components/ComparativoAnos";

function moeda(v) {
  return Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
}
function num(v) {
  return Number(v || 0).toLocaleString("pt-BR");
}
function mesLabel(m) {
  const [a, mm] = String(m || "").split("-");
  const nomes = ["", "Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
  return (nomes[Number(mm)] || m) + "/" + String(a).slice(2);
}

export default function ExecutivoRecuperacao() {
  const [d, setD] = useState(null);
  const [carregando, setCarregando] = useState(true);

  useEffect(() => {
    let ativo = true;
    (async () => {
      const { data } = await supabase.rpc("dashboard_executivo");
      if (!ativo) return;
      setD(data);
      setCarregando(false);
    })();
    return () => { ativo = false; };
  }, []);

  if (carregando) return <div style={S.wrap}><p style={S.muted}>Carregando visão executiva...</p></div>;
  if (!d) return <div style={S.wrap}><p style={S.muted}>Não foi possível carregar.</p></div>;

  const ev = d.evolucao || [];
  const maxEv = Math.max(1, ...ev.map((x) => Number(x.recuperado) || 0));
  const uni = (d.por_unidade || []).slice(0, 12);
  const maxUni = Math.max(1, ...uni.map((x) => (Number(x.recuperado) || 0) + (Number(x.a_cobrar) || 0)));

  return (
    <div style={S.wrap}>
      <div style={S.head}>
        <h1 style={S.h1}>Recuperação ULBRA — Visão Executiva</h1>
        <span style={S.sub}>Resultado consolidado da operação ReATIVA</span>
      </div>

      <div style={S.heroRow}>
        <Hero rot="Total recuperado" val={moeda(d.recuperado_total)} cor="#0f172a" />
        <Hero rot="Honorários" val={moeda(d.honorarios_total)} cor="#1e40af" destaque />
        <Hero rot="Alunos pagos" val={num(d.alunos_pagos)} cor="#0f172a" />
        <Hero rot="% da carteira recuperada" val={(d.pct_recuperado_valor || 0) + "%"} cor="#16a34a" />
      </div>

      <div style={S.statsRow}>
        <Stat rot="Pagamentos processados" val={num(d.pagamentos)} />
      </div>

      <ComparativoAnos />

      <div style={S.card}>
        <h3 style={S.h3}>Evolução mensal do recuperado</h3>
        {ev.map((x) => (
          <div key={x.mes} style={S.linha}>
            <div style={S.linhaTopo}>
              <span>{mesLabel(x.mes)} — {num(x.alunos)} alunos</span>
              <strong>{moeda(x.recuperado)}</strong>
            </div>
            <div style={S.track}>
              <div style={{ ...S.fill, width: Math.max(2, (Number(x.recuperado) / maxEv) * 100) + "%" }} />
            </div>
          </div>
        ))}
      </div>

      <div style={S.card}>
        <h3 style={S.h3}>Recuperado x a cobrar por unidade</h3>
        <div style={S.legend}>
          <span><span style={{ ...S.dot, background: "#16a34a" }} />Recuperado</span>
          <span><span style={{ ...S.dot, background: "#cbd5e1" }} />A cobrar</span>
        </div>
        {uni.map((x) => (
          <div key={x.unidade} style={S.linha}>
            <div style={S.linhaTopo}>
              <span>{x.unidade}</span>
              <strong>{moeda(x.recuperado)}</strong>
            </div>
            <div style={{ ...S.track, display: "flex" }}>
              <div style={{ height: "100%", width: ((Number(x.recuperado) / maxUni) * 100) + "%", background: "#16a34a" }} />
              <div style={{ height: "100%", width: ((Number(x.a_cobrar) / maxUni) * 100) + "%", background: "#cbd5e1" }} />
            </div>
          </div>
        ))}
      </div>

      <p style={S.rodape}>Números consolidados em tempo real a partir da base do ReATIVA.</p>
    </div>
  );
}

function Hero({ rot, val, cor, destaque }) {
  return (
    <div style={{ ...S.hero, ...(destaque ? S.heroDestaque : {}) }}>
      <span style={{ ...S.heroVal, color: destaque ? "#0b7d54" : cor }}>{val}</span>
      <span style={{ ...S.heroRot, ...(destaque ? { color: "#16a34a" } : {}) }}>{rot}</span>
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
  wrap: { padding: 24, fontFamily: "Inter, system-ui, sans-serif", maxWidth: 1440, margin: "0 auto" },
  head: { marginBottom: 18 },
  h1: { margin: 0, fontSize: 25, color: "#0f172a", fontFamily: "'Sora', Inter, sans-serif", fontWeight: 800, letterSpacing: "-0.02em" },
  sub: { fontSize: 13, color: "#64748b" },
  heroRow: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14, marginBottom: 16 },
  hero: { background: "#fff", border: "1px solid #eef2f6", borderRadius: 16, padding: "18px 20px", display: "flex", flexDirection: "column", gap: 6, boxShadow: "0 1px 3px rgba(15,23,42,0.05)" },
  heroDestaque: { background: "#f0fdf6", border: "1px solid #bdeed4", boxShadow: "0 1px 3px rgba(15,23,42,0.05)" },
  heroVal: { fontSize: 28, fontWeight: 800, lineHeight: 1.1, fontFamily: "'Sora', Inter, sans-serif", letterSpacing: "-0.01em" },
  heroRot: { fontSize: 13, color: "#64748b", fontWeight: 600 },
  statsRow: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 22 },
  stat: { background: "#f8fafc", borderRadius: 12, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 4 },
  statVal: { fontSize: 20, fontWeight: 800, color: "#111827", fontFamily: "'Sora', Inter, sans-serif" },
  statRot: { fontSize: 12, color: "#64748b", fontWeight: 600 },
  card: { background: "#fff", border: "1px solid #eef2f6", borderRadius: 16, padding: 18, marginBottom: 16, boxShadow: "0 1px 3px rgba(15,23,42,0.05)" },
  h3: { margin: "0 0 14px", fontSize: 15, fontWeight: 700, color: "#0f172a", fontFamily: "'Sora', Inter, sans-serif" },
  linha: { marginBottom: 14 },
  linhaTopo: { display: "flex", justifyContent: "space-between", gap: 10, fontSize: 13, color: "#334155", marginBottom: 6 },
  track: { background: "#f1f5f9", borderRadius: 999, height: 14, overflow: "hidden" },
  fill: { height: "100%", borderRadius: 999, background: "linear-gradient(90deg, #16a34a, #22c55e)" },
  legend: { display: "flex", gap: 16, fontSize: 12, color: "#64748b", marginBottom: 10 },
  dot: { display: "inline-block", width: 10, height: 10, borderRadius: 2, marginRight: 4 },
  muted: { color: "#64748b" },
  rodape: { color: "#8a93a3", fontSize: 12, marginTop: 8 },
};
