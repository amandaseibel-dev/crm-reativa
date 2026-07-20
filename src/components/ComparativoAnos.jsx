import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

function moeda(v) {
  return Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
}
function num(v) {
  return Number(v || 0).toLocaleString("pt-BR");
}
const MESES = ["", "Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];

function Badge({ a, b }) {
  const va = Number(a) || 0;
  const vb = Number(b) || 0;
  if (!va && !vb) return null;
  if (!va) return <span style={{ ...S.badge, color: "#15803d", background: "#f0fdf4", border: "1px solid #bbf7d0" }}>novo</span>;
  if (!vb) return null;
  const p = ((vb - va) / va) * 100;
  const pos = p >= 0;
  return (
    <span style={{ ...S.badge, color: pos ? "#15803d" : "#b91c1c", background: pos ? "#f0fdf4" : "#fef2f2", border: "1px solid " + (pos ? "#bbf7d0" : "#fecaca") }}>
      {(pos ? "+" : "") + p.toFixed(0) + "%"}
    </span>
  );
}

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
  const proj = d.projecao_2026 || {};
  const tg = d.totais_gerais || {};
  const projVs2025 = d.total_2025 > 0 ? ((proj.projecao_fim_ano - d.total_2025) / d.total_2025) * 100 : 0;
  const mesRef = MESES[proj.mes_ref] || "";

  return (
    <section style={S.wrap}>
      <h2 style={S.tituloSecao}>Recuperação · consolidado</h2>
      <div style={S.kpiRow}>
        <Kpi rot="Valor total pago" val={moeda(tg.valor_pago)} cor="#16a34a" destaque />
        <Kpi rot="Honorários" val={moeda(tg.honorarios)} cor="#4338ca" />
        <Kpi rot="Alunos pagos (únicos)" val={num(tg.alunos_unicos)} cor="#64748b" />
        <Kpi rot="Parcelas pagas" val={num(tg.parcelas)} cor="#64748b" />
      </div>

      <h2 style={{ ...S.tituloSecao, marginTop: 26 }}>Recuperação · 2025 × 2026</h2>

      <div style={S.heroRow}>
        <Hero rot="Recuperado 2025" val={moeda(d.total_2025)} cor="#334155" nota="abr–dez / 2025" />
        <Hero rot={"Recuperado 2026 · até " + proj.dia_ref + "/" + mesRef} val={moeda(d.total_2026)} cor="#1e1b4b" destaque />
        <Hero rot="Projeção de fechamento 2026" val={moeda(proj.projecao_fim_ano)} cor="#334155"
              nota={(projVs2025 >= 0 ? "+" : "") + projVs2025.toFixed(0) + "% vs 2025"} notaCor="#4338ca" />
      </div>

      <div style={S.card}>
        <div style={S.tabelaWrap}>
          <table style={S.tabela}>
            <thead>
              <tr>
                <th style={S.th}>Mês</th>
                <th style={S.thNum}>Pago 2025</th>
                <th style={S.thNum}>Pago 2026</th>
                <th style={S.thNum}>Honorário 2025</th>
                <th style={S.thNum}>Honorário 2026</th>
              </tr>
            </thead>
            <tbody>
              {meses.map((m, i) => (
                <tr key={m.mes} style={i % 2 ? S.trZebra : null}>
                  <td style={S.tdMes}>{MESES[m.mes]}</td>
                  <td style={S.td}>{m.rec_2025 ? moeda(m.rec_2025) : "—"}</td>
                  <td style={S.tdDestaque}>
                    <span style={S.valForte}>{m.rec_2026 ? moeda(m.rec_2026) : "—"}</span>
                    <Badge a={m.rec_2025} b={m.rec_2026} />
                  </td>
                  <td style={S.td}>{m.hon_2025 ? moeda(m.hon_2025) : "—"}</td>
                  <td style={S.tdDestaque}>
                    <span style={S.valHon}>{m.hon_2026 ? moeda(m.hon_2026) : "—"}</span>
                    <Badge a={m.hon_2025} b={m.hon_2026} />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td style={S.tdTotal}>Total</td>
                <td style={S.tdTotal}>{moeda(d.total_2025)}</td>
                <td style={S.tdTotal}><span style={S.valForte}>{moeda(d.total_2026)}</span> <Badge a={d.total_2025} b={d.total_2026} /></td>
                <td style={S.tdTotal}>{moeda(d.honorarios_2025)}</td>
                <td style={S.tdTotal}><span style={S.valHon}>{moeda(d.honorarios_2026)}</span> <Badge a={d.honorarios_2025} b={d.honorarios_2026} /></td>
              </tr>
            </tfoot>
          </table>
        </div>
        <p style={S.rodape}>
          O % ao lado de 2026 compara o mesmo mês contra 2025. "novo" indica mês sem operação em 2025.
        </p>
      </div>

      <div style={S.projBox}>
        <span style={S.projRot}>Como chegamos na projeção de {moeda(proj.projecao_fim_ano)}</span>
        <div style={S.statsRow}>
          <Stat rot={"Realizado até " + proj.dia_ref + "/" + mesRef} val={moeda(proj.realizado_ate_hoje)} />
          <Stat rot="Média mensal (2026)" val={moeda(proj.media_mensal)} />
          <Stat rot={mesRef + " projetado (mês cheio)"} val={moeda(proj.mes_atual_projetado)} />
        </div>
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
        <span style={{ ...S.kpiVal, color: destaque ? cor : "#0f172a", fontSize: destaque ? 26 : 22 }}>{val}</span>
      </div>
    </div>
  );
}

function Hero({ rot, val, cor, nota, notaCor, destaque }) {
  return (
    <div style={destaque ? S.heroDestaque : S.hero}>
      <span style={S.heroRot}>{rot}</span>
      <span style={{ ...S.heroVal, color: cor, fontSize: destaque ? 30 : 24 }}>{val}</span>
      {nota ? <span style={{ ...S.heroNota, color: notaCor || "#94a3b8" }}>{nota}</span> : null}
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
  tituloSecao: { margin: "0 0 14px 0", color: "#94a3b8", fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" },

  kpiRow: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 14 },
  kpi: { background: "#fff", borderRadius: 16, boxShadow: "0 1px 2px rgba(15,23,42,0.04)", border: "1px solid #eef1f6", overflow: "hidden", display: "flex" },
  kpiFaixa: { width: 3, flexShrink: 0 },
  kpiCorpo: { padding: "16px 18px", flex: 1, display: "flex", flexDirection: "column", gap: 6 },
  kpiRot: { fontSize: 12, color: "#94a3b8", fontWeight: 600 },
  kpiVal: { fontWeight: 800, lineHeight: 1.05, letterSpacing: "-0.02em" },

  heroRow: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14, marginBottom: 16 },
  hero: { background: "#fafbfc", border: "1px solid #eef1f6", borderRadius: 18, padding: "18px 20px", display: "flex", flexDirection: "column", gap: 5 },
  heroDestaque: { background: "#fff", border: "1px solid #eef1f6", borderRadius: 18, padding: "18px 20px", display: "flex", flexDirection: "column", gap: 5, boxShadow: "0 1px 2px rgba(15,23,42,0.04)" },
  heroVal: { fontWeight: 800, lineHeight: 1.05, letterSpacing: "-0.02em" },
  heroRot: { fontSize: 12, color: "#94a3b8", fontWeight: 600 },
  heroNota: { fontSize: 12.5, fontWeight: 700 },

  card: { background: "#fff", border: "1px solid #eef1f6", borderRadius: 18, padding: "8px 10px 4px", marginBottom: 16, boxShadow: "0 1px 2px rgba(15,23,42,0.04)" },
  tabelaWrap: { overflowX: "auto" },
  tabela: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", padding: "12px 14px", color: "#94a3b8", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", whiteSpace: "nowrap" },
  thNum: { textAlign: "right", padding: "12px 14px", color: "#94a3b8", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", whiteSpace: "nowrap" },
  trZebra: { background: "#fbfcfe" },
  tdMes: { padding: "11px 14px", fontWeight: 700, color: "#334155", whiteSpace: "nowrap" },
  td: { padding: "11px 14px", textAlign: "right", color: "#94a3b8", whiteSpace: "nowrap" },
  tdDestaque: { padding: "11px 14px", textAlign: "right", whiteSpace: "nowrap" },
  valForte: { color: "#0f172a", fontWeight: 700 },
  valHon: { color: "#4338ca", fontWeight: 700 },
  badge: { marginLeft: 8, borderRadius: 999, padding: "1px 8px", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" },
  tdTotal: { padding: "13px 14px", textAlign: "right", fontWeight: 800, color: "#0f172a", borderTop: "1px solid #eef1f6", whiteSpace: "nowrap" },
  rodape: { color: "#94a3b8", fontSize: 11.5, margin: "8px 14px 10px" },

  projBox: { background: "#fafbfc", border: "1px solid #eef1f6", borderRadius: 18, padding: "16px 18px" },
  projRot: { fontSize: 12.5, color: "#64748b", fontWeight: 700 },
  statsRow: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12, marginTop: 12 },
  stat: { background: "#fff", border: "1px solid #eef1f6", borderRadius: 14, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 3 },
  statVal: { fontSize: 19, fontWeight: 800, color: "#0f172a", letterSpacing: "-0.02em" },
  statRot: { fontSize: 12, color: "#94a3b8", fontWeight: 600 },
  muted: { color: "#94a3b8" },
};
