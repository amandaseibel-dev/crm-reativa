import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

function moeda(v) {
  return Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
function num(v) {
  return Number(v || 0).toLocaleString("pt-BR");
}

export default function VisaoGestao360({ dias = 30 }) {
  const [d, setD] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");

  useEffect(() => {
    let ativo = true;
    (async () => {
      setCarregando(true);
      setErro("");
      const { data, error } = await supabase.rpc("dashboard_gestao_geral", { p_dias: dias });
      if (!ativo) return;
      if (error) {
        setErro(error.message);
        setD(null);
      } else {
        setD(data);
      }
      setCarregando(false);
    })();
    return () => {
      ativo = false;
    };
  }, [dias]);

  if (carregando) {
    return (
      <div style={s.card}>
        <p style={s.muted}>Carregando visao de gestao...</p>
      </div>
    );
  }
  if (erro || !d) {
    return (
      <div style={s.card}>
        <p style={s.muted}>Nao foi possivel carregar a visao de gestao.</p>
      </div>
    );
  }

  const rec = d.recuperacao || {};
  const ac = d.acordos_ativos || {};
  const ops = d.por_operador || [];
  const atraso = d.faixa_atraso || [];
  const anos = d.por_ano || [];
  const unis = d.por_unidade || [];

  const maxAtraso = Math.max(1, ...atraso.map((x) => Number(x.valor) || 0));
  const maxAno = Math.max(1, ...anos.map((x) => Number(x.valor) || 0));
  const maxUni = Math.max(1, ...unis.map((x) => Number(x.valor) || 0));

  return (
    <div style={s.wrap}>
      <div style={s.headerRow}>
        <h2 style={s.h2}>Gestao da operacao</h2>
        <span style={s.sub}>Produtividade, recuperacao e risco (ult. {d.periodo_dias} dias)</span>
      </div>

      <div style={s.statsRow}>
        <Stat rot="Recuperado" val={moeda(rec.recuperado)} cor="#16a34a" />
        <Stat rot="Honorarios" val={moeda(rec.honorarios)} cor="#0ea5e9" />
        <Stat rot="Acordos ativos" val={num(ac.qtd)} cor="#7c3aed" />
        <Stat rot="Parcelas pagas" val={num(rec.parcelas)} cor="#f59e0b" />
      </div>

      <div style={s.bloco}>
        <h3 style={s.h3}>Produtividade por operador</h3>
        <div style={s.tblScroll}>
          <div style={{ ...s.tblRow, ...s.tblHead }}>
            <span>Operador</span>
            <span>Carteira</span>
            <span>% acionada</span>
            <span>Acionamentos</span>
            <span>Acordos</span>
            <span>Recuperado</span>
          </div>
          {ops.map((o) => (
            <div key={o.op} style={s.tblRow}>
              <span style={s.opName}>{o.op}</span>
              <span>{num(o.casos)} - {moeda(o.valor)}</span>
              <span style={s.pctCell}>
                <span style={s.miniTrack}>
                  <span style={{ ...s.miniFill, width: Math.min(100, Number(o.pct_acionada)) + "%" }} />
                </span>
                {Number(o.pct_acionada).toFixed(0)}%
              </span>
              <span>
                {num(o.acionamentos)} <em style={s.em}>(ontem {num(o.acionamentos_ontem)})</em>
              </span>
              <span>{num(o.acordos)}</span>
              <span style={s.recCell}>
                <strong>{moeda(o.recuperado)}</strong>
                <span style={s.hon}>hon. {moeda(o.honorarios)}</span>
              </span>
            </div>
          ))}
        </div>
      </div>

      <div style={s.grid2}>
        <div style={s.bloco}>
          <h3 style={s.h3}>Faixa de atraso das mensalidades</h3>
          {atraso.map((x) => (
            <Bar key={x.faixa} label={x.faixa} sub={num(x.titulos) + " titulos"} val={moeda(x.valor)} pct={(Number(x.valor) / maxAtraso) * 100} cor="#ef4444" />
          ))}
        </div>
        <div style={s.bloco}>
          <h3 style={s.h3}>Divida por ano de vencimento</h3>
          {anos.map((x) => (
            <Bar key={x.ano} label={String(x.ano)} sub={num(x.titulos) + " titulos"} val={moeda(x.valor)} pct={(Number(x.valor) / maxAno) * 100} cor="#6366f1" />
          ))}
        </div>
      </div>

      <div style={s.bloco}>
        <h3 style={s.h3}>Carteira e recuperado por estabelecimento</h3>
        {unis.map((x) => (
          <div key={x.unidade} style={s.linha}>
            <div style={s.linhaTopo}>
              <span>{x.unidade} - {num(x.titulos)} titulos</span>
              <strong>{moeda(x.valor)}</strong>
            </div>
            <div style={s.barTrack}>
              <div style={{ ...s.barFill, width: Math.max(2, (Number(x.valor) / maxUni) * 100) + "%", background: "#2563eb" }} />
            </div>
            {Number(x.recuperado) > 0 && <span style={s.recU}>Recuperado: {moeda(x.recuperado)}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

function Bar({ label, sub, val, pct, cor }) {
  return (
    <div style={s.linha}>
      <div style={s.linhaTopo}>
        <span>
          {label} <em style={s.em}>- {sub}</em>
        </span>
        <strong>{val}</strong>
      </div>
      <div style={s.barTrack}>
        <div style={{ ...s.barFill, width: Math.max(2, pct) + "%", background: cor }} />
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
  tblScroll: { overflowX: "auto" },
  tblRow: { display: "grid", gridTemplateColumns: "1.2fr 1.6fr 1.3fr 1.6fr 0.7fr 1.5fr", gap: 10, alignItems: "center", padding: "9px 0", borderBottom: "1px solid #f1f5f9", fontSize: 13, color: "#334155", minWidth: 720 },
  tblHead: { fontSize: 12, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.03em", borderBottom: "2px solid #eef2f6" },
  opName: { fontWeight: 700, color: "#0f172a" },
  pctCell: { display: "flex", alignItems: "center", gap: 8 },
  miniTrack: { flex: 1, background: "#f1f5f9", borderRadius: 999, height: 8, overflow: "hidden", maxWidth: 90 },
  miniFill: { display: "block", height: "100%", background: "#22c55e", borderRadius: 999 },
  em: { color: "#94a3b8", fontStyle: "normal", fontSize: 12 },
  recCell: { display: "flex", flexDirection: "column" },
  hon: { fontSize: 11, color: "#94a3b8" },
  linha: { marginBottom: 12 },
  linhaTopo: { display: "flex", justifyContent: "space-between", gap: 10, fontSize: 13, color: "#334155", marginBottom: 5 },
  barTrack: { background: "#f1f5f9", borderRadius: 999, height: 10, overflow: "hidden" },
  barFill: { height: "100%", borderRadius: 999 },
  recU: { fontSize: 11, color: "#16a34a", fontWeight: 600 },
  muted: { color: "#64748b", margin: 0 },
  card: { background: "#fff", border: "1px solid #eef2f6", borderRadius: 16, padding: 18, marginBottom: 16 },
};
