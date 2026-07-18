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
            <span style={S.selo}>✓ já superamos todo o ano de 2025 — +{moeda(fat.superavit)} ({fat.pct}%)</span>
          ) : null}
        </div>

        <div style={S.fatLado}>
          <div style={S.miniFat}>
            <span style={S.miniRot}>Faturamento 2025 (ano fechado)</span>
            <span style={S.miniVal}>{moeda(fat.hon_2025)}</span>
          </div>
          <div style={S.miniProj}>
            <span style={S.miniRot}>Projeção de fechamento 2026</span>
            <span style={S.miniValProj}>{moeda(proj.projecao_hon_fim_ano)}</span>
            {fatFimPct !== null ? (
              <span style={S.badgeFim}>vamos fechar o ano +{fatFimPct.toFixed(0)}% vs 2025</span>
            ) : null}
          </div>
        </div>
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
                    <td style={S.tdNum}><Delta a={m.rec_2025} b={rec26} /></td>
                    <td style={S.td}>{m.hon_2025 ? moeda(m.hon_2025) : "—"}</td>
                    <td style={futuro ? S.tdProjHon : S.tdHon}>
                      {hon26 ? moeda(hon26) : "—"}
                      {emCurso ? <div style={S.subProj}>projeção do mês: {moeda(m.hon_proj)}</div> : null}
                    </td>
                    <td style={S.tdNum}><Delta a={m.hon_2025} b={hon26} /></td>
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
        <p style={S.rodape}>
          {mesRef} está em curso (dia 1 a {mp.dia_ref}): R$ {Number(mp.rec_2026 || 0).toLocaleString("pt-BR")} recuperado
          contra R$ {Number(mp.rec_2025 || 0).toLocaleString("pt-BR")} no mesmo período de 2025 ({mp.var_rec_pct >= 0 ? "+" : ""}{mp.var_rec_pct}%).
          Por dia útil trabalhado o ritmo é {mp.var_rec_dia_pct >= 0 ? "+" : ""}{mp.var_rec_dia_pct}% em recuperado e{" "}
          {mp.var_hon_dia_pct >= 0 ? "+" : ""}{mp.var_hon_dia_pct}% em faturamento — {mesRef}/2025 teve {mp.dias_uteis_2025} dias
          úteis até o dia {mp.dia_ref} e {mesRef}/2026 tem {mp.dias_uteis_2026}.
          Meses futuros usam o realizado de 2025 corrigido pelo crescimento atual (+{proj.crescimento_rec_pct}% recuperado / +{proj.crescimento_hon_pct}% honorário).
        </p>
      </div>
    </section>
  );
}

