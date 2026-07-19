import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

function moeda(v) {
  return Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
}
function pct(a, b) {
  const va = Number(a) || 0;
  const vb = Number(b) || 0;
  if (!va) return null;
  return ((vb - va) / va) * 100;
}
const MESES = ["", "Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];

function Delta({ a, b }) {
  const p = pct(a, b);
  if (p === null || !Number(b)) return <span style={{ color: "#cbd5e1" }}>—</span>;
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

  if (carregando) return <section style={S.wrap}><p style={S.muted}>Carregando comparativo...</p></section>;
  if (!d) return null;

  const meses = d.por_mes || [];
  const proj = d.projecao_2026 || {};
  const fat = d.faturamento || {};
  const mp = d.mesmo_periodo || {};
  const mesRef = MESES[mp.mes_ref] || "";
  const fatFimPct = pct(fat.hon_2025, proj.projecao_hon_fim_ano);
  const recFimPct = pct(d.total_2025, proj.projecao_fim_ano);

  return (
    <section style={S.wrap}>
      <h2 style={S.tituloSecao}>Faturamento da ReATIVA (honorários)</h2>

      <div style={S.fatBox}>
        <div style={S.fatPrincipal}>
          <span style={S.fatRot}>Faturamento 2026 até {mp.dia_ref}/{mesRef}</span>
          <span style={S.fatVal}>{moeda(fat.hon_2026)}</span>
          {fat.ja_superou ? (
            <span style={S.selo}>já superamos 2025 · +{moeda(fat.superavit)} ({fat.pct}%)</span>
          ) : null}
        </div>

        <>
          <div style={S.miniFat}>
            <span style={S.miniRot}>Faturamento 2025 (ano fechado)</span>
            <span style={S.miniVal}>{moeda(fat.hon_2025)}</span>
          </div>
          <div style={S.miniProj}>
            <span style={S.miniRot}>Projeção de fechamento do ano</span>
            <span style={S.miniValProj}>{moeda(proj.projecao_hon_fim_ano)}</span>
            {fatFimPct !== null ? (
              <span style={S.badgeFim}>vamos fechar 2026 +{fatFimPct.toFixed(0)}% vs 2025</span>
            ) : null}
          </div>
        </>
      </div>

      <div style={S.card}>
        <h3 style={S.h3}>Mês a mês — realizado e projetado</h3>
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
              {meses.map((m) => {
                const futuro = m.futuro;
                const emCurso = m.em_curso;
                const rec26 = futuro ? m.rec_proj : m.rec_2026;
                const hon26 = futuro ? m.hon_proj : m.hon_2026;
                return (
                  <tr key={m.mes} style={futuro ? S.trFuturo : null}>
                    <td style={S.tdMes}>
                      {MESES[m.mes]}
                      {futuro ? <span style={S.tagProj}>projetado</span> : null}
                      {emCurso ? <span style={S.tagCurso}>em curso</span> : null}
                    </td>
                    <td style={S.td}>{m.rec_2025 ? moeda(m.rec_2025) : "—"}</td>
                    <td style={futuro ? S.tdProj : S.tdForte}>
                      {rec26 ? moeda(rec26) : "—"}
                      {emCurso ? <div style={S.subProj}>projeção do mês: {moeda(m.rec_proj)}</div> : null}
                    </td>
                    <td style={S.tdNum}>
                      {emCurso ? (
                        <span style={S.deltaDia}>
                          {mp.var_rec_dia_pct >= 0 ? "+" : ""}{mp.var_rec_dia_pct}%
                          <span style={S.porDia}>por dia util</span>
                        </span>
                      ) : (
                        <Delta a={m.rec_2025} b={rec26} />
                      )}
                    </td>
                    <td style={S.td}>{m.hon_2025 ? moeda(m.hon_2025) : "—"}</td>
                    <td style={futuro ? S.tdProjHon : S.tdHon}>
                      {hon26 ? moeda(hon26) : "—"}
                      {emCurso ? <div style={S.subProj}>projeção do mês: {moeda(m.hon_proj)}</div> : null}
                    </td>
                    <td style={S.tdNum}>
                      {emCurso ? (
                        <span style={S.deltaDia}>
                          {mp.var_hon_dia_pct >= 0 ? "+" : ""}{mp.var_hon_dia_pct}%
                          <span style={S.porDia}>por dia util</span>
                        </span>
                      ) : (
                        <Delta a={m.hon_2025} b={hon26} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td style={S.tdTotal}>Realizado até hoje</td>
                <td style={S.tdTotal}>{moeda(d.total_2025)}</td>
                <td style={S.tdTotal}>{moeda(d.total_2026)}</td>
                <td style={S.tdTotalNum}><Delta a={d.total_2025} b={d.total_2026} /></td>
                <td style={S.tdTotal}>{moeda(d.honorarios_2025)}</td>
                <td style={S.tdTotal}>{moeda(d.honorarios_2026)}</td>
                <td style={S.tdTotalNum}><Delta a={d.honorarios_2025} b={d.honorarios_2026} /></td>
              </tr>
              <tr>
                <td style={S.tdFecha}>Fechamento projetado 2026</td>
                <td style={S.tdFecha}>{moeda(d.total_2025)}</td>
                <td style={S.tdFecha}>{moeda(proj.projecao_fim_ano)}</td>
                <td style={S.tdFecha}>
                  {recFimPct !== null ? <span style={S.pctFim}>+{recFimPct.toFixed(0)}%</span> : "—"}
                </td>
                <td style={S.tdFecha}>{moeda(fat.hon_2025)}</td>
                <td style={S.tdFecha}>{moeda(proj.projecao_hon_fim_ano)}</td>
                <td style={S.tdFecha}>
                  {fatFimPct !== null ? <span style={S.pctFim}>+{fatFimPct.toFixed(0)}%</span> : "—"}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
        <div style={S.ritmoRow}>
          <div style={S.ritmoItem}>
            <span style={S.ritmoVal}>{moeda(mp.rec_dia_2026)}</span>
            <span style={S.ritmoRot}>Recuperado / dia útil · 2025: {moeda(mp.rec_dia_2025)}</span>
          </div>
          <div style={S.ritmoItem}>
            <span style={S.ritmoPct}>{mp.var_rec_dia_pct >= 0 ? "+" : ""}{mp.var_rec_dia_pct}%</span>
            <span style={S.ritmoRot}>Ritmo recuperado</span>
          </div>
          <div style={S.ritmoItem}>
            <span style={S.ritmoVal}>{moeda(mp.hon_dia_2026)}</span>
            <span style={S.ritmoRot}>Honorário / dia útil · 2025: {moeda(mp.hon_dia_2025)}</span>
          </div>
          <div style={S.ritmoItem}>
            <span style={S.ritmoPct}>{mp.var_hon_dia_pct >= 0 ? "+" : ""}{mp.var_hon_dia_pct}%</span>
            <span style={S.ritmoRot}>Ritmo faturamento</span>
          </div>
        </div>
      </div>
    </section>
  );
}

const S = {
  wrap: { marginBottom: 26 },
  tituloSecao: { margin: "0 0 12px 0", color: "#334155", fontSize: 14, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em" },

  fatBox: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 12, marginBottom: 16 },
  fatPrincipal: { background: "#fff", border: "1px solid #e5e7eb", borderLeft: "4px solid #1e40af", borderRadius: 14, padding: "16px 18px", display: "flex", flexDirection: "column", gap: 6, boxShadow: "0 1px 3px rgba(15,23,42,0.06)" },
  fatRot: { fontSize: 12, fontWeight: 600, color: "#64748b" },
  fatVal: { fontSize: 26, fontWeight: 800, lineHeight: 1.1, color: "#0f172a" },
  selo: { marginTop: 2, color: "#16a34a", fontSize: 12, fontWeight: 700 },
  fatLado: { display: "flex", flexDirection: "column", gap: 12 },
  miniFat: { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 14, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 4, flex: 1, justifyContent: "center" },
  miniProj: { background: "#fff", border: "1px solid #e5e7eb", borderLeft: "4px solid #b45309", borderRadius: 14, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 4, flex: 1, justifyContent: "center" },
  miniRot: { fontSize: 12, color: "#64748b", fontWeight: 600 },
  miniVal: { fontSize: 22, fontWeight: 800, color: "#0f172a" },
  miniValProj: { fontSize: 22, fontWeight: 800, color: "#b45309", lineHeight: 1.1 },
  badgeFim: { color: "#b45309", fontSize: 12, fontWeight: 700 },

  card: { background: "#fff", border: "1px solid #eef2f7", borderRadius: 14, padding: 18, marginBottom: 14, boxShadow: "0 1px 3px rgba(15,23,42,0.06)" },
  h3: { margin: "0 0 14px", fontSize: 15, fontWeight: 700, color: "#0f172a" },
  tabelaWrap: { overflowX: "auto" },
  tabela: { width: "100%", borderCollapse: "collapse", fontSize: 12.5, tableLayout: "auto" },
  th: { textAlign: "left", padding: "7px 8px", color: "#64748b", fontWeight: 700, fontSize: 12, borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap" },
  thNum: { textAlign: "right", padding: "7px 8px", color: "#64748b", fontWeight: 700, fontSize: 12, borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap" },
  trFuturo: { background: "#fcfcfd" },
  tdMes: { padding: "7px 8px", fontWeight: 700, color: "#334155", borderBottom: "1px solid #f1f5f9", whiteSpace: "nowrap" },
  tagProj: { marginLeft: 6, background: "#fef3c7", color: "#b45309", borderRadius: 999, padding: "1px 7px", fontSize: 10, fontWeight: 800 },
  tagCurso: { marginLeft: 6, background: "#eff6ff", color: "#1e40af", borderRadius: 999, padding: "1px 7px", fontSize: 10, fontWeight: 800 },
  td: { padding: "7px 8px", textAlign: "right", color: "#64748b", borderBottom: "1px solid #f1f5f9", whiteSpace: "nowrap" },
  tdForte: { padding: "7px 8px", textAlign: "right", color: "#111827", fontWeight: 700, borderBottom: "1px solid #f1f5f9", whiteSpace: "nowrap" },
  tdHon: { padding: "7px 8px", textAlign: "right", color: "#1e40af", fontWeight: 800, borderBottom: "1px solid #f1f5f9", whiteSpace: "nowrap" },
  tdProj: { padding: "7px 8px", textAlign: "right", color: "#b45309", fontWeight: 700, fontStyle: "italic", borderBottom: "1px solid #f1f5f9", whiteSpace: "nowrap" },
  tdProjHon: { padding: "7px 8px", textAlign: "right", color: "#b45309", fontWeight: 800, fontStyle: "italic", borderBottom: "1px solid #f1f5f9", whiteSpace: "nowrap" },
  subProj: { fontSize: 11, color: "#b45309", fontWeight: 600, fontStyle: "italic", marginTop: 2 },
  tdNum: { padding: "7px 8px", textAlign: "right", borderBottom: "1px solid #f1f5f9", whiteSpace: "nowrap" },
  tdTotal: { padding: "9px 8px", textAlign: "right", fontWeight: 800, color: "#0f172a", borderTop: "2px solid #e5e7eb", whiteSpace: "nowrap" },
  tdTotalNum: { padding: "9px 8px", textAlign: "right", borderTop: "2px solid #e5e7eb", whiteSpace: "nowrap" },
  tdFecha: { padding: "9px 8px", textAlign: "right", fontWeight: 800, color: "#b45309", background: "#fffbeb", whiteSpace: "nowrap" },
  pctFim: { background: "#fef3c7", color: "#b45309", borderRadius: 999, padding: "2px 9px", fontSize: 12, fontWeight: 800 },
  deltaDia: { display: "inline-flex", flexDirection: "column", alignItems: "flex-end", color: "#16a34a", fontWeight: 700 },
  porDia: { fontSize: 10, color: "#94a3b8", fontWeight: 600 },
  ritmoRow: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12, marginTop: 14, paddingTop: 14, borderTop: "1px dashed #cbd5e1" },
  ritmoItem: { display: "flex", flexDirection: "column", gap: 2 },
  ritmoVal: { fontSize: 19, fontWeight: 800, color: "#111827" },
  ritmoPct: { fontSize: 19, fontWeight: 800, color: "#16a34a" },
  ritmoRot: { fontSize: 11.5, color: "#64748b", fontWeight: 600 },
  muted: { color: "#64748b" },
};
