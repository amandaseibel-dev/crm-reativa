import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

function moeda(v) {
  return Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
}
function num(v) {
  return Number(v || 0).toLocaleString("pt-BR");
}
const MESES = ["", "Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];

function Variacao({ a, b }) {
  const va = Number(a) || 0;
  const vb = Number(b) || 0;
  if (!va && !vb) return <span style={{ color: "#cbd5e1" }}>—</span>;
  if (!va) return <span style={{ color: "#16a34a", fontWeight: 700 }}>novo</span>;
  if (!vb) return <span style={{ color: "#cbd5e1" }}>—</span>;
  const p = ((vb - va) / va) * 100;
  return (
    <span style={{ color: p >= 0 ? "#16a34a" : "#dc2626", fontWeight: 700 }}>
      {(p >= 0 ? "+" : "") + p.toFixed(0) + "%"}
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
        <h3 style={S.h3}>Mês a mês — pagamento e honorário</h3>
        <div style={S.tabelaWrap}>
          <table style={S.tabela}>
            <thead>
              <tr>
                <th style={S.th}>Mês</th>
                <th style={S.thNum}>Pago 2025</th>
                <th style={S.thNum}>Pago 2026</th>
                <th style={S.thNum}>Δ pago</th>
                <th style={S.thNum}>Honorário 2025</th>
                <th style={S.thNum}>Honorário 2026</th>
                <th style={S.thNum}>Δ honorário</th>
              </tr>
            </thead>
            <tbody>
              {meses.map((m) => (
                <tr key={m.mes}>
                  <td style={S.tdMes}>{MESES[m.mes]}</td>
                  <td style={S.td}>{m.rec_2025 ? moeda(m.rec_2025) : "—"}</td>
                  <td style={S.tdForte}>{m.rec_2026 ? moeda(m.rec_2026) : "—"}</td>
                  <td style={S.tdNum}><Variacao a={m.rec_2025} b={m.rec_2026} /></td>
                  <td style={S.td}>{m.hon_2025 ? moeda(m.hon_2025) : "—"}</td>
                  <td style={S.tdForte}>{m.hon_2026 ? moeda(m.hon_2026) : "—"}</td>
                  <td style={S.tdNum}><Variacao a={m.hon_2025} b={m.hon_2026} /></td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td style={S.tdTotal}>Total</td>
                <td style={S.tdTotal}>{moeda(d.total_2025)}</td>
                <td style={S.tdTotal}>{moeda(d.total_2026)}</td>
                <td style={S.tdTotalNum}><Variacao a={d.total_2025} b={d.total_2026} /></td>
                <td style={S.tdTotal}>{moeda(d.honorarios_2025)}</td>
                <td style={S.tdTotal}>{moeda(d.honorarios_2026)}</td>
                <td style={S.tdTotalNum}><Variacao a={d.honorarios_2025} b={d.honorarios_2026} /></td>
              </tr>
            </tfoot>
          </table>
        </div>
        <p style={S.rodape}>
          Δ compara o mesmo mês de 2026 contra 2025. "novo" indica mês sem operação em 2025.
        </p>
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
  tabelaWrap: { overflowX: "auto" },
  tabela: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", padding: "8px 10px", color: "#64748b", fontWeight: 700, fontSize: 12, borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap" },
  thNum: { textAlign: "right", padding: "8px 10px", color: "#64748b", fontWeight: 700, fontSize: 12, borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap" },
  tdMes: { padding: "8px 10px", fontWeight: 700, color: "#334155", borderBottom: "1px solid #f1f5f9" },
  td: { padding: "8px 10px", textAlign: "right", color: "#64748b", borderBottom: "1px solid #f1f5f9", whiteSpace: "nowrap" },
  tdForte: { padding: "8px 10px", textAlign: "right", color: "#111827", fontWeight: 700, borderBottom: "1px solid #f1f5f9", whiteSpace: "nowrap" },
  tdNum: { padding: "8px 10px", textAlign: "right", borderBottom: "1px solid #f1f5f9", whiteSpace: "nowrap" },
  tdTotal: { padding: "10px", textAlign: "right", fontWeight: 800, color: "#0f172a", borderTop: "2px solid #e5e7eb", whiteSpace: "nowrap" },
  tdTotalNum: { padding: "10px", textAlign: "right", borderTop: "2px solid #e5e7eb", whiteSpace: "nowrap" },
  muted: { color: "#64748b" },
  rodape: { color: "#8a93a3", fontSize: 12, marginTop: 10 },
};
