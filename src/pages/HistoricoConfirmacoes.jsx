import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";

// Historico de confirmacoes de pagamento realizadas por dia, com o usuario
// que fez cada uma (ultimos 30 dias, horario de Brasilia). So leitura.

function dataBR(iso) {
  if (!iso) return "-";
  const p = String(iso).split("-");
  return p.length === 3 ? p[2] + "/" + p[1] + "/" + p[0] : iso;
}

export default function HistoricoConfirmacoes() {
  const [rows, setRows] = useState([]);
  const [carregando, setCarregando] = useState(true);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.rpc("historico_confirmacoes_por_dia");
      setRows(data || []);
      setCarregando(false);
    })();
  }, []);

  const porDia = useMemo(() => {
    const m = {};
    rows.forEach((r) => {
      if (!m[r.dia]) m[r.dia] = { dia: r.dia, total: 0, usuarios: [] };
      m[r.dia].total += Number(r.qtd) || 0;
      m[r.dia].usuarios.push({ usuario: r.usuario, qtd: Number(r.qtd) || 0 });
    });
    return Object.values(m).sort((a, b) => String(b.dia).localeCompare(String(a.dia)));
  }, [rows]);

  const totalGeral = rows.reduce((s, r) => s + (Number(r.qtd) || 0), 0);
  const hoje = new Date().toISOString().slice(0, 10);
  const totalHoje = rows.filter((r) => r.dia === hoje).reduce((s, r) => s + (Number(r.qtd) || 0), 0);

  return (
    <div style={S.wrap}>
      <div style={S.topo}>
        <div>
          <h2 style={S.titulo}>Histórico de confirmações</h2>
          <p style={S.sub}>Confirmações de pagamento realizadas por dia e por usuário — últimos 30 dias.</p>
        </div>
        <div style={S.cards}>
          <div style={S.card}><div style={S.cardNum}>{totalHoje}</div><div style={S.cardRot}>Hoje</div></div>
          <div style={S.card}><div style={S.cardNum}>{totalGeral}</div><div style={S.cardRot}>Total (30 dias)</div></div>
        </div>
      </div>

      {carregando ? (
        <p style={S.muted}>Carregando...</p>
      ) : porDia.length === 0 ? (
        <p style={S.muted}>Nenhuma confirmação registrada nos últimos 30 dias.</p>
      ) : (
        <table style={S.tabela}>
          <thead>
            <tr>
              <th style={S.th}>Dia</th>
              <th style={S.thNum}>Total</th>
              <th style={S.th}>Por usuário</th>
            </tr>
          </thead>
          <tbody>
            {porDia.map((d) => (
              <tr key={d.dia}>
                <td style={S.td}><strong>{dataBR(d.dia)}</strong></td>
                <td style={S.tdNum}>{d.total}</td>
                <td style={S.td}>
                  <div style={S.chips}>
                    {d.usuarios.map((u, i) => (
                      <span key={i} style={S.chip}>{u.usuario}: <strong>{u.qtd}</strong></span>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const S = {
  wrap: { padding: "20px 22px 28px", fontFamily: "'Inter', system-ui, sans-serif", color: "#0f172a" },
  topo: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap", marginBottom: 16 },
  titulo: { margin: 0, fontFamily: "'Sora', Inter, sans-serif", fontSize: 18, fontWeight: 800, color: "#0d1321" },
  sub: { margin: "4px 0 0", color: "#8a93a3", fontSize: 13 },
  cards: { display: "flex", gap: 12 },
  card: { background: "#f8fafc", border: "1px solid #e6eaf0", borderRadius: 12, padding: "10px 18px", textAlign: "center", minWidth: 100 },
  cardNum: { fontSize: 24, fontWeight: 800, color: "#0d1321", fontFamily: "'Sora', Inter, sans-serif" },
  cardRot: { fontSize: 12, color: "#8a93a3", fontWeight: 600, marginTop: 2 },
  muted: { color: "#8a93a3", fontSize: 14 },
  tabela: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", padding: "9px 12px", color: "#8a93a3", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", background: "#f8fafc", borderBottom: "1px solid #e3e7ee" },
  thNum: { textAlign: "right", padding: "9px 12px", color: "#8a93a3", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", background: "#f8fafc", borderBottom: "1px solid #e3e7ee" },
  td: { padding: "9px 12px", borderBottom: "1px solid #f2f4f7", color: "#344054", verticalAlign: "top" },
  tdNum: { padding: "9px 12px", borderBottom: "1px solid #f2f4f7", textAlign: "right", fontWeight: 800, color: "#101828" },
  chips: { display: "flex", gap: 6, flexWrap: "wrap" },
  chip: { fontSize: 12, background: "#eef2ff", border: "1px solid #e0e7ff", borderRadius: 999, padding: "2px 10px", color: "#3730a3" },
};