const S = {
  wrap: { marginBottom: 26 },
  tituloSecao: { margin: "0 0 12px 0", color: "#334155", fontSize: 14, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em" },

  fatBox: { display: "grid", gridTemplateColumns: "minmax(260px, 1.3fr) minmax(240px, 1fr)", gap: 14, marginBottom: 16 },
  fatPrincipal: { background: "linear-gradient(135deg, #4338ca 0%, #6d28d9 100%)", borderRadius: 16, padding: "22px 24px", display: "flex", flexDirection: "column", gap: 8, color: "#fff", boxShadow: "0 4px 14px rgba(67,56,202,0.25)" },
  fatRot: { fontSize: 13, fontWeight: 700, opacity: 0.85 },
  fatVal: { fontSize: 40, fontWeight: 800, lineHeight: 1.05, letterSpacing: "-0.5px" },
  selo: { marginTop: 4, background: "rgba(255,255,255,0.18)", border: "1px solid rgba(255,255,255,0.35)", borderRadius: 999, padding: "6px 12px", fontSize: 13, fontWeight: 700, alignSelf: "flex-start" },
  fatLado: { display: "flex", flexDirection: "column", gap: 12 },
  miniFat: { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 14, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 4, flex: 1, justifyContent: "center" },
  miniProj: { background: "#fffbeb", border: "2px solid #fcd34d", borderRadius: 14, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 5, flex: 1, justifyContent: "center" },
  miniRot: { fontSize: 12, color: "#64748b", fontWeight: 600 },
  miniVal: { fontSize: 22, fontWeight: 800, color: "#312e81" },
  miniValProj: { fontSize: 26, fontWeight: 800, color: "#b45309", lineHeight: 1.1 },
  badgeFim: { background: "#b45309", color: "#fff", borderRadius: 999, padding: "4px 10px", fontSize: 12, fontWeight: 800, alignSelf: "flex-start" },

  card: { background: "#fff", border: "1px solid #eef2f7", borderRadius: 14, padding: 18, marginBottom: 14, boxShadow: "0 1px 3px rgba(15,23,42,0.06)" },
  h3: { margin: "0 0 14px", fontSize: 15, fontWeight: 700, color: "#0f172a" },
  tabelaWrap: { overflowX: "auto" },
  tabela: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", padding: "8px 10px", color: "#64748b", fontWeight: 700, fontSize: 12, borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap" },
  thNum: { textAlign: "right", padding: "8px 10px", color: "#64748b", fontWeight: 700, fontSize: 12, borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap" },
  trFuturo: { background: "#fcfcfd" },
  tdMes: { padding: "8px 10px", fontWeight: 700, color: "#334155", borderBottom: "1px solid #f1f5f9", whiteSpace: "nowrap" },
  tagProj: { marginLeft: 6, background: "#fef3c7", color: "#92400e", borderRadius: 999, padding: "1px 7px", fontSize: 10, fontWeight: 800 },
  tagCurso: { marginLeft: 6, background: "#dbeafe", color: "#1d4ed8", borderRadius: 999, padding: "1px 7px", fontSize: 10, fontWeight: 800 },
  td: { padding: "8px 10px", textAlign: "right", color: "#64748b", borderBottom: "1px solid #f1f5f9", whiteSpace: "nowrap" },
  tdForte: { padding: "8px 10px", textAlign: "right", color: "#111827", fontWeight: 700, borderBottom: "1px solid #f1f5f9", whiteSpace: "nowrap" },
  tdHon: { padding: "8px 10px", textAlign: "right", color: "#4338ca", fontWeight: 800, borderBottom: "1px solid #f1f5f9", whiteSpace: "nowrap" },
  tdProj: { padding: "8px 10px", textAlign: "right", color: "#92400e", fontWeight: 700, fontStyle: "italic", borderBottom: "1px solid #f1f5f9", whiteSpace: "nowrap" },
  tdProjHon: { padding: "8px 10px", textAlign: "right", color: "#b45309", fontWeight: 800, fontStyle: "italic", borderBottom: "1px solid #f1f5f9", whiteSpace: "nowrap" },
  subProj: { fontSize: 11, color: "#b45309", fontWeight: 600, fontStyle: "italic", marginTop: 2 },
  tdNum: { padding: "8px 10px", textAlign: "right", borderBottom: "1px solid #f1f5f9", whiteSpace: "nowrap" },
  tdTotal: { padding: "10px", textAlign: "right", fontWeight: 800, color: "#0f172a", borderTop: "2px solid #e5e7eb", whiteSpace: "nowrap" },
  tdTotalNum: { padding: "10px", textAlign: "right", borderTop: "2px solid #e5e7eb", whiteSpace: "nowrap" },
  tdFecha: { padding: "10px", textAlign: "right", fontWeight: 800, color: "#b45309", background: "#fffbeb", whiteSpace: "nowrap" },
  pctFim: { background: "#b45309", color: "#fff", borderRadius: 999, padding: "2px 8px", fontSize: 12, fontWeight: 800 },
  muted: { color: "#64748b" },
  rodape: { color: "#64748b", fontSize: 12, marginTop: 12, lineHeight: 1.6 },
};
