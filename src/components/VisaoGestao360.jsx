import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

function moeda(v) {
  return Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
function num(v) {
  return Number(v || 0).toLocaleString("pt-BR");
}

function ufDaUnidade(u) {
  const t = String(u || "").toUpperCase();
  if (/\/TO\b|PALMAS/.test(t)) return "TO";
  if (/\/AM\b|MANAUS/.test(t)) return "AM";
  if (/\/PA\b|SANTAR/.test(t)) return "PA";
  if (/\/GO\b|ITUMBIARA/.test(t)) return "GO";
  if (/CANOAS|TORRES|SANTA MARIA|CACHOEIRA|JERONIMO|JER\u00d4NIMO|GUAIBA|GUA\u00cdBA|CARAZINHO|GRAVATA|\bSAJ\b|POA|CAMPUS/.test(t)) return "RS";
  return null;
}

const UF_POS = {
  RR: [3, 1], AP: [5, 1],
  AM: [2, 2], PA: [4, 2], MA: [5, 2], CE: [6, 2], RN: [7, 2],
  AC: [1, 3], RO: [2, 3], TO: [4, 3], PI: [5, 3], PE: [6, 3], PB: [7, 3],
  MT: [3, 4], GO: [4, 4], BA: [5, 4], AL: [7, 4],
  MS: [3, 5], DF: [4, 5], MG: [5, 5], ES: [6, 5], SE: [7, 5],
  SP: [4, 6], RJ: [5, 6],
  PR: [4, 7], SC: [5, 7],
  RS: [4, 8],
};

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
  const porUF = {};
  let semUF = 0;
  (unis || []).forEach((x) => {
    const uf = ufDaUnidade(x.unidade);
    if (!uf) { semUF += Number(x.valor) || 0; return; }
    if (!porUF[uf]) porUF[uf] = { uf, valor: 0, recuperado: 0 };
    porUF[uf].valor += Number(x.valor) || 0;
    porUF[uf].recuperado += Number(x.recuperado) || 0;
  });
  const maxUF = Math.max(1, ...Object.values(porUF).map((u) => u.valor));
  const ufOrdenado = Object.values(porUF).sort((a, b) => b.valor - a.valor);

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
      <div style={s.bloco}>
        <h3 style={s.h3}>Distribuicao por estado (UF)</h3>
        <div style={s.mapaRow}>
          <div style={s.mapaGrid}>
            {Object.keys(UF_POS).map((uf) => {
              const info = porUF[uf];
              const inten = info ? 0.28 + 0.72 * (info.valor / maxUF) : 0;
              return (
                <div key={uf} title={uf + (info ? ": " + moeda(info.valor) : " (sem carteira)")}
                  style={{ ...s.uf, gridColumn: UF_POS[uf][0], gridRow: UF_POS[uf][1],
                    background: info ? "rgba(37,99,235," + inten.toFixed(2) + ")" : "#eef2f6",
                    color: info && inten > 0.55 ? "#fff" : "#94a3b8" }}>
                  {uf}
                </div>
              );
            })}
          </div>
          <div style={s.ufList}>
            {ufOrdenado.map((u) => (
              <div key={u.uf} style={s.ufItem}>
                <span style={s.ufTag}>{u.uf}</span>
                <span style={s.ufVal}><strong>{moeda(u.valor)}</strong>{u.recuperado > 0 ? " - rec. " + moeda(u.recuperado) : ""}</span>
              </div>
            ))}
            {semUF > 0 && (
              <div style={s.ufItem}><span style={s.ufTag}>Online</span><span style={s.ufVal}>{moeda(semUF)} <em style={s.em}>(EAD/POP)</em></span></div>
            )}
          </div>
        </div>
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
  mapaRow: { display: "flex", gap: 22, flexWrap: "wrap", alignItems: "flex-start" },
  mapaGrid: { display: "grid", gridTemplateColumns: "repeat(7, 34px)", gridTemplateRows: "repeat(8, 34px)", gap: 5 },
  uf: { display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 8, fontSize: 11, fontWeight: 700, boxShadow: "0 1px 2px rgba(15,23,42,0.06)" },
  ufList: { flex: 1, minWidth: 240 },
  ufItem: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, fontSize: 13, color: "#334155", padding: "6px 0", borderBottom: "1px solid #f1f5f9" },
  ufTag: { display: "inline-flex", minWidth: 34, justifyContent: "center", background: "#eff6ff", color: "#2563eb", borderRadius: 6, padding: "2px 6px", fontWeight: 800, fontSize: 12 },
  ufVal: { textAlign: "right" },
  muted: { color: "#64748b", margin: 0 },
  card: { background: "#fff", border: "1px solid #eef2f6", borderRadius: 16, padding: 18, marginBottom: 16 },
};
