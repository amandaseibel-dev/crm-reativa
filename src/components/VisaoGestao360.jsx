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
  const [saude, setSaude] = useState(null);
  const [ano, setAno] = useState(null);

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

  useEffect(() => {
    let ativo = true;
    supabase.rpc("dashboard_saude_base_acionamento").then(({ data }) => { if (ativo) setSaude(data); });
    supabase.rpc("dashboard_ano_vs_ano").then(({ data }) => { if (ativo) setAno(data); });
    return () => { ativo = false; };
  }, []);

  if (carregando) {
    return (
      <div style={s.card}>
        <p style={s.muted}>Carregando panorama da carteira...</p>
      </div>
    );
  }
  if (erro || !d) {
    return (
      <div style={s.card}>
        <p style={s.muted}>Nao foi possivel carregar o panorama da carteira.</p>
      </div>
    );
  }

  const base = d.base || {};
  const atraso = d.faixa_atraso || [];
  const periodos = d.por_semestre || [];
  const unis = d.por_unidade || [];

  const maxAtraso = Math.max(1, ...atraso.map((x) => Number(x.valor) || 0));
  const maxPer = Math.max(1, ...periodos.map((x) => Number(x.valor) || 0));
  const maxUni = Math.max(1, ...unis.map((x) => Number(x.valor) || 0));

  // Projecao de reducao da carteira - Julho e Agosto (ritmo atual)
  let projCarteira = null;
  if (ano && Array.isArray(ano.por_mes)) {
    const carteiraAtual = Number(base.valor_total) || 0;
    const jul = ano.por_mes.find((m) => m.mes === 7) || {};
    const ago = ano.por_mes.find((m) => m.mes === 8) || {};
    const julPrev = Number(jul.rec_proj) || 0;
    const julReal = Number(jul.rec_2026) || 0;
    const julFalta = Math.max(0, julPrev - julReal);
    const agoPrev = Number(ago.rec_proj) || 0;
    const reducao = julFalta + agoPrev;
    projCarteira = {
      carteiraAtual, julPrev, julReal, julFalta, agoPrev, reducao,
      carteiraProj: Math.max(0, carteiraAtual - reducao),
    };
  }

  return (
    <div style={s.wrap}>
      <div style={s.headerRow}>
        <h2 style={s.h2}>Panorama 360 — visão da carteira</h2>
        <span style={s.sub}>Foto da base a cobrar e projeção de fechamento</span>
      </div>

      <div style={s.statsRow}>
        <Stat rot="Base histórica (CPFs)" val={num(base.total)} cor="#94a3b8" />
        <Stat rot="Carteira a cobrar" val={num(base.com_divida)} cor="#111827" />
        <Stat rot="Já recuperados" val={num(base.quitados)} cor="#16a34a" />
        <Stat rot="Sem dívida em aberto" val={num((base.ativos || 0) - (base.com_divida || 0))} cor="#f59e0b" />
        <Stat rot="Valor a cobrar" val={moeda(base.valor_total)} cor="#16a34a" />
      </div>

      {projCarteira && (
        <div style={s.bloco}>
          <h3 style={s.h3}>Projeção da carteira — Julho e Agosto (ritmo atual)</h3>
          <div style={s.projRow}>
            <div style={{ ...s.projCard, background: "#f1f5f9" }}>
              <div style={{ ...s.projVal, color: "#334155" }}>{moeda(projCarteira.carteiraAtual)}</div>
              <div style={s.projRot}>Carteira hoje</div>
            </div>
            <div style={s.projSeta}>−</div>
            <div style={{ ...s.projCard, background: "#dbeafe" }}>
              <div style={{ ...s.projVal, color: "#1d4ed8" }}>{moeda(projCarteira.julFalta)}</div>
              <div style={s.projRot}>Previsto recuperar em julho (a realizar)</div>
              <div style={s.projNota}>Mês fechado: {moeda(projCarteira.julPrev)} · já {moeda(projCarteira.julReal)}</div>
            </div>
            <div style={s.projSeta}>−</div>
            <div style={{ ...s.projCard, background: "#e0e7ff" }}>
              <div style={{ ...s.projVal, color: "#4338ca" }}>{moeda(projCarteira.agoPrev)}</div>
              <div style={s.projRot}>Previsto recuperar em agosto</div>
            </div>
            <div style={s.projSeta}>=</div>
            <div style={{ ...s.projCard, background: "#dcfce7" }}>
              <div style={{ ...s.projVal, color: "#15803d" }}>{moeda(projCarteira.carteiraProj)}</div>
              <div style={s.projRot}>Carteira projetada fim de agosto</div>
            </div>
          </div>
          <p style={s.muted}>
            Redução projetada em jul+ago: <strong>{moeda(projCarteira.reducao)}</strong>. Estimativa pelo ritmo diário de recuperação — recalcula sozinha conforme entram pagamentos.
          </p>
        </div>
      )}

      {saude && (
        <div style={s.bloco}>
          <h3 style={s.h3}>Saúde da base — nunca acionados por faixa</h3>
          {(() => {
            const faixas = saude.faixas || [];
            const maxF = Math.max(1, ...faixas.map((y) => (Number(y.na_operacao) || 0) + (Number(y.fora_operacao) || 0)));
            return faixas.map((f) => {
              const tot = (Number(f.na_operacao) || 0) + (Number(f.fora_operacao) || 0);
              return (
                <div key={f.faixa} style={s.linha}>
                  <div style={s.linhaTopo}><span>{f.faixa}</span><strong>{num(tot)} alunos</strong></div>
                  <div style={s.barTrack}><div style={{ ...s.barFill, width: Math.max(2, (tot / maxF) * 100) + "%", background: "#2563eb" }} /></div>
                </div>
              );
            });
          })()}
        </div>
      )}

      <div style={s.grid2}>
        <div style={s.bloco}>
          <h3 style={s.h3}>Faixa de atraso das mensalidades</h3>
          {atraso.map((x) => (
            <Bar key={x.faixa} label={x.faixa} sub={num(x.cpfs) + " CPFs"} val={moeda(x.valor)} pct={(Number(x.valor) / maxAtraso) * 100} cor="#ef4444" />
          ))}
        </div>
        <div style={s.bloco}>
          <h3 style={s.h3}>Dívida por período de vencimento</h3>
          <p style={s.legendaPer}>
            <span style={{ ...s.legDot, background: "#4338ca" }} /> Anos rentáveis na cobrança (2025/2 e 2026)
            <span style={{ ...s.legDot, background: "#cbd5e1", marginLeft: 14 }} /> 2025/1 para trás
          </p>
          {periodos.map((x) => {
            const rent = x.rentavel;
            return (
              <div key={x.ano + "/" + x.sem} style={s.linha}>
                <div style={{ ...s.linhaTopo, opacity: rent ? 1 : 0.55 }}>
                  <span>
                    <strong style={{ color: rent ? "#0f172a" : "#94a3b8" }}>{x.ano}/{x.sem}</strong>
                    {rent && <span style={s.tagRent}>foco cobrança</span>}
                    <em style={s.em}> — {num(x.cpfs)} CPFs</em>
                  </span>
                  <strong style={{ color: rent ? "#0f172a" : "#94a3b8" }}>{moeda(x.valor)}</strong>
                </div>
                <div style={s.barTrack}>
                  <div style={{ ...s.barFill, width: Math.max(2, (Number(x.valor) / maxPer) * 100) + "%", background: rent ? "#4338ca" : "#cbd5e1" }} />
                </div>
              </div>
            );
          })}
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
  projRow: { display: "flex", gap: 10, flexWrap: "wrap", alignItems: "stretch", marginBottom: 10 },
  projCard: { flex: 1, minWidth: 150, borderRadius: 12, padding: 14, display: "flex", flexDirection: "column", gap: 4 },
  projVal: { fontSize: 21, fontWeight: 800, lineHeight: 1.1 },
  projRot: { fontSize: 12, color: "#475569", fontWeight: 600 },
  projNota: { fontSize: 11, color: "#64748b" },
  projSeta: { display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, fontWeight: 800, color: "#94a3b8", minWidth: 16 },
  legendaPer: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", fontSize: 12, color: "#64748b", margin: "0 0 12px" },
  legDot: { display: "inline-block", width: 10, height: 10, borderRadius: 3, marginRight: 4 },
  tagRent: { marginLeft: 6, background: "#e0e7ff", color: "#4338ca", borderRadius: 999, padding: "1px 8px", fontSize: 10, fontWeight: 800 },
  linha: { marginBottom: 12 },
  linhaTopo: { display: "flex", justifyContent: "space-between", gap: 10, fontSize: 13, color: "#334155", marginBottom: 5 },
  barTrack: { background: "#f1f5f9", borderRadius: 999, height: 10, overflow: "hidden" },
  barFill: { height: "100%", borderRadius: 999 },
  em: { color: "#94a3b8", fontStyle: "normal", fontSize: 12 },
  recU: { fontSize: 11, color: "#16a34a", fontWeight: 600 },
  muted: { color: "#64748b", margin: 0, fontSize: 12 },
  card: { background: "#fff", border: "1px solid #eef2f6", borderRadius: 16, padding: 18, marginBottom: 16 },
};
