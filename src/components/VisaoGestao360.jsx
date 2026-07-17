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
  const [ufSel, setUfSel] = useState(null);
  const [saude, setSaude] = useState(null);
  const [fatur, setFatur] = useState(null);
  const [proj, setProj] = useState(null);
  const [mensal, setMensal] = useState(null);
  const [funil, setFunil] = useState(null);
  const [volume, setVolume] = useState(null);
  const [metaProj, setMetaProj] = useState(null);

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
    supabase.rpc("dashboard_faturamento_anual").then(({ data }) => { if (ativo) setFatur(data); });
    supabase.rpc("dashboard_projecao_semestre").then(({ data }) => { if (ativo) setProj(data); });
    supabase.rpc("dashboard_faturamento_mensal_yoy").then(({ data }) => { if (ativo) setMensal(data); });
    supabase.rpc("dashboard_funil_conversao").then(({ data }) => { if (ativo) setFunil(data); });
    supabase.rpc("dashboard_volume_envios", { p_dias: 14 }).then(({ data }) => { if (ativo) setVolume(data); });
    supabase.rpc("dashboard_projecao_semestre").then(({ data }) => { if (ativo) setMetaProj(data); });
    return () => { ativo = false; };
  }, []);

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
  const base = d.base || {};
  const ac = d.acordos_ativos || {};
  const ops = d.por_operador || [];
  const atraso = d.faixa_atraso || [];
  const anos = d.por_ano || [];
  const unis = d.por_unidade || [];
  const aging = d.aging_acionamento || [];
  const carteira = d.situacao_carteira || [];

  const maxAtraso = Math.max(1, ...atraso.map((x) => Number(x.valor) || 0));
  const maxAno = Math.max(1, ...anos.map((x) => Number(x.valor) || 0));
  const maxUni = Math.max(1, ...unis.map((x) => Number(x.valor) || 0));
  const maxAging = Math.max(1, ...aging.map((x) => Number(x.alunos) || 0));
  const maxCarteira = Math.max(1, ...carteira.map((x) => Number(x.qtd) || 0));
  const porUF = {};
  let semUF = 0;
  (unis || []).forEach((x) => {
    const uf = ufDaUnidade(x.unidade);
    if (!uf) { semUF += Number(x.valor) || 0; return; }
    if (!porUF[uf]) porUF[uf] = { uf, valor: 0, recuperado: 0, titulos: 0 };
    porUF[uf].valor += Number(x.valor) || 0;
    porUF[uf].recuperado += Number(x.recuperado) || 0;
    porUF[uf].titulos += Number(x.titulos) || 0;
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
        <Stat rot="Base histórica (CPFs)" val={num(base.total)} cor="#94a3b8" />
        <Stat rot="Carteira a cobrar" val={num(base.com_divida)} cor="#111827" />
        <Stat rot="Já recuperados" val={num(base.quitados)} cor="#16a34a" />
        <Stat rot="Sem dívida em aberto" val={num((base.ativos || 0) - (base.com_divida || 0))} cor="#f59e0b" />
        <Stat rot="Valor a cobrar" val={moeda(base.valor_total)} cor="#16a34a" />
      </div>

      <div style={s.bloco}>
        <h3 style={s.h3}>Funil da base</h3>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 170, background: "#f1f5f9", borderRadius: 10, padding: 14 }}>
            <div style={{ fontSize: 24, fontWeight: 800, color: "#475569" }}>{num(base.total)}</div>
            <div style={{ fontSize: 12, color: "#64748b", fontWeight: 600 }}>Base histórica (CPFs)</div>
          </div>
          <div style={{ flex: 1, minWidth: 170, background: "#dbeafe", borderRadius: 10, padding: 14 }}>
            <div style={{ fontSize: 24, fontWeight: 800, color: "#1d4ed8" }}>{num(base.com_divida)}</div>
            <div style={{ fontSize: 12, color: "#1e40af", fontWeight: 600 }}>Carteira a cobrar · {moeda(base.valor_total)}</div>
          </div>
          <div style={{ flex: 1, minWidth: 170, background: "#dcfce7", borderRadius: 10, padding: 14 }}>
            <div style={{ fontSize: 24, fontWeight: 800, color: "#15803d" }}>{num(base.quitados)}</div>
            <div style={{ fontSize: 12, color: "#166534", fontWeight: 600 }}>Já recuperados (fichas)</div>
          </div>
        </div>
        <p style={s.muted}>Base histórica = CPFs importados. Carteira a cobrar = quem tem título em aberto hoje. O restante está sem dívida em aberto ou já quitado.</p>
      </div>

      {saude && (
        <div style={s.bloco}>
          <h3 style={s.h3}>Saúde da base — nunca acionados por faixa</h3>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
            <div style={{ flex: 1, minWidth: 180, background: "#eff6ff", borderRadius: 10, padding: 12 }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: "#1d4ed8" }}>{num(saude.na_operacao_total)}</div>
              <div style={{ fontSize: 12, color: "#1e40af", fontWeight: 600 }}>Na operação, nunca tocados · {moeda(saude.na_operacao_valor)}</div>
            </div>
            <div style={{ flex: 1, minWidth: 180, background: "#fef3c7", borderRadius: 10, padding: 12 }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: "#b45309" }}>{num(saude.fora_operacao_total)}</div>
              <div style={{ fontSize: 12, color: "#92400e", fontWeight: 600 }}>Fora da operação (candidatos a ação massiva) · {moeda(saude.fora_operacao_valor)}</div>
            </div>
          </div>
          {(() => { const maxF = Math.max(1, ...(saude.faixas || []).map((y) => (Number(y.na_operacao) || 0) + (Number(y.fora_operacao) || 0))); return (saude.faixas || []).map((f) => {
            const tot = (Number(f.na_operacao) || 0) + (Number(f.fora_operacao) || 0);
            return (
              <div key={f.faixa} style={s.linha}>
                <div style={s.linhaTopo}><span>{f.faixa}</span><strong>{num(tot)} alunos</strong></div>
                <div style={{ ...s.barTrack, display: "flex" }}>
                  <div style={{ height: "100%", width: ((Number(f.na_operacao) / maxF) * 100) + "%", background: "#2563eb" }} />
                  <div style={{ height: "100%", width: ((Number(f.fora_operacao) / maxF) * 100) + "%", background: "#eda100" }} />
                </div>
              </div>
            );
          }); })()}
          <div style={{ display: "flex", gap: 16, marginTop: 8, fontSize: 12, color: "#64748b" }}>
            <span><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: "#2563eb", marginRight: 4 }} />Na operação (fila de operador)</span>
            <span><span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: "#eda100", marginRight: 4 }} />Fora da operação (ação massiva)</span>
          </div>
        </div>
      )}

      {fatur && (
        <div style={s.bloco}>
          <h3 style={s.h3}>Faturamento ano a ano</h3>
          <div style={s.tblScroll}>
            <div style={{ ...s.tblRow, ...s.tblHead, gridTemplateColumns: "0.7fr 1.4fr 1.4fr 1.1fr", minWidth: 520 }}>
              <span>Ano</span><span>Recuperado</span><span>Honorários</span><span>Alunos pagos</span>
            </div>
            {(fatur.anos || []).map((a) => (
              <div key={a.ano} style={{ ...s.tblRow, gridTemplateColumns: "0.7fr 1.4fr 1.4fr 1.1fr", minWidth: 520 }}>
                <span style={s.opName}>{a.ano}</span>
                <span>{moeda(a.recuperado)} {a.var_recuperado_pct != null && <em style={{ ...s.em, color: a.var_recuperado_pct >= 0 ? "#16a34a" : "#ef4444" }}>({a.var_recuperado_pct >= 0 ? "+" : ""}{a.var_recuperado_pct}%)</em>}</span>
                <span>{moeda(a.honorarios)} {a.var_honorarios_pct != null && <em style={{ ...s.em, color: a.var_honorarios_pct >= 0 ? "#16a34a" : "#ef4444" }}>({a.var_honorarios_pct >= 0 ? "+" : ""}{a.var_honorarios_pct}%)</em>}</span>
                <span>{num(a.alunos_pagos)} {a.var_alunos_pct != null && <em style={{ ...s.em, color: a.var_alunos_pct >= 0 ? "#16a34a" : "#ef4444" }}>({a.var_alunos_pct >= 0 ? "+" : ""}{a.var_alunos_pct}%)</em>}</span>
              </div>
            ))}
          </div>
          <p style={s.muted}>Unifica pagamentos operacionais + histórico retroativo. Variação % vs ano anterior.</p>
        </div>
      )}

      {proj && (
        <div style={s.bloco}>
          <h3 style={s.h3}>Projeção de semestre (ritmo atual)</h3>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
            <div style={{ flex: 1, minWidth: 160, background: "#f1f5f9", borderRadius: 10, padding: 12 }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: "#475569" }}>{moeda(proj.recuperado_mtd)}</div>
              <div style={{ fontSize: 12, color: "#64748b", fontWeight: 600 }}>Realizado no mês ({proj.dias_decorridos}/{proj.dias_mes} dias)</div>
            </div>
            <div style={{ flex: 1, minWidth: 160, background: "#dbeafe", borderRadius: 10, padding: 12 }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: "#1d4ed8" }}>{moeda(proj.proj_mes_recuperado)}</div>
              <div style={{ fontSize: 12, color: "#1e40af", fontWeight: 600 }}>Projeção do mês fechado</div>
            </div>
            <div style={{ flex: 1, minWidth: 160, background: "#dcfce7", borderRadius: 10, padding: 12 }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: "#15803d" }}>{moeda(proj.semestre_total_recuperado)}</div>
              <div style={{ fontSize: 12, color: "#166534", fontWeight: 600 }}>Projeção 6 meses — recuperado</div>
            </div>
            <div style={{ flex: 1, minWidth: 160, background: "#dcfce7", borderRadius: 10, padding: 12 }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: "#15803d" }}>{moeda(proj.semestre_total_honorarios)}</div>
              <div style={{ fontSize: 12, color: "#166534", fontWeight: 600 }}>Projeção 6 meses — honorários</div>
            </div>
          </div>
          <p style={s.muted}>Projeção linear pelo ritmo diário do mês atual. Recalcula sozinho conforme entram pagamentos e novos meses.</p>
        </div>
      )}

      {mensal && (mensal.meses || []).length > 0 && (
        <div style={s.bloco}>
          <h3 style={s.h3}>Comparativo mensal ano a ano (sazonalidade)</h3>
          <div style={s.tblScroll}>
            <div style={{ ...s.tblRow, ...s.tblHead, gridTemplateColumns: "0.6fr repeat(" + mensal.anos.length + ", 1fr)", minWidth: 120 + mensal.anos.length * 150 }}>
              <span>Mês</span>
              {mensal.anos.map((y) => (<span key={y}>{y}</span>))}
            </div>
            {mensal.meses.map((m) => (
              <div key={m.mes_num} style={{ ...s.tblRow, gridTemplateColumns: "0.6fr repeat(" + mensal.anos.length + ", 1fr)", minWidth: 120 + mensal.anos.length * 150 }}>
                <span style={s.opName}>{m.mes_label}</span>
                {mensal.anos.map((y) => {
                  const sy = (m.series || []).find((x) => x.ano === y);
                  return <span key={y}>{sy ? moeda(sy.recuperado) : "—"}</span>;
                })}
              </div>
            ))}
          </div>
          <p style={s.muted}>Recuperado por mês, anos lado a lado. Conforme você importa os meses retroativos, dá pra comparar o mesmo mês entre anos e enxergar picos sazonais (ex.: matrícula).</p>
        </div>
      )}

      {funil && (
        <div style={s.bloco}>
          <h3 style={s.h3}>Funil de conversão operacional</h3>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            {[funil.links, funil.acordos, funil.confirmacoes].filter(Boolean).map((f) => (
              <div key={f.label} style={{ flex: 1, minWidth: 200, background: "#f8fafc", borderRadius: 12, padding: 14 }}>
                <div style={{ fontSize: 13, color: "#64748b", fontWeight: 600, marginBottom: 6 }}>{f.label}</div>
                <div style={{ fontSize: 26, fontWeight: 800, color: f.pct >= 60 ? "#16a34a" : f.pct >= 35 ? "#f59e0b" : "#ef4444" }}>{f.pct}%</div>
                <div style={{ fontSize: 12, color: "#334155", marginTop: 4 }}>{num(f.para)} {f.para_label} de {num(f.de)} {f.de_label}</div>
                <div style={{ ...s.barTrack, marginTop: 8 }}>
                  <div style={{ ...s.barFill, width: Math.max(2, Number(f.pct)) + "%", background: f.pct >= 60 ? "#16a34a" : f.pct >= 35 ? "#f59e0b" : "#ef4444" }} />
                </div>
              </div>
            ))}
          </div>
          <p style={s.muted}>Onde a operação converte (ou vaza): link enviado → pago, acordo fechado → quitado, confirmação solicitada → confirmada.</p>
        </div>
      )}

      {volume && (
        <div style={s.bloco}>
          <h3 style={s.h3}>Volume de acionamentos por operador (últ. {volume.dias} dias)</h3>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
            <div style={{ background: "#dcfce7", borderRadius: 10, padding: "8px 14px", fontSize: 13, fontWeight: 700, color: "#166534" }}>WhatsApp/Contato: {num(volume.por_canal?.whatsapp)}</div>
            <div style={{ background: "#dbeafe", borderRadius: 10, padding: "8px 14px", fontSize: 13, fontWeight: 700, color: "#1e40af" }}>E-mail: {num(volume.por_canal?.email)}</div>
            <div style={{ background: "#f1f5f9", borderRadius: 10, padding: "8px 14px", fontSize: 13, fontWeight: 700, color: "#475569" }}>Outros: {num(volume.por_canal?.outros)}</div>
          </div>
          <div style={s.tblScroll}>
            <div style={{ ...s.tblRow, ...s.tblHead, gridTemplateColumns: "1.6fr 0.8fr 1fr 0.8fr", minWidth: 480 }}>
              <span>Operador</span><span>Total</span><span>WhatsApp</span><span>E-mail</span>
            </div>
            {(volume.por_operador || []).slice(0, 15).map((o) => (
              <div key={o.operador} style={{ ...s.tblRow, gridTemplateColumns: "1.6fr 0.8fr 1fr 0.8fr", minWidth: 480 }}>
                <span style={s.opName}>{o.operador}</span>
                <span><strong>{num(o.total)}</strong></span>
                <span>{num(o.whatsapp)}</span>
                <span>{num(o.email)}</span>
              </div>
            ))}
          </div>
          <p style={s.muted}>Cada envio (WhatsApp, e-mail ou contato) conta como acionamento. Útil para acompanhar produtividade e o limite diário do Gmail.</p>
        </div>
      )}

      {metaProj && (metaProj.meta_recuperacao || metaProj.meta_honorario) && (
        <div style={s.bloco}>
          <h3 style={s.h3}>Meta × realizado do mês ({metaProj.mes_atual}) — {metaProj.dias_decorridos}/{metaProj.dias_mes} dias</h3>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            {[{ rot: "Recuperado", meta: metaProj.meta_recuperacao, real: metaProj.recuperado_mtd, proj: metaProj.proj_mes_recuperado }, { rot: "Honorários", meta: metaProj.meta_honorario, real: metaProj.honorarios_mtd, proj: metaProj.proj_mes_honorarios }].filter((x) => x.meta).map((x) => {
              const pct = x.meta ? Math.round((x.real / x.meta) * 100) : 0;
              const pctProj = x.meta ? Math.round((x.proj / x.meta) * 100) : 0;
              const noRitmo = x.proj >= x.meta;
              return (
                <div key={x.rot} style={{ flex: 1, minWidth: 240, background: "#f8fafc", borderRadius: 12, padding: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                    <span style={{ fontSize: 13, color: "#64748b", fontWeight: 700 }}>{x.rot}</span>
                    <span style={{ fontSize: 12, fontWeight: 700, color: noRitmo ? "#16a34a" : "#dc2626", background: noRitmo ? "#dcfce7" : "#fee2e2", borderRadius: 999, padding: "2px 10px" }}>{noRitmo ? "No ritmo" : "Abaixo da meta"}</span>
                  </div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: "#111827" }}>{moeda(x.real)} <span style={{ fontSize: 13, color: "#64748b", fontWeight: 600 }}>/ {moeda(x.meta)}</span></div>
                  <div style={{ fontSize: 12, color: "#334155", margin: "4px 0 8px" }}>{pct}% da meta · projeção do mês: {moeda(x.proj)} ({pctProj}%)</div>
                  <div style={s.barTrack}><div style={{ ...s.barFill, width: Math.min(100, Math.max(2, pct)) + "%", background: noRitmo ? "#16a34a" : "#f59e0b" }} /></div>
                </div>
              );
            })}
          </div>
          <p style={s.muted}>Meta do mês (cadastrada em Metas) vs realizado até hoje e projeção pelo ritmo atual. Alerta automático quando a projeção fica abaixo da meta.</p>
        </div>
      )}

      <div style={s.statsRow}>
        <Stat rot="Recuperado" val={moeda(rec.recuperado)} cor="#16a34a" />
        <Stat rot="Honorarios" val={moeda(rec.honorarios)} cor="#0ea5e9" />
        <Stat rot="Acordos ativos" val={num(ac.qtd)} cor="#7c3aed" />
        <Stat rot="Lancamentos" val={num(rec.lancamentos)} cor="#f59e0b" />
      </div>

      <div style={s.bloco}>
        <h3 style={s.h3}>Situacao da carteira (apta para cobranca hoje)</h3>
        {carteira.map((x) => {
          const cor = x.categoria === "Acordo em dia" ? "#22c55e" : x.categoria === "Acordo em atraso ate 30d" ? "#f59e0b" : x.categoria === "Acordo quebrado" ? "#ef4444" : "#2563eb";
          return (
            <div key={x.categoria} style={s.linha}>
              <div style={s.linhaTopo}><span>{x.categoria}</span><strong>{num(x.qtd)} <em style={s.em}>({Number(x.pct).toFixed(1)}%)</em></strong></div>
              <div style={s.barTrack}><div style={{ ...s.barFill, width: Math.max(2, (Number(x.qtd) / maxCarteira) * 100) + "%", background: cor }} /></div>
            </div>
          );
        })}
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

      <div style={s.bloco}>
        <h3 style={s.h3}>Aging - dias sem acionamento</h3>
        {aging.map((x) => {
          const cor = x.faixa === "0-3 dias" ? "#22c55e" : x.faixa === "4-10 dias" ? "#f59e0b" : x.faixa === "11+ dias" ? "#ef4444" : "#94a3b8";
          return (
            <div key={x.faixa} style={s.linha}>
              <div style={s.linhaTopo}><span>{x.faixa}</span><strong>{num(x.alunos)} alunos</strong></div>
              <div style={s.barTrack}><div style={{ ...s.barFill, width: Math.max(2, (Number(x.alunos) / maxAging) * 100) + "%", background: cor }} /></div>
            </div>
          );
        })}
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
                  onClick={() => info && setUfSel(uf === ufSel ? null : uf)}
                  style={{ ...s.uf, gridColumn: UF_POS[uf][0], gridRow: UF_POS[uf][1],
                    cursor: info ? "pointer" : "default",
                    outline: uf === ufSel ? "3px solid #1d4ed8" : "none", outlineOffset: 1,
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
        {(() => {
          const sel = ufSel || (ufOrdenado[0] && ufOrdenado[0].uf);
          const info = sel && porUF[sel];
          if (!info) return null;
          const pctRec = info.valor > 0 ? (info.recuperado / info.valor) * 100 : 0;
          return (
            <div style={s.ufDetalhe}>
              <div style={s.ufDetHead}>{sel} - detalhe do estado{ufSel ? "" : " (maior carteira)"}</div>
              <div style={s.ufDetGrid}>
                <Stat rot="Titulos em aberto" val={num(info.titulos)} cor="#0ea5e9" />
                <Stat rot="Valor em aberto" val={moeda(info.valor)} cor="#111827" />
                <Stat rot="Recuperado" val={moeda(info.recuperado)} cor="#16a34a" />
                <Stat rot="% recuperado" val={pctRec.toFixed(1) + "%"} cor="#7c3aed" />
              </div>
            </div>
          );
        })()}
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
  ufDetalhe: { marginTop: 16, borderTop: "1px dashed #e2e8f0", paddingTop: 14 },
  ufDetHead: { fontSize: 13, fontWeight: 700, color: "#0f172a", marginBottom: 10 },
  ufDetGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 },
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
