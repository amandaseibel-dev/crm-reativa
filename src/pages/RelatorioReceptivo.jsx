import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

function dataBR(v) {
  if (!v) return "-";
  try { return new Date(v).toLocaleString("pt-BR"); } catch (e) { return "-"; }
}

export default function RelatorioReceptivo() {
  const [d, setD] = useState(null);
  const [carregando, setCarregando] = useState(true);

  async function carregar() {
    setCarregando(true);
    const { data } = await supabase.rpc("receptivo_relatorio");
    setD(data || null);
    setCarregando(false);
  }
  useEffect(() => { carregar(); }, []);

  if (carregando) {
    return (<main className="content"><div style={S.wrap}><p style={S.muted}>Carregando relatorio do receptivo...</p></div></main>);
  }

  const ops = (d && d.por_operador) || [];
  const maxHoje = Math.max(1, ...ops.map((o) => Number(o.hoje) || 0));

  return (
    <main className="content">
      <div style={S.wrap}>
        <div style={S.head}>
          <div>
            <h1 style={S.h1}>Relatorio do Receptivo</h1>
            <span style={S.sub}>Atendimentos por operador (horario de Brasilia)</span>
          </div>
          <button style={S.btn} onClick={carregar}>Atualizar</button>
        </div>

        <div style={S.cards}>
          <div style={S.card}><span style={S.cardVal}>{d ? d.total_hoje : 0}</span><span style={S.cardRot}>Hoje</span></div>
          <div style={S.card}><span style={S.cardVal}>{d ? d.total_7d : 0}</span><span style={S.cardRot}>Ultimos 7 dias</span></div>
          <div style={S.card}><span style={S.cardVal}>{d ? d.total_30d : 0}</span><span style={S.cardRot}>Ultimos 30 dias</span></div>
        </div>

        <div style={S.box}>
          <h3 style={S.h3}>Por operador</h3>
          <table style={S.tabela}>
            <thead>
              <tr>
                <th style={S.th}>Operador</th>
                <th style={S.thNum}>Hoje</th>
                <th style={S.thNum}>7 dias</th>
                <th style={S.thNum}>30 dias</th>
              </tr>
            </thead>
            <tbody>
              {ops.length === 0 && (
                <tr><td style={S.vazio} colSpan={4}>Nenhum atendimento registrado ainda. O log comeca a contar a partir de agora.</td></tr>
              )}
              {ops.map((o) => (
                <tr key={o.operador_email}>
                  <td style={S.td}>{o.operador}</td>
                  <td style={S.tdNum}>
                    <span style={S.barTrack}><span style={{ ...S.barFill, width: Math.max(4, (Number(o.hoje) / maxHoje) * 100) + "%" }} /></span>
                    <strong>{o.hoje}</strong>
                  </td>
                  <td style={S.tdNum}>{o.ult_7d}</td>
                  <td style={S.tdNum}>{o.ult_30d}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p style={S.rodape}>Calculado agora: {d ? dataBR(d.gerado_em) : "-"}</p>
      </div>
    </main>
  );
}

const S = {
  wrap: { padding: 24, fontFamily: "'Inter', system-ui, sans-serif", background: "#f4f6fa", minHeight: "100%" },
  head: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, marginBottom: 18, flexWrap: "wrap" },
  h1: { margin: 0, fontSize: 24, color: "#0f172a", fontWeight: 800 },
  sub: { fontSize: 13, color: "#64748b" },
  btn: { background: "#1e40af", color: "#fff", border: "none", borderRadius: 8, padding: "10px 16px", fontWeight: 700, cursor: "pointer" },
  cards: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginBottom: 18 },
  card: { background: "#fff", border: "1px solid #eef2f6", borderRadius: 14, padding: "16px 18px", display: "flex", flexDirection: "column", gap: 4, boxShadow: "0 1px 3px rgba(15,23,42,0.05)" },
  cardVal: { fontSize: 28, fontWeight: 800, color: "#0f172a" },
  cardRot: { fontSize: 12, color: "#64748b", fontWeight: 600 },
  box: { background: "#fff", border: "1px solid #eef2f6", borderRadius: 14, padding: 18, boxShadow: "0 1px 3px rgba(15,23,42,0.05)" },
  h3: { margin: "0 0 12px", fontSize: 15, fontWeight: 700, color: "#0f172a" },
  tabela: { width: "100%", borderCollapse: "collapse", fontSize: 13.5 },
  th: { textAlign: "left", padding: "8px 10px", color: "#64748b", fontSize: 11, fontWeight: 700, textTransform: "uppercase", borderBottom: "1px solid #e3e7ee" },
  thNum: { textAlign: "right", padding: "8px 10px", color: "#64748b", fontSize: 11, fontWeight: 700, textTransform: "uppercase", borderBottom: "1px solid #e3e7ee" },
  td: { padding: "10px", borderBottom: "1px solid #f2f4f7", fontWeight: 700, color: "#0f172a" },
  tdNum: { padding: "10px", borderBottom: "1px solid #f2f4f7", textAlign: "right", color: "#334155" },
  barTrack: { display: "inline-block", width: 80, height: 6, background: "#eef2f6", borderRadius: 999, overflow: "hidden", marginRight: 8, verticalAlign: "middle" },
  barFill: { display: "inline-block", height: 6, background: "#2563eb", borderRadius: 999 },
  vazio: { padding: 20, textAlign: "center", color: "#94a3b8" },
  muted: { color: "#64748b" },
  rodape: { color: "#8a93a3", fontSize: 12, marginTop: 10 },
};

