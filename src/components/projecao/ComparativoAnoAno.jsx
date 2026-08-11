import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../services/supabase";

// Aba "Ano vs Ano" da Projeção Hora a Hora — só gestão (o gate REAL é no
// backend: projecao_ano_vs_ano retorna {autorizado:false} pra quem não é
// Amanda/Fernanda). Objetivo: entender as QUEDAS. O total mês a mês esconde a
// queda real; por isso decompomos cada mês em volume × ticket médio × honorário.

const ABREV = ["", "Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
const AZUL = "#2563eb";
const CINZA = "#94a3b8";
const BORDA = "#e5e7eb";

function moeda(v) {
  return Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
}
function num(v) {
  return Number(v || 0).toLocaleString("pt-BR");
}

// Δ percentual entre ano anterior (a) e ano atual (b). Quando não há base no
// ano anterior, não força um "+∞%": mostra "novo" (mês sem operação em 2025).
function pct(a, b) {
  const va = Number(a) || 0;
  const vb = Number(b) || 0;
  if (!va && !vb) return null;
  if (!va) return { texto: "novo", cor: "#16a34a", positivo: true };
  const p = ((vb - va) / va) * 100;
  return { texto: (p >= 0 ? "+" : "") + p.toFixed(0) + "%", cor: p >= 0 ? "#16a34a" : "#dc2626", positivo: p >= 0 };
}

function Delta({ a, b }) {
  const d = pct(a, b);
  if (!d) return <span style={{ color: "#cbd5e1" }}>—</span>;
  return <span style={{ color: d.cor, fontWeight: 700 }}>{d.texto}</span>;
}

export default function ComparativoAnoAno() {
  const [dados, setDados] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");

  useEffect(() => {
    let vivo = true;
    (async () => {
      setCarregando(true);
      setErro("");
      const { data, error } = await supabase.rpc("projecao_ano_vs_ano");
      if (!vivo) return;
      if (error) {
        setErro("Não foi possível carregar o comparativo: " + error.message);
      } else if (data?.autorizado === false) {
        setErro("Este comparativo é exclusivo da gestão.");
      } else {
        setDados(data);
      }
      setCarregando(false);
    })();
    return () => { vivo = false; };
  }, []);

  const anoAnt = dados?.ano_anterior;
  const anoAtu = dados?.ano_atual;
  const mp = dados?.mesmo_periodo || {};

  // Só mostra meses que têm algum dado em pelo menos um dos anos (evita a
  // cauda de meses futuros zerados poluindo gráfico e tabela).
  const meses = useMemo(
    () => (dados?.por_mes || []).filter((m) => Number(m.rec_ant) > 0 || Number(m.rec_atu) > 0),
    [dados]
  );

  const maxRec = useMemo(
    () => Math.max(1, ...meses.flatMap((m) => [Number(m.rec_ant) || 0, Number(m.rec_atu) || 0])),
    [meses]
  );

  if (carregando) return <p style={{ opacity: 0.7 }}>Carregando comparativo ano vs ano...</p>;
  if (erro) return <p style={{ color: "#b45309" }}>{erro}</p>;
  if (!dados) return null;

  const mesRefNome = ABREV[dados?.mes_ref] || dados?.mes_ref;

  return (
    <div>
      {/* MESMO PERÍODO — comparação justa do mês em curso (até o mesmo dia). */}
      <div style={estilos.card}>
        <h3 style={{ margin: "0 0 4px" }}>
          📅 Mesmo período — {mesRefNome} até o dia {dados?.dia_ref}
        </h3>
        <p style={{ opacity: 0.6, fontSize: 12.5, margin: "0 0 12px" }}>
          {anoAtu} comparado a {anoAnt} no mesmo trecho do mês (dia 1 até o dia {dados?.dia_ref}). Comparação justa do mês que ainda está em curso.
        </p>
        <div style={estilos.kpiRow}>
          <KpiComparativo rotulo="Recuperado" atu={moeda(mp.rec_atu)} ant={moeda(mp.rec_ant)} a={mp.rec_ant} b={mp.rec_atu} anoAnt={anoAnt} destaque />
          <KpiComparativo rotulo="Pagamentos" atu={num(mp.n_atu)} ant={num(mp.n_ant)} a={mp.n_ant} b={mp.n_atu} anoAnt={anoAnt} />
          <KpiComparativo rotulo="Ticket médio" atu={moeda(mp.ticket_atu)} ant={moeda(mp.ticket_ant)} a={mp.ticket_ant} b={mp.ticket_atu} anoAnt={anoAnt} alerta />
          <KpiComparativo rotulo="Honorário" atu={moeda(mp.hon_atu)} ant={moeda(mp.hon_ant)} a={mp.hon_ant} b={mp.hon_atu} anoAnt={anoAnt} />
        </div>
        {(() => {
          const dRec = pct(mp.rec_ant, mp.rec_atu);
          const dTic = pct(mp.ticket_ant, mp.ticket_atu);
          // "Queda escondida": total sobe mas ticket cai — sinaliza dependência
          // de volume. Só destaca quando o padrão realmente aparece.
          if (dRec?.positivo && dTic && !dTic.positivo) {
            return (
              <div style={estilos.avisoQueda}>
                ⚠️ <strong>Queda escondida:</strong> o recuperado subiu ({dRec.texto}), mas o <strong>ticket médio caiu {dTic.texto}</strong>. O crescimento está vindo de volume, não de valor por caso.
              </div>
            );
          }
          return null;
        })()}
      </div>

      {/* GRÁFICO — barras agrupadas mês a mês (ano anterior x ano atual). */}
      <div style={estilos.card}>
        <h3 style={{ margin: "0 0 10px" }}>📊 Recuperado mês a mês — {anoAnt} vs {anoAtu}</h3>
        <div style={{ display: "flex", gap: 18, fontSize: 12, color: "#64748b", marginBottom: 12, fontWeight: 600 }}>
          <span><span style={{ ...estilos.legDot, background: CINZA }} /> {anoAnt}</span>
          <span><span style={{ ...estilos.legDot, background: AZUL }} /> {anoAtu}</span>
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 10, height: 180, borderBottom: `1px solid ${BORDA}`, overflowX: "auto", paddingBottom: 2 }}>
          {meses.map((m) => {
            const hAnt = Math.max((Number(m.rec_ant) / maxRec) * 150, m.rec_ant > 0 ? 3 : 0);
            const hAtu = Math.max((Number(m.rec_atu) / maxRec) * 150, m.rec_atu > 0 ? 3 : 0);
            return (
              <div key={m.mes} style={{ flex: "0 0 auto", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", height: "100%" }}>
                <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 155 }}>
                  <div title={`${anoAnt}: ${moeda(m.rec_ant)}`} style={{ width: 16, height: hAnt, background: CINZA, borderRadius: "3px 3px 0 0" }} />
                  <div title={`${anoAtu}: ${moeda(m.rec_atu)}`} style={{ width: 16, height: hAtu, background: AZUL, borderRadius: "3px 3px 0 0" }} />
                </div>
                <div style={{ fontSize: 11, color: "#64748b", marginTop: 5 }}>{ABREV[m.mes]}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* TABELA — decomposição da queda: volume, ticket médio e honorário. */}
      <div style={estilos.card}>
        <h3 style={{ margin: "0 0 4px" }}>🔎 Onde está a queda — volume × ticket médio × honorário</h3>
        <p style={{ opacity: 0.6, fontSize: 12.5, margin: "0 0 12px" }}>
          Δ compara o mesmo mês de {anoAtu} contra {anoAnt}. Um recuperado maior com ticket menor = crescimento por volume.
        </p>
        <div style={{ overflowX: "auto" }}>
          <table style={estilos.tabela}>
            <thead>
              <tr>
                <th style={estilos.th}>Mês</th>
                <th style={estilos.thNum}>Recuperado {anoAnt}</th>
                <th style={estilos.thNum}>Recuperado {anoAtu}</th>
                <th style={estilos.thNum}>Δ rec.</th>
                <th style={estilos.thNum}>Δ volume</th>
                <th style={estilos.thNum}>Ticket {anoAnt}</th>
                <th style={estilos.thNum}>Ticket {anoAtu}</th>
                <th style={estilos.thNum}>Δ ticket</th>
                <th style={estilos.thNum}>Δ honor.</th>
              </tr>
            </thead>
            <tbody>
              {meses.map((m) => (
                <tr key={m.mes}>
                  <td style={estilos.tdMes}>{ABREV[m.mes]}</td>
                  <td style={estilos.td}>{m.rec_ant ? moeda(m.rec_ant) : "—"}</td>
                  <td style={estilos.tdForte}>{m.rec_atu ? moeda(m.rec_atu) : "—"}</td>
                  <td style={estilos.tdNum}><Delta a={m.rec_ant} b={m.rec_atu} /></td>
                  <td style={estilos.tdNum}><Delta a={m.n_ant} b={m.n_atu} /></td>
                  <td style={estilos.td}>{m.ticket_ant ? moeda(m.ticket_ant) : "—"}</td>
                  <td style={estilos.td}>{m.ticket_atu ? moeda(m.ticket_atu) : "—"}</td>
                  <td style={estilos.tdNum}><Delta a={m.ticket_ant} b={m.ticket_atu} /></td>
                  <td style={estilos.tdNum}><Delta a={m.hon_ant} b={m.hon_atu} /></td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td style={estilos.tdTotal}>Total</td>
                <td style={estilos.tdTotal}>{moeda(dados?.total_ant)}</td>
                <td style={estilos.tdTotal}>{moeda(dados?.total_atu)}</td>
                <td style={estilos.tdTotalNum}><Delta a={dados?.total_ant} b={dados?.total_atu} /></td>
                <td style={estilos.tdTotal}></td>
                <td style={estilos.tdTotal}></td>
                <td style={estilos.tdTotal}></td>
                <td style={estilos.tdTotal}></td>
                <td style={estilos.tdTotalNum}><Delta a={dados?.hon_total_ant} b={dados?.hon_total_atu} /></td>
              </tr>
            </tfoot>
          </table>
        </div>
        <p style={{ color: "#8a93a3", fontSize: 12, marginTop: 10 }}>
          Base: pagamentos do mês (Santander) + histórico de recuperação. "novo" = mês sem operação em {anoAnt}. Meses sem dado nos dois anos ficam ocultos.
        </p>
      </div>
    </div>
  );
}

function KpiComparativo({ rotulo, atu, ant, a, b, anoAnt, destaque, alerta }) {
  const d = pct(a, b);
  return (
    <div style={{ ...estilos.kpi, ...(destaque ? estilos.kpiDestaque : {}) }}>
      <div style={estilos.kpiRot}>{rotulo}</div>
      <div style={estilos.kpiVal}>
        {atu}{" "}
        {d && <span style={{ fontSize: 13, fontWeight: 700, color: alerta && !d.positivo ? "#dc2626" : d.cor }}>{d.texto}</span>}
      </div>
      <div style={estilos.kpiNota}>vs {ant} em {anoAnt}</div>
    </div>
  );
}

const estilos = {
  card: { background: "#fff", border: `1px solid ${BORDA}`, borderRadius: 12, padding: "16px 18px", marginBottom: 14 },
  kpiRow: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 },
  kpi: { background: "#f8fafc", borderRadius: 10, padding: "12px 14px", border: `1px solid ${BORDA}` },
  kpiDestaque: { background: "#eff6ff", border: "1px solid #bfdbfe" },
  kpiRot: { fontSize: 12.5, color: "#64748b", fontWeight: 600, marginBottom: 4 },
  kpiVal: { fontSize: 21, fontWeight: 800, color: "#0d1321", lineHeight: 1.15 },
  kpiNota: { fontSize: 11.5, color: "#94a3b8", marginTop: 2 },
  legDot: { display: "inline-block", width: 10, height: 10, borderRadius: 3, marginRight: 5, verticalAlign: "middle" },
  avisoQueda: { marginTop: 12, padding: "10px 14px", borderRadius: 10, background: "#fef2f2", border: "1px solid #fecaca", fontSize: 12.5, color: "#b91c1c" },
  tabela: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", padding: "8px 10px", color: "#64748b", fontWeight: 700, fontSize: 12, borderBottom: `1px solid ${BORDA}`, whiteSpace: "nowrap" },
  thNum: { textAlign: "right", padding: "8px 10px", color: "#64748b", fontWeight: 700, fontSize: 12, borderBottom: `1px solid ${BORDA}`, whiteSpace: "nowrap" },
  tdMes: { padding: "8px 10px", fontWeight: 700, color: "#334155", borderBottom: "1px solid #f1f5f9", whiteSpace: "nowrap" },
  td: { padding: "8px 10px", textAlign: "right", color: "#64748b", borderBottom: "1px solid #f1f5f9", whiteSpace: "nowrap" },
  tdForte: { padding: "8px 10px", textAlign: "right", color: "#0d1321", fontWeight: 700, borderBottom: "1px solid #f1f5f9", whiteSpace: "nowrap" },
  tdNum: { padding: "8px 10px", textAlign: "right", borderBottom: "1px solid #f1f5f9", whiteSpace: "nowrap" },
  tdTotal: { padding: "10px", textAlign: "right", fontWeight: 800, color: "#0d1321", borderTop: `2px solid ${BORDA}`, whiteSpace: "nowrap" },
  tdTotalNum: { padding: "10px", textAlign: "right", borderTop: `2px solid ${BORDA}`, whiteSpace: "nowrap" },
};
