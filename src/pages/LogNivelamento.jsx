import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import { Carregando } from "../ui/estados";

const FONTE_TITULO = "'Sora', 'Inter', system-ui, sans-serif";

function formatarData(dataISO) {
  if (!dataISO) return "-";
  return new Date(dataISO).toLocaleString("pt-BR");
}
function moeda(v) {
  return Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export default function LogNivelamento() {
  const [carregando, setCarregando] = useState(true);
  const [logs, setLogs] = useState([]);

  useEffect(() => {
    carregar();
  }, []);

  async function carregar() {
    setCarregando(true);
    const { data, error } = await supabase
      .from("log_job_nivelamento")
      .select("*")
      .order("executado_em", { ascending: false })
      .limit(30);
    if (!error) setLogs(data || []);
    setCarregando(false);
  }

  const ultimo = logs[0];

  return (
    <div style={S.container}>
      <div style={S.cabecalho}>
        <div>
          <h1 style={S.titulo}>🌙 Log do Job Noturno</h1>
          <p style={S.subtitulo}>Nivelamento automático da carteira — roda todo dia às 3h30.</p>
        </div>
        <button style={S.botaoAtualizar} onClick={carregar}>Atualizar</button>
      </div>

      {carregando ? (
        <Carregando texto="Carregando…" />
      ) : logs.length === 0 ? (
        <p style={S.muted}>Nenhuma execução registrada ainda.</p>
      ) : (
        <>
          {ultimo && (
            <div style={S.resumoGrid}>
              <div style={S.resumoCard}>
                <span style={S.resumoLabel}>Última execução</span>
                <span style={S.resumoValor}>{formatarData(ultimo.executado_em)}</span>
              </div>
              <div style={S.resumoCard}>
                <span style={S.resumoLabel}>Valores recuperados</span>
                <span style={S.resumoValor}>{moeda(ultimo.valores_recuperados)}</span>
              </div>
              <div style={S.resumoCard}>
                <span style={S.resumoLabel}>Casos liberados por teto</span>
                <span style={S.resumoValor}>{ultimo.casos_liberados_teto}</span>
              </div>
              <div style={S.resumoCard}>
                <span style={S.resumoLabel}>Trocas de nivelamento</span>
                <span style={S.resumoValor}>{ultimo.trocas_nivelamento}</span>
              </div>
            </div>
          )}

          <div style={S.card}>
            <h3 style={S.tituloBloco}>Histórico (últimas 30 execuções)</h3>
            <table style={S.tabela}>
              <thead>
                <tr>
                  <th style={S.th}>Data/Hora</th>
                  <th style={S.thNum}>Valores recuperados</th>
                  <th style={S.thNum}>Liberados por teto</th>
                  <th style={S.thNum}>Trocas de nivelamento</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((l) => (
                  <tr key={l.id}>
                    <td style={S.td}>{formatarData(l.executado_em)}</td>
                    <td style={S.tdNum}>{moeda(l.valores_recuperados)}</td>
                    <td style={S.tdNum}>{l.casos_liberados_teto}</td>
                    <td style={S.tdNum}>{l.trocas_nivelamento}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

const S = {
  container: { padding: "28px 30px 40px", fontFamily: "'Inter', system-ui, sans-serif", background: "var(--rv-fundo)", minHeight: "100%" },
  cabecalho: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, marginBottom: 18, flexWrap: "wrap" },
  titulo: { margin: 0, color: "var(--rv-tinta)", fontFamily: FONTE_TITULO, fontSize: 26, fontWeight: 800, letterSpacing: "-0.03em" },
  subtitulo: { margin: "5px 0 0", color: "var(--rv-texto-fraco)", fontSize: 13.5 },
  botaoAtualizar: { background: "#2563eb", color: "#fff", border: "none", borderRadius: 10, padding: "10px 18px", fontWeight: 700, fontSize: 13, cursor: "pointer" },
  muted: { color: "var(--rv-texto-fraco)" },
  resumoGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14, marginBottom: 18 },
  resumoCard: { background: "var(--rv-superficie)", border: "1px solid var(--rv-borda-suave)", borderRadius: 16, padding: "18px 20px", display: "flex", flexDirection: "column", gap: 6, boxShadow: "0 1px 2px rgba(16,24,40,0.04)" },
  resumoLabel: { fontSize: 12, color: "var(--rv-texto-fraco)", fontWeight: 600 },
  resumoValor: { fontFamily: FONTE_TITULO, fontSize: 22, fontWeight: 800, color: "var(--rv-tinta)" },
  card: { background: "var(--rv-superficie)", borderRadius: 16, padding: "20px 22px", boxShadow: "0 1px 2px rgba(16,24,40,0.04)", border: "1px solid var(--rv-borda-suave)" },
  tituloBloco: { margin: "0 0 14px", fontFamily: FONTE_TITULO, fontSize: 16, fontWeight: 800, color: "var(--rv-tinta)" },
  tabela: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", padding: "8px 10px", color: "var(--rv-texto-fraco)", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", background: "var(--rv-fundo-cartao)", borderBottom: "1px solid var(--rv-borda)" },
  thNum: { textAlign: "right", padding: "8px 10px", color: "var(--rv-texto-fraco)", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", background: "var(--rv-fundo-cartao)", borderBottom: "1px solid var(--rv-borda)" },
  td: { padding: "9px 10px", borderBottom: "1px solid var(--rv-borda-suave)", fontWeight: 700 },
  tdNum: { padding: "9px 10px", borderBottom: "1px solid var(--rv-borda-suave)", textAlign: "right" },
};
