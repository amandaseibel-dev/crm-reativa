import { useAnaliticaSobDemanda } from "../hooks/useAnaliticaSobDemanda";
import BotaoAtualizar from "./BotaoAtualizar";

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
  if (!va) return <span style={{ color: "var(--rv-verde-ok)", fontWeight: 700 }}>novo</span>;
  if (!vb) return <span style={{ color: "#cbd5e1" }}>—</span>;
  const p = ((vb - va) / va) * 100;
  return (
    <span style={{ color: p >= 0 ? "var(--rv-verde-ok)" : "var(--rv-vermelho)", fontWeight: 700 }}>
      {(p >= 0 ? "+" : "") + p.toFixed(0) + "%"}
    </span>
  );
}

export default function ComparativoAnos() {
  // SOB DEMANDA: sem auto-load/polling. Só roda no clique do botão Atualizar.
  const { data: d, carregando, erro, ultimaEm, atualizar, jaRodou } =
    useAnaliticaSobDemanda("dashboard_ano_vs_ano");

  const barra = (
    <div style={{ marginBottom: 14 }}>
      <BotaoAtualizar carregando={carregando} ultimaEm={ultimaEm} onClick={atualizar} rotulo="Atualizar comparativo" />
    </div>
  );

  if (!jaRodou || !d) {
    return (
      <section style={S.wrap}>
        {barra}
        <p style={S.muted}>{erro || "Clique em Atualizar para carregar o comparativo 2025 × 2026."}</p>
      </section>
    );
  }

  const meses = d.por_mes || [];
  const proj = d.projecao_2026 || {};
  const tg = d.totais_gerais || {};
  const projVs2025 = d.total_2025 > 0 ? ((proj.projecao_fim_ano - d.total_2025) / d.total_2025) * 100 : 0;

  return (
    <section style={S.wrap}>
      {barra}
      <h2 style={S.tituloSecao}>Recuperação — consolidado</h2>
      <div style={S.kpiRow}>
        <Kpi rot="Valor total pago" val={moeda(tg.valor_pago)} cor="var(--rv-verde-ok)" destaque />
        <Kpi rot="Honorários" val={moeda(tg.honorarios)} cor="var(--rv-azul)" />
        <Kpi rot="Alunos pagos (únicos)" val={num(tg.alunos_unicos)} cor="var(--rv-roxo)" />
        <Kpi rot="Parcelas pagas" val={num(tg.parcelas)} cor="var(--rv-ambar)" />
      </div>

      <h2 style={{ ...S.tituloSecao, marginTop: 24 }}>Recuperação — 2025 x 2026</h2>

      <div style={S.heroRow}>
        <Hero rot="Recuperado 2025 (fechado)" val={moeda(d.total_2025)} cor="var(--rv-tinta)" destaque nota="abr–dez/2025 · realizado" />
        <Hero rot="Recuperado 2026 (até hoje)" val={moeda(d.total_2026)} cor="var(--rv-verde-ok)"
              nota={`jan–${MESES[proj.mes_ref]}/2026 · realizado`} />
        <Hero rot="Projeção fim de 2026" val={moeda(proj.projecao_fim_ano)} cor="var(--rv-roxo)" projetado
              nota={projVs2025 >= 0 ? `+${projVs2025.toFixed(0)}% vs 2025` : `${projVs2025.toFixed(0)}% vs 2025`} />
      </div>

      <div style={S.card}>
        <h3 style={S.h3}>Mês a mês — realizado e projeção dos próximos meses</h3>
        <div style={S.legenda}>
          <span><span style={{ ...S.dot, background: "#111827" }} /> realizado</span>
          <span><span style={{ ...S.dot, background: "#7c3aed" }} /> projetado</span>
        </div>
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
                      {emCurso ? <div style={S.subProj}>proj. do mês: {moeda(m.rec_proj)}</div> : null}
                    </td>
                    <td style={S.tdNum}><Variacao a={m.rec_2025} b={rec26} /></td>
                    <td style={S.td}>{m.hon_2025 ? moeda(m.hon_2025) : "—"}</td>
                    <td style={futuro ? S.tdProj : S.tdForte}>
                      {hon26 ? moeda(hon26) : "—"}
                      {emCurso ? <div style={S.subProj}>proj. do mês: {moeda(m.hon_proj)}</div> : null}
                    </td>
                    <td style={S.tdNum}><Variacao a={m.hon_2025} b={hon26} /></td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td style={S.tdTotal}>Realizado até hoje</td>
                <td style={S.tdTotal}>{moeda(d.total_2025)}</td>
                <td style={S.tdTotal}>{moeda(d.total_2026)}</td>
                <td style={S.tdTotalNum}><Variacao a={d.total_2025} b={d.total_2026} /></td>
                <td style={S.tdTotal}>{moeda(d.honorarios_2025)}</td>
                <td style={S.tdTotal}>{moeda(d.honorarios_2026)}</td>
                <td style={S.tdTotalNum}><Variacao a={d.honorarios_2025} b={d.honorarios_2026} /></td>
              </tr>
              <tr>
                <td style={S.tdFecha}>Projeção fim de 2026</td>
                <td style={S.tdFecha}>{moeda(d.total_2025)}</td>
                <td style={S.tdFecha}>{moeda(proj.projecao_fim_ano)}</td>
                <td style={S.tdFecha}>{projVs2025 >= 0 ? "+" : ""}{projVs2025.toFixed(0)}%</td>
                <td style={S.tdFecha}>{moeda(d.honorarios_2025)}</td>
                <td style={S.tdFecha}>{moeda(proj.projecao_hon_fim_ano)}</td>
                <td style={S.tdFecha}>—</td>
              </tr>
            </tfoot>
          </table>
        </div>
        <p style={S.rodape}>
          Meses futuros (roxo) mostram a <strong>projeção</strong> pelo ritmo de 2026. Δ compara o mesmo mês contra 2025. "novo" = mês sem operação em 2025.
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
        <span style={{ ...S.kpiVal, color: destaque ? cor : "var(--rv-tinta)", fontSize: destaque ? 28 : 24 }}>{val}</span>
      </div>
    </div>
  );
}

