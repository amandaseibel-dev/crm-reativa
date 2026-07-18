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
  const fat = d.faturamento || {};
  const mp = d.mesmo_periodo || {};
  const prox = d.proximos_meses || {};
  const mesRef = MESES[mp.mes_ref] || "";

  return (
    <section style={S.wrap}>
      {/* ---------- FATURAMENTO: numero principal ---------- */}
      <h2 style={S.tituloSecao}>Faturamento da ReATIVA (honorários)</h2>

      <div style={S.fatBox}>
        <div style={S.fatPrincipal}>
          <span style={S.fatRot}>Faturamento 2026 até {mp.dia_ref}/{mesRef}</span>
          <span style={S.fatVal}>{moeda(fat.hon_2026)}</span>
          {fat.ja_superou ? (
            <span style={S.selo}>
              ✓ já superamos todo o ano de 2025 — +{moeda(fat.superavit)} ({fat.pct}%)
            </span>
          ) : null}
        </div>

        <div style={S.fatLado}>
          <MiniFat rot="Faturamento 2025 (ano fechado)" val={moeda(fat.hon_2025)} />
          <MiniFat rot="Projeção faturamento fim de 2026" val={moeda(proj.projecao_hon_fim_ano)} destaque />
        </div>
      </div>

      {/* ---------- PROXIMOS 6 MESES: destaque com outra cor ---------- */}
      <div style={S.proxBox}>
        <div style={S.proxHead}>
          <span style={S.proxTitulo}>Média realista para os próximos {prox.meses} meses</span>
          <span style={S.proxBase}>
            base: mesmo período de 2025 + crescimento atual (+{prox.crescimento_rec_pct}% recuperado / +{prox.crescimento_hon_pct}% honorário)
          </span>
        </div>
        <div style={S.proxNums}>
          <div style={S.proxItem}>
            <span style={S.proxVal}>{moeda(prox.hon)}</span>
            <span style={S.proxRot}>Faturamento previsto</span>
          </div>
          <div style={S.proxItem}>
            <span style={{ ...S.proxVal, fontSize: 26, opacity: 0.9 }}>{moeda(prox.rec)}</span>
            <span style={S.proxRot}>Recuperado previsto</span>
          </div>
        </div>
      </div>

      {/* ---------- MESMO PERIODO ---------- */}
      <div style={S.card}>
        <h3 style={S.h3}>{mesRef} no mesmo período (dia 1 a {mp.dia_ref}) — 2025 x 2026</h3>
        <div style={S.mpRow}>
          <MpItem rot={`Recuperado ${mesRef}/2025`} val={moeda(mp.rec_2025)} />
          <MpItem rot={`Recuperado ${mesRef}/2026`} val={moeda(mp.rec_2026)} forte />
          <MpItem rot="Diferença" val={`+${mp.var_rec_pct}%`} cor="#16a34a" />
          <MpItem rot={`Honorário ${mesRef}/2025`} val={moeda(mp.hon_2025)} />
          <MpItem rot={`Honorário ${mesRef}/2026`} val={moeda(mp.hon_2026)} forte />
          <MpItem rot="Diferença" val={`+${mp.var_hon_pct}%`} cor="#16a34a" />
        </div>

        <div style={S.duBox}>
          <div style={S.duHead}>
            <span style={S.duTitulo}>Ritmo por dia útil trabalhado</span>
            <span style={S.duSub}>
              {mesRef}/2025 teve {mp.dias_uteis_2025} dias úteis até o dia {mp.dia_ref} · {mesRef}/2026 tem {mp.dias_uteis_2026}
              {mp.dias_uteis_2026 < mp.dias_uteis_2025
                ? " — ou seja, estamos entregando mais com menos dias"
                : ""}
            </span>
          </div>
          <div style={S.mpRow}>
            <MpItem rot="Recuperado por dia útil — 2025" val={moeda(mp.rec_dia_2025)} />
            <MpItem rot="Recuperado por dia útil — 2026" val={moeda(mp.rec_dia_2026)} forte />
            <MpItem rot="Ritmo recuperado" val={`+${mp.var_rec_dia_pct}%`} cor="#16a34a" />
            <MpItem rot="Honorário por dia útil — 2025" val={moeda(mp.hon_dia_2025)} />
            <MpItem rot="Honorário por dia útil — 2026" val={moeda(mp.hon_dia_2026)} forte />
            <MpItem rot="Ritmo faturamento" val={`+${mp.var_hon_dia_pct}%`} cor="#4338ca" />
          </div>
        </div>
      </div>

      {/* ---------- CONSOLIDADO ---------- */}
      <h2 style={{ ...S.tituloSecao, marginTop: 24 }}>Recuperação — consolidado</h2>
      <div style={S.kpiRow}>
        <Kpi rot="Valor total pago" val={moeda(tg.valor_pago)} cor="#16a34a" destaque />
        <Kpi rot="Honorários acumulados" val={moeda(tg.honorarios)} cor="#4f46e5" />
        <Kpi rot="Alunos pagos (únicos)" val={num(tg.alunos_unicos)} cor="#7c3aed" />
        <Kpi rot="Parcelas pagas" val={num(tg.parcelas)} cor="#d97706" />
      </div>

      <h2 style={{ ...S.tituloSecao, marginTop: 24 }}>Recuperado — 2025 x 2026</h2>
      <div style={S.heroRow}>
        <Hero rot="Recuperado 2025" val={moeda(d.total_2025)} cor="#94a3b8" nota="abr–dez/2025" />
        <Hero rot="Recuperado 2026 (até hoje)" val={moeda(d.total_2026)} cor="#16a34a" nota={`jan–${mesRef}/2026`} />
        <Hero rot="Projeção fim de 2026" val={moeda(proj.projecao_fim_ano)} cor="#7c3aed" nota="2025 + crescimento atual" />
      </div>

      {/* ---------- TABELA MES A MES ---------- */}
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
                  <td style={S.tdHon}>{m.hon_2026 ? moeda(m.hon_2026) : "—"}</td>
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
          Projeções usam o realizado de 2025 nos meses que faltam, corrigido pelo crescimento atual.
        </p>
      </div>
    </section>
  );
}

