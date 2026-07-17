import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

function moeda(v) {
  return Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
function numero(v) {
  return Number(v || 0).toLocaleString("pt-BR");
}

const CORES_FAIXA = {
  Alto: "#dc2626",
  Medio: "#f59e0b",
  Intermediario: "#0ea5e9",
  Baixo: "#3b82f6",
};

export default function VisaoGeralCarteira({ email = null }) {
  const [dados, setDados] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");

  useEffect(() => {
    let ativo = true;
    (async () => {
      setCarregando(true);
      setErro("");
      const { data, error } = await supabase.rpc("dashboard_carteira_geral", {
        p_email: email || null,
      });
      if (!ativo) return;
      if (error) {
        setErro(error.message);
        setDados(null);
      } else {
        setDados(data);
      }
      setCarregando(false);
    })();
    return () => {
      ativo = false;
    };
  }, [email]);

  if (carregando) {
    return (
      <div style={s.card}>
        <p style={s.muted}>Carregando visao geral da carteira...</p>
      </div>
    );
  }
  if (erro || !dados) {
    return (
      <div style={s.card}>
        <p style={s.muted}>Nao foi possivel carregar a visao geral da carteira.</p>
      </div>
    );
  }

  const total = dados.total || {};
  const faixas = dados.por_faixa || [];
  const operadores = dados.por_operador || [];
  const status = dados.por_status || [];

  const valorTotal = Number(total.valor) || 0;
  const maxValFaixa = Math.max(1, ...faixas.map((f) => Number(f.valor) || 0));
  const maxValOp = Math.max(1, ...operadores.map((o) => Number(o.valor) || 0));
  const maxCasosStatus = Math.max(1, ...status.map((x) => Number(x.casos) || 0));

  return (
    <div style={s.wrap}>
      <div style={s.headerRow}>
        <h2 style={s.h2}>Visao geral da carteira</h2>
        <span style={s.sub}>Panorama 360 da operacao</span>
      </div>

      <div style={s.statsRow}>
        <Stat rot="Casos ativos" val={numero(total.casos)} cor="#111827" />
        <Stat rot="Valor em aberto" val={moeda(total.valor)} cor="#16a34a" />
        <Stat rot="Titulos em aberto" val={numero(total.titulos)} cor="#0ea5e9" />
        <Stat rot="Operadores" val={numero(total.operadores)} cor="#7c3aed" />
      </div>

      <div style={s.grid2}>
        <div style={s.bloco}>
          <h3 style={s.h3}>Concentracao por faixa de saldo</h3>
          {faixas.map((f) => {
            const pct = valorTotal ? (Number(f.valor) / valorTotal) * 100 : 0;
            return (
              <div key={f.faixa} style={s.linha}>
                <div style={s.linhaTopo}>
                  <span>
                    <span style={{ ...s.dot, background: CORES_FAIXA[f.faixa] || "#94a3b8" }} />
                    {f.faixa} - {numero(f.casos)} casos
                  </span>
                  <strong>{moeda(f.valor)}</strong>
                </div>
                <div style={s.barTrack}>
                  <div
                    style={{
                      ...s.barFill,
                      width: Math.max(2, (Number(f.valor) / maxValFaixa) * 100) + "%",
                      background: CORES_FAIXA[f.faixa] || "#94a3b8",
                    }}
                  />
                </div>
                <span style={s.pct}>{pct.toFixed(1)}% do valor</span>
              </div>
            );
          })}
        </div>

        <div style={s.bloco}>
          <h3 style={s.h3}>Distribuicao por operador</h3>
          {operadores.map((o) => (
            <div key={o.operador_nome} style={s.linha}>
              <div style={s.linhaTopo}>
                <span>{o.operador_nome} - {numero(o.casos)} casos</span>
                <strong>{moeda(o.valor)}</strong>
              </div>
              <div style={s.barTrack}>
                <div
                  style={{
                    ...s.barFill,
                    width: Math.max(2, (Number(o.valor) / maxValOp) * 100) + "%",
                    background: "#2563eb",
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      <div style={s.bloco}>
        <h3 style={s.h3}>Funil por status</h3>
        <div style={s.grid2}>
          {status.map((x) => (
            <div key={x.status} style={s.linha}>
              <div style={s.linhaTopo}>
                <span>{x.status}</span>
                <strong>{numero(x.casos)} - {moeda(x.valor)}</strong>
              </div>
              <div style={s.barTrack}>
                <div
                  style={{
                    ...s.barFill,
                    width: Math.max(2, (Number(x.casos) / maxCasosStatus) * 100) + "%",
                    background: "#6366f1",
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Stat({ rot, val, cor }) {
  return (
    <div style={s.stat}>
      <span style={{ ...s.statVal, color: cor }}>{val}</span>
      <span style={s.statRot}>{rot}</span>
    </div>
  );
}

const s = {
  wrap: { marginBottom: 20 },
  headerRow: { display: "flex", alignItems: "baseline", gap: 10, marginBottom: 12, flexWrap: "wrap" },
  h2: { margin: 0, fontSize: 20, fontWeight: 800, color: "#0f172a" },
  sub: { fontSize: 13, color: "#64748b" },
  statsRow: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 16 },
  stat: { background: "#fff", border: "1px solid #eef2f6", borderRadius: 14, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 4, boxShadow: "0 1px 3px rgba(15,23,42,0.05)" },
  statVal: { fontSize: 22, fontWeight: 800, lineHeight: 1.1 },
  statRot: { fontSize: 13, color: "#64748b", fontWeight: 600 },
  grid2: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 },
  bloco: { background: "#fff", border: "1px solid #eef2f6", borderRadius: 16, padding: 18, marginBottom: 16, boxShadow: "0 1px 3px rgba(15,23,42,0.05)" },
  h3: { margin: "0 0 14px", fontSize: 15, fontWeight: 700, color: "#0f172a" },
  linha: { marginBottom: 12 },
  linhaTopo: { display: "flex", justifyContent: "space-between", gap: 10, fontSize: 13, color: "#334155", marginBottom: 5 },
  dot: { display: "inline-block", width: 9, height: 9, borderRadius: 9, marginRight: 6 },
  barTrack: { background: "#f1f5f9", borderRadius: 999, height: 10, overflow: "hidden" },
  barFill: { height: "100%", borderRadius: 999 },
  pct: { fontSize: 11, color: "#94a3b8" },
  muted: { color: "#64748b", margin: 0 },
  card: { background: "#fff", border: "1px solid #eef2f6", borderRadius: 16, padding: 18, marginBottom: 16 },
};