function Hero({ rot, val, cor, nota, destaque, projetado }) {
  return (
    <div style={{ ...S.hero, ...(destaque ? S.heroDestaque : {}), ...(projetado ? S.heroProj : {}) }}>
      <span style={{ ...S.heroVal, color: cor }}>{val}</span>
      <span style={S.heroRot}>{rot}</span>
      {nota ? <span style={{ ...S.heroNota, ...(projetado ? { color: "var(--rv-roxo)" } : {}) }}>{nota}</span> : null}
    </div>
  );
}

const S = {
  wrap: { marginBottom: 26 },
  tituloSecao: { margin: "0 0 12px 0", color: "var(--rv-texto-forte)", fontSize: 14, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em" },
  kpiRow: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14, marginBottom: 6 },
  kpi: { background: "var(--rv-superficie)", borderRadius: 14, boxShadow: "0 1px 3px rgba(15,23,42,0.06)", border: "1px solid var(--rv-borda-suave)", overflow: "hidden", display: "flex" },
  kpiFaixa: { width: 4, flexShrink: 0 },
  kpiCorpo: { padding: "16px 18px", flex: 1, display: "flex", flexDirection: "column", gap: 8 },
  kpiRot: { fontSize: 12.5, color: "var(--rv-texto-suave)", fontWeight: 600 },
  kpiVal: { fontWeight: 800, lineHeight: 1.1 },
  heroRow: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14, marginBottom: 14 },
  hero: { background: "var(--rv-superficie)", border: "1px solid var(--rv-borda-suave)", borderRadius: 14, padding: "16px 18px", display: "flex", flexDirection: "column", gap: 4, boxShadow: "0 1px 3px rgba(15,23,42,0.06)" },
  heroDestaque: { background: "var(--rv-fundo-cartao)", border: "1px solid var(--rv-borda-forte)" },
  heroProj: { background: "var(--rv-roxo-fundo)", border: "1px solid var(--rv-roxo-borda)" },
  heroVal: { fontSize: 26, fontWeight: 800, lineHeight: 1.1 },
  heroRot: { fontSize: 12.5, color: "var(--rv-texto-suave)", fontWeight: 600 },
  heroNota: { fontSize: 12, color: "var(--rv-texto-fraco)", fontWeight: 600 },
  card: { background: "var(--rv-superficie)", border: "1px solid var(--rv-borda-suave)", borderRadius: 14, padding: 18, marginBottom: 14, boxShadow: "0 1px 3px rgba(15,23,42,0.06)" },
  h3: { margin: "0 0 8px", fontSize: 15, fontWeight: 700, color: "var(--rv-tinta)" },
  legenda: { display: "flex", gap: 18, fontSize: 12, color: "var(--rv-texto-suave)", marginBottom: 12, fontWeight: 600 },
  dot: { display: "inline-block", width: 10, height: 10, borderRadius: 3, marginRight: 5 },
  tabelaWrap: { overflowX: "auto" },
  tabela: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", padding: "8px 10px", color: "var(--rv-texto-suave)", fontWeight: 700, fontSize: 12, borderBottom: "1px solid var(--rv-borda)", whiteSpace: "nowrap" },
  thNum: { textAlign: "right", padding: "8px 10px", color: "var(--rv-texto-suave)", fontWeight: 700, fontSize: 12, borderBottom: "1px solid var(--rv-borda)", whiteSpace: "nowrap" },
  trFuturo: { background: "var(--rv-roxo-fundo)" },
  tdMes: { padding: "8px 10px", fontWeight: 700, color: "var(--rv-texto-forte)", borderBottom: "1px solid var(--rv-borda-suave)", whiteSpace: "nowrap" },
  tagProj: { marginLeft: 6, background: "var(--rv-roxo-fundo)", color: "var(--rv-roxo)", borderRadius: 999, padding: "1px 7px", fontSize: 10, fontWeight: 800 },
  tagCurso: { marginLeft: 6, background: "var(--rv-azul-fundo)", color: "var(--rv-azul-texto)", borderRadius: 999, padding: "1px 7px", fontSize: 10, fontWeight: 800 },
  td: { padding: "8px 10px", textAlign: "right", color: "var(--rv-texto-suave)", borderBottom: "1px solid var(--rv-borda-suave)", whiteSpace: "nowrap" },
  tdForte: { padding: "8px 10px", textAlign: "right", color: "var(--rv-tinta)", fontWeight: 700, borderBottom: "1px solid var(--rv-borda-suave)", whiteSpace: "nowrap" },
  tdProj: { padding: "8px 10px", textAlign: "right", color: "var(--rv-roxo)", fontWeight: 700, borderBottom: "1px solid var(--rv-borda-suave)", whiteSpace: "nowrap" },
  subProj: { fontSize: 11, color: "var(--rv-roxo)", fontWeight: 600, marginTop: 2 },
  tdNum: { padding: "8px 10px", textAlign: "right", borderBottom: "1px solid var(--rv-borda-suave)", whiteSpace: "nowrap" },
  tdTotal: { padding: "10px", textAlign: "right", fontWeight: 800, color: "var(--rv-tinta)", borderTop: "2px solid var(--rv-borda)", whiteSpace: "nowrap" },
  tdTotalNum: { padding: "10px", textAlign: "right", borderTop: "2px solid var(--rv-borda)", whiteSpace: "nowrap" },
  tdFecha: { padding: "10px", textAlign: "right", fontWeight: 800, color: "var(--rv-roxo)", background: "var(--rv-roxo-fundo)", whiteSpace: "nowrap" },
  muted: { color: "var(--rv-texto-suave)" },
  rodape: { color: "var(--rv-texto-fraco)", fontSize: 12, marginTop: 10 },
};
