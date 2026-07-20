import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

function moeda(v) {
  return Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
}
function num(v) {
  return Number(v || 0).toLocaleString("pt-BR");
}

export default function VisaoGeralCarteira() {
  const [d, setD] = useState(null);
  const [carregando, setCarregando] = useState(true);

  useEffect(() => {
    let ativo = true;
    (async () => {
      const { data } = await supabase.rpc("dashboard_carteira_360");
      if (!ativo) return;
      setD(data);
      setCarregando(false);
    })();
    return () => { ativo = false; };
  }, []);

  if (carregando) return <div style={S.card}><p style={S.muted}>Carregando Carteira 360...</p></div>;
  if (!d) return <div style={S.card}><p style={S.muted}>Não foi possível carregar a Carteira 360.</p></div>;

  const bt = d.base_total || {};
  const op = d.operacao_2026 || {};
  const ms = d.massiva_2024_2025 || {};
  const tr = d.trabalhavel || {};
  const st = d.sem_telefone || {};
  const dm = d.divida_menor_100 || {};
  const sit = d.situacao || [];
  const per = d.por_periodo || [];
  const faixas = d.por_faixa || [];
  const maxSit = Math.max(1, ...sit.map((x) => Number(x.valor) || 0));
  const maxFx = Math.max(1, ...faixas.map((x) => Number(x.valor) || 0));
  const corSit = { "Em negociação": "#16a34a", "Contatado": "#0ea5e9", "Sem negociar": "#f59e0b" };

  return (
    <div style={S.wrap}>
      <div style={S.head}>
        <h2 style={S.h2}>Carteira 360 — Recuperação ULBRA</h2>
        <span style={S.selo}>{d.referencia || "Visão a partir de 13/07/2026"}</span>
      </div>

      <div style={S.heroRow}>
        <Hero rot="Base total" cpfs={bt.cpfs} valor={bt.valor} sub={num(bt.titulos) + " títulos"} cor="#334155" />
        <Hero rot="Operação · 2026" cpfs={op.cpfs} valor={op.valor} sub={num(op.titulos) + " títulos"} cor="#1e40af" destaque />
        <Hero rot="Ação massiva · 2024-2025" cpfs={ms.cpfs} valor={ms.valor} sub={num(ms.titulos) + " títulos"} cor="#b45309" />
        <Hero rot="Trabalhável" cpfs={tr.cpfs} valor={tr.valor} sub="tem telefone e ≥ R$100" cor="#16a34a" />
      </div>

      <div style={S.miniRow}>
        <Mini rot="Sem telefone válido" cpfs={st.cpfs} valor={st.valor} />
        <Mini rot="Dívida < R$ 100" cpfs={dm.cpfs} valor={dm.valor} />
      </div>

      <div style={S.grid2}>
        <div style={S.bloco}>
          <h3 style={S.h3}>Situação (por CPF)</h3>
          {sit.map((s) => (
            <div key={s.situacao} style={S.linha}>
              <div style={S.linhaTopo}>
                <span><span style={{ ...S.dot, background: corSit[s.situacao] || "#94a3b8" }} />{s.situacao} · {num(s.cpfs)} CPFs</span>
                <strong>{moeda(s.valor)}</strong>
              </div>
              <div style={S.track}><div style={{ ...S.fill, width: Math.max(2, (Number(s.valor) / maxSit) * 100) + "%", background: corSit[s.situacao] || "#94a3b8" }} /></div>
            </div>
          ))}
        </div>

        <div style={S.bloco}>
          <h3 style={S.h3}>Faixa de atraso</h3>
          {faixas.map((f) => (
            <div key={f.faixa} style={S.linha}>
              <div style={S.linhaTopo}>
                <span>{String(f.faixa).replace(/^\d\s/, "")} · {num(f.cpfs)} CPFs</span>
                <strong>{moeda(f.valor)}</strong>
              </div>
              <div style={S.track}><div style={{ ...S.fill, width: Math.max(2, (Number(f.valor) / maxFx) * 100) + "%", background: "#4338ca" }} /></div>
            </div>
          ))}
        </div>
      </div>

      <div style={S.bloco}>
        <h3 style={S.h3}>Por período da dívida — operação × ação massiva</h3>
        <div style={S.tabelaWrap}>
          <table style={S.tabela}>
            <thead>
              <tr>
                <th style={S.th}>Período</th>
                <th style={S.thNum}>CPFs</th>
                <th style={S.thNum}>Títulos</th>
                <th style={S.thNum}>Valor total</th>
                <th style={S.thNum}>Operação</th>
                <th style={S.thNum}>Ação massiva</th>
              </tr>
            </thead>
            <tbody>
              {per.map((p) => {
                const ehOp = p.periodo === "2026/1";
                return (
                  <tr key={p.periodo} style={ehOp ? S.trOp : null}>
                    <td style={S.tdMes}>{p.periodo}{ehOp ? <span style={S.tag}>operação</span> : null}</td>
                    <td style={S.td}>{num(p.cpfs)}</td>
                    <td style={S.td}>{num(p.titulos)}</td>
                    <td style={S.tdForte}>{moeda(p.valor)}</td>
                    <td style={S.tdOp}>{moeda(p.operacao)}</td>
                    <td style={S.tdMs}>{moeda(p.massiva)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <p style={S.rodape}>{d.referencia || "Visão a partir de 13/07/2026"} · valores em saldo aberto · acordos não incluídos nesta visão.</p>
    </div>
  );
}

function Hero({ rot, cpfs, valor, sub, cor, destaque }) {
  return (
    <div style={destaque ? S.heroDestaque : S.hero}>
      <span style={S.heroRot}>{rot}</span>
      <span style={{ ...S.heroVal, color: cor }}>{moeda(valor)}</span>
      <span style={S.heroCpfs}>{num(cpfs)} CPFs · {sub}</span>
    </div>
  );
}
function Mini({ rot, cpfs, valor }) {
  return (
    <div style={S.mini}>
      <span style={S.miniRot}>{rot}</span>
      <span style={S.miniVal}>{moeda(valor)} · {num(cpfs)} CPFs</span>
    </div>
  );
}

const S = {
  wrap: { marginBottom: 22, fontFamily: "Inter, system-ui, sans-serif" },
  head: { display: "flex", alignItems: "baseline", gap: 12, marginBottom: 14, flexWrap: "wrap" },
  h2: { margin: 0, fontSize: 22, fontWeight: 800, color: "#0f172a", letterSpacing: "-0.02em" },
  selo: { fontSize: 12, fontWeight: 700, color: "#4338ca", background: "#eef2ff", border: "1px solid #c7d2fe", borderRadius: 999, padding: "3px 12px" },
  heroRow: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 14, marginBottom: 12 },
  hero: { background: "#fff", border: "1px solid #eef1f6", borderRadius: 16, padding: "16px 18px", display: "flex", flexDirection: "column", gap: 5, boxShadow: "0 1px 2px rgba(15,23,42,0.04)" },
  heroDestaque: { background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 16, padding: "16px 18px", display: "flex", flexDirection: "column", gap: 5, boxShadow: "0 1px 2px rgba(15,23,42,0.04)" },
  heroRot: { fontSize: 12.5, color: "#64748b", fontWeight: 600 },
  heroVal: { fontSize: 27, fontWeight: 800, lineHeight: 1.05, letterSpacing: "-0.02em" },
  heroCpfs: { fontSize: 12, color: "#94a3b8", fontWeight: 600 },
  miniRow: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 14, marginBottom: 16 },
  mini: { background: "#fafbfc", border: "1px solid #eef1f6", borderRadius: 12, padding: "12px 16px", display: "flex", flexDirection: "column", gap: 3 },
  miniRot: { fontSize: 12, color: "#94a3b8", fontWeight: 600 },
  miniVal: { fontSize: 15, fontWeight: 800, color: "#334155" },
  grid2: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 14, marginBottom: 14 },
  bloco: { background: "#fff", border: "1px solid #eef1f6", borderRadius: 16, padding: 18, marginBottom: 14, boxShadow: "0 1px 2px rgba(15,23,42,0.04)" },
  h3: { margin: "0 0 14px", fontSize: 14, fontWeight: 700, color: "#0f172a" },
  linha: { marginBottom: 12 },
  linhaTopo: { display: "flex", justifyContent: "space-between", gap: 10, fontSize: 13, color: "#334155", marginBottom: 5 },
  dot: { display: "inline-block", width: 9, height: 9, borderRadius: 9, marginRight: 6 },
  track: { background: "#f1f5f9", borderRadius: 999, height: 10, overflow: "hidden" },
  fill: { height: "100%", borderRadius: 999 },
  tabelaWrap: { overflowX: "auto" },
  tabela: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", padding: "9px 10px", color: "#94a3b8", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", whiteSpace: "nowrap" },
  thNum: { textAlign: "right", padding: "9px 10px", color: "#94a3b8", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", whiteSpace: "nowrap" },
  trOp: { background: "#eff6ff" },
  tdMes: { padding: "9px 10px", fontWeight: 700, color: "#334155", whiteSpace: "nowrap" },
  tag: { marginLeft: 6, background: "#dbeafe", color: "#1e40af", borderRadius: 999, padding: "1px 8px", fontSize: 10, fontWeight: 800 },
  td: { padding: "9px 10px", textAlign: "right", color: "#64748b", whiteSpace: "nowrap" },
  tdForte: { padding: "9px 10px", textAlign: "right", color: "#0f172a", fontWeight: 700, whiteSpace: "nowrap" },
  tdOp: { padding: "9px 10px", textAlign: "right", color: "#1e40af", fontWeight: 700, whiteSpace: "nowrap" },
  tdMs: { padding: "9px 10px", textAlign: "right", color: "#b45309", fontWeight: 600, whiteSpace: "nowrap" },
  rodape: { color: "#94a3b8", fontSize: 12, marginTop: 6 },
  card: { background: "#fff", border: "1px solid #eef1f6", borderRadius: 16, padding: 18, marginBottom: 16 },
  muted: { color: "#64748b", margin: 0 },
};