function MiniFat({ rot, val, destaque }) {
  return (
    <div style={destaque ? S.miniFatDestaque : S.miniFat}>
      <span style={S.miniFatRot}>{rot}</span>
      <span style={S.miniFatVal}>{val}</span>
    </div>
  );
}
function MpItem({ rot, val, forte, cor }) {
  return (
    <div style={S.mpItem}>
      <span style={{ ...S.mpVal, color: cor || (forte ? "#111827" : "#64748b"), fontWeight: forte || cor ? 800 : 700 }}>{val}</span>
      <span style={S.mpRot}>{rot}</span>
    </div>
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

const S = {
  wrap: { marginBottom: 26 },
  tituloSecao: { margin: "0 0 12px 0", color: "#334155", fontSize: 14, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em" },

  fatBox: { display: "grid", gridTemplateColumns: "minmax(260px, 1.4fr) minmax(240px, 1fr)", gap: 14, marginBottom: 16 },
  fatPrincipal: { background: "linear-gradient(135deg, #4338ca 0%, #6d28d9 100%)", borderRadius: 16, padding: "22px 24px", display: "flex", flexDirection: "column", gap: 8, color: "#fff", boxShadow: "0 4px 14px rgba(67,56,202,0.25)" },
  fatRot: { fontSize: 13, fontWeight: 700, opacity: 0.85 },
  fatVal: { fontSize: 40, fontWeight: 800, lineHeight: 1.05, letterSpacing: "-0.5px" },
  selo: { marginTop: 4, background: "rgba(255,255,255,0.18)", border: "1px solid rgba(255,255,255,0.35)", borderRadius: 999, padding: "6px 12px", fontSize: 13, fontWeight: 700, alignSelf: "flex-start" },
  fatLado: { display: "flex", flexDirection: "column", gap: 12 },
  miniFat: { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 14, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 4, flex: 1, justifyContent: "center" },
  miniFatDestaque: { background: "#eef2ff", border: "1px solid #c7d2fe", borderRadius: 14, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 4, flex: 1, justifyContent: "center" },
  miniFatRot: { fontSize: 12, color: "#64748b", fontWeight: 600 },
  miniFatVal: { fontSize: 22, fontWeight: 800, color: "#312e81" },

  proxBox: { background: "#fffbeb", border: "2px solid #fcd34d", borderRadius: 16, padding: "18px 20px", marginBottom: 16 },
  proxHead: { display: "flex", flexDirection: "column", gap: 2, marginBottom: 12 },
  proxTitulo: { fontSize: 15, fontWeight: 800, color: "#92400e" },
  proxBase: { fontSize: 12, color: "#b45309", fontWeight: 600 },
  proxNums: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14 },
  proxItem: { display: "flex", flexDirection: "column", gap: 2 },
  proxVal: { fontSize: 32, fontWeight: 800, color: "#b45309", lineHeight: 1.1 },
  proxRot: { fontSize: 12.5, color: "#92400e", fontWeight: 700 },

  duBox: { marginTop: 16, paddingTop: 14, borderTop: "1px dashed #cbd5e1" },
  duHead: { display: "flex", flexDirection: "column", gap: 2, marginBottom: 10 },
  duTitulo: { fontSize: 14, fontWeight: 800, color: "#0f172a" },
  duSub: { fontSize: 12, color: "#64748b", fontWeight: 600 },
  mpRow: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 },
  mpItem: { background: "#f8fafc", borderRadius: 12, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 3 },
  mpVal: { fontSize: 19, lineHeight: 1.15 },
  mpRot: { fontSize: 11.5, color: "#64748b", fontWeight: 600 },

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

  card: { background: "#fff", border: "1px solid #eef2f7", borderRadius: 14, padding: 18, marginBottom: 14, boxShadow: "0 1px 3px rgba(15,23,42,0.06)" },
  h3: { margin: "0 0 14px", fontSize: 15, fontWeight: 700, color: "#0f172a" },
  tabelaWrap: { overflowX: "auto" },
  tabela: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", padding: "8px 10px", color: "#64748b", fontWeight: 700, fontSize: 12, borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap" },
  thNum: { textAlign: "right", padding: "8px 10px", color: "#64748b", fontWeight: 700, fontSize: 12, borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap" },
  tdMes: { padding: "8px 10px", fontWeight: 700, color: "#334155", borderBottom: "1px solid #f1f5f9" },
  td: { padding: "8px 10px", textAlign: "right", color: "#64748b", borderBottom: "1px solid #f1f5f9", whiteSpace: "nowrap" },
  tdForte: { padding: "8px 10px", textAlign: "right", color: "#111827", fontWeight: 700, borderBottom: "1px solid #f1f5f9", whiteSpace: "nowrap" },
  tdHon: { padding: "8px 10px", textAlign: "right", color: "#4338ca", fontWeight: 800, borderBottom: "1px solid #f1f5f9", whiteSpace: "nowrap" },
  tdNum: { padding: "8px 10px", textAlign: "right", borderBottom: "1px solid #f1f5f9", whiteSpace: "nowrap" },
  tdTotal: { padding: "10px", textAlign: "right", fontWeight: 800, color: "#0f172a", borderTop: "2px solid #e5e7eb", whiteSpace: "nowrap" },
  tdTotalNum: { padding: "10px", textAlign: "right", borderTop: "2px solid #e5e7eb", whiteSpace: "nowrap" },
  muted: { color: "#64748b" },
  rodape: { color: "#8a93a3", fontSize: 12, marginTop: 10 },
};
