// Saúde Completa da Carteira — tela de leitura/análise (gestão global; operador
// escopado no backend). NÃO recalcula nada no cliente: todos os números vêm das
// RPCs saude_carteira_resumo / _detalhes / _qualidade / _exportar / _historico.
// "Atualizar indicadores" apenas refaz a consulta.
import { useCallback, useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import BotaoAtualizar from "../components/BotaoAtualizar";
import { useAnaliticaSobDemanda } from "../hooks/useAnaliticaSobDemanda";
import { exportarSaudeCarteira } from "../utils/exportarSaudeCarteira";

const FONTE = "'Sora','Inter',system-ui,sans-serif";
const moeda = (v) => Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const num = (v) => Number(v || 0).toLocaleString("pt-BR");
const dataBR = (v) => (v ? new Date(v).toLocaleDateString("pt-BR") : "—");

const FAIXAS_ATRASO = [
  ["a_vencer", "A vencer", "A_VENCER"], ["f1_30", "1-30", "1_30"], ["f31_60", "31-60", "31_60"],
  ["f61_90", "61-90", "61_90"], ["f91_180", "91-180", "91_180"], ["f181_365", "181-365", "181_365"],
  ["f_mais_365", "365+", "MAIS_365"],
];
const FAIXAS_TEMPO = [
  ["nunca", "Nunca", "NUNCA"], ["d1", "1d", "1D"], ["d2_3", "2-3d", "2_3D"], ["d4_5", "4-5d", "4_5D"],
  ["d6_7", "6-7d", "6_7D"], ["d8_15", "8-15d", "8_15D"], ["d16_30", "16-30d", "16_30D"], ["d_mais_30", "30d+", "MAIS_30D"],
];
const CARDS = [
  ["casos_ativos", "Casos ativos", num], ["cpfs_unicos", "CPFs únicos", num],
  ["saldo_vencido", "Saldo vencido", moeda], ["saldo_total", "Saldo total", moeda],
  ["nunca_acionados", "Nunca acionados", num, "nunca_acionados"],
  ["sem_acionamento_limite", "Sem acionamento (limite)", num, "sem_acionamento_limite"],
  ["pct_sem_acionamento", "% sem acionamento", (v) => `${Number(v || 0).toFixed(1)}%`],
  ["retornos_vencidos", "Retornos vencidos", num, "retornos_vencidos"],
  ["sem_telefone", "Sem telefone", num, "sem_telefone"],
  ["sem_responsavel", "Sem responsável", num, "sem_responsavel"],
  ["criticos", "Críticos", num, "criticos"], ["urgentes", "Urgentes", num, "urgentes"],
  ["acordos_em_dia", "Acordos em dia", num, "acordos_em_dia"],
  ["acordos_vencidos", "Acordos vencidos", num, "acordos_vencidos"],
  ["acordos_em_dia_sem_acompanhamento", "Acordos em dia s/ acompanhamento", num, "acordos_em_dia_sem_acompanhamento"],
  ["casos_revisao", "Casos para revisão", num, "casos_revisao"],
];
const QUALIDADE_LABEL = {
  sem_telefone: "Sem telefone", sem_email: "Sem e-mail", sem_responsavel: "Sem responsável",
  sem_estabelecimento: "Sem estabelecimento", sem_faixa_atraso: "Sem faixa de atraso",
  saldo_zero_ativo: "Saldo zero ainda ativo", caso_sem_aluno: "Caso sem vínculo com aluno",
  acordo_vencido_sem_saldo: "Acordo vencido sem saldo", sem_cpf: "Sem CPF",
  critico_sem_saldo_vencido: "Crítico sem saldo vencido",
};

export default function SaudeCompletaCarteira() {
  const [filtros, setFiltros] = useState({ min_dias_sem_acionamento: 5 });
  const { data: resumo, carregando, ultimaEm, atualizar } =
    useAnaliticaSobDemanda("saude_carteira_resumo", { p_filtros: filtros }, { timeoutMs: 20000 });

  const [qualidade, setQualidade] = useState(null);
  const [metricaFaixa, setMetricaFaixa] = useState("casos");
  const [ordEstab, setOrdEstab] = useState({ col: "sem_acionamento_limite", dir: "desc" });
  const [exportando, setExportando] = useState(false);

  // detalhamento (drill-down)
  const [drill, setDrill] = useState(null); // {titulo, filtro}
  const [det, setDet] = useState(null);
  const [detPag, setDetPag] = useState({ limite: 50, offset: 0 });
  const [detOrd, setDetOrd] = useState({ ordenar_por: "saldo_vencido", ordem_dir: "desc" });
  const [detLoading, setDetLoading] = useState(false);

  const totais = resumo?.totais || {};
  const isGestao = resumo?.escopo?.is_gestao;

  const carregar = useCallback(async () => {
    await atualizar();
    const { data } = await supabase.rpc("saude_carteira_qualidade", { p_filtros: filtros });
    setQualidade(data?.qualidade || null);
  }, [atualizar, filtros]);

  const carregarDetalhe = useCallback(async (filtroExtra, pag, ord) => {
    setDetLoading(true);
    try {
      const p = { ...filtros, ...filtroExtra, ...ord };
      const { data, error } = await supabase.rpc("saude_carteira_detalhes", {
        p_filtros: p, p_limite: pag.limite, p_offset: pag.offset,
      });
      if (!error) setDet(data);
    } finally {
      setDetLoading(false);
    }
  }, [filtros]);

  const abrirDrill = (titulo, filtroExtra) => {
    const pag = { limite: 50, offset: 0 };
    setDrill({ titulo, filtro: filtroExtra });
    setDetPag(pag);
    carregarDetalhe(filtroExtra, pag, detOrd);
  };

  useEffect(() => {
    if (!drill) return;
    carregarDetalhe(drill.filtro, detPag, detOrd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detPag.offset, detOrd.ordenar_por, detOrd.ordem_dir]);

  const exportar = async () => {
    setExportando(true);
    try {
      const { data, error } = await supabase.rpc("saude_carteira_exportar", { p_filtros: filtros });
      if (error) { alert("Não foi possível exportar agora."); return; }
      await exportarSaudeCarteira(data, filtros);
    } catch {
      alert("Falha ao gerar o Excel.");
    } finally {
      setExportando(false);
    }
  };

  const estabs = [...(resumo?.estabelecimentos || [])].sort((a, b) => {
    const s = (ordEstab.dir === "asc" ? 1 : -1);
    const va = a[ordEstab.col], vb = b[ordEstab.col];
    if (typeof va === "string") return s * String(va).localeCompare(String(vb));
    return s * ((va || 0) - (vb || 0));
  });
  const mtxFaixa = resumo?.matriz_faixa_atraso || [];
  const mtxTempo = resumo?.matriz_tempo_sem_acionamento || [];
  const operadores = resumo?.operadores || [];

  const totalGeral = (lista, col) => lista.reduce((s, x) => s + Number(x[col] || 0), 0);

  return (
    <div style={{ padding: 20, fontFamily: FONTE, maxWidth: 1500, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, color: "#0f172a" }}>Saúde Completa da Carteira</h1>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "#64748b" }}>
            Análise somente leitura · {isGestao === false ? "sua carteira" : "visão global"}
            {resumo?.atualizado_em ? ` · base atualizada em ${new Date(resumo.atualizado_em).toLocaleString("pt-BR")}` : ""}
          </p>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <BotaoAtualizar carregando={carregando} ultimaEm={ultimaEm} onClick={carregar} rotulo="Atualizar indicadores" />
          <button onClick={exportar} disabled={exportando || !resumo} style={btnSec}>
            {exportando ? "Gerando…" : "⬇ Exportar Excel"}
          </button>
        </div>
      </div>

      <Filtros filtros={filtros} setFiltros={setFiltros} estabs={resumo?.estabelecimentos || []} operadores={operadores} isGestao={isGestao} />

      {!resumo && !carregando && (
        <div style={vazio}>Clique em <b>Atualizar indicadores</b> para carregar os dados.</div>
      )}
      {carregando && !resumo && <div style={vazio}>Carregando…</div>}

      {resumo && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(190px,1fr))", gap: 12, marginTop: 16 }}>
            {CARDS.map(([k, label, fmt, indicador]) => (
              <button key={k} onClick={() => indicador && abrirDrill(label, { indicador })}
                style={{ ...card, cursor: indicador ? "pointer" : "default" }}>
                <div style={{ fontSize: 12, color: "#64748b", fontWeight: 600 }}>{label}</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: "#0f172a", marginTop: 4 }}>{fmt(totais[k])}</div>
                {indicador && <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 2 }}>ver lista →</div>}
              </button>
            ))}
          </div>

          <Secao titulo="Por estabelecimento">
            <div style={{ overflowX: "auto" }}>
              <table style={tabela}>
                <thead><tr>
                  {[["estabelecimento", "Estabelecimento"], ["casos_ativos", "Casos"], ["cpfs_unicos", "CPFs"],
                    ["saldo_vencido", "Saldo vencido"], ["saldo_total", "Saldo total"], ["nunca_acionados", "Nunca acion."],
                    ["sem_acionamento_limite", "Sem acion. (lim.)"], ["pct_sem_acionamento", "%"], ["sem_ac_7", ">7d"],
                    ["sem_ac_15", ">15d"], ["sem_ac_30", ">30d"], ["retornos_vencidos", "Ret. venc."],
                    ["sem_telefone", "S/ tel."], ["sem_responsavel", "S/ resp."], ["criticos", "Crít."],
                    ["urgentes", "Urg."], ["acordos_em_dia", "Ac. dia"], ["acordos_vencidos", "Ac. venc."],
                    ["acordos_quebrados", "Ac. quebr."], ["casos_revisao", "Revisão"]].map(([col, lbl]) => (
                    <th key={col} onClick={() => setOrdEstab((o) => ({ col, dir: o.col === col && o.dir === "desc" ? "asc" : "desc" }))}
                      style={{ ...th, cursor: "pointer" }}>{lbl}{ordEstab.col === col ? (ordEstab.dir === "desc" ? " ▼" : " ▲") : ""}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {estabs.map((e) => (
                    <tr key={e.estabelecimento} style={{ borderTop: "1px solid #eef2f7" }}>
                      <td style={{ ...td, fontWeight: 600, cursor: "pointer" }} onClick={() => abrirDrill(`Estab.: ${e.estabelecimento}`, { estabelecimento: e.estabelecimento })}>{e.estabelecimento}</td>
                      <td style={td}>{num(e.casos_ativos)}</td><td style={td}>{num(e.cpfs_unicos)}</td>
                      <td style={td}>{moeda(e.saldo_vencido)}</td><td style={td}>{moeda(e.saldo_total)}</td>
                      <td style={td}>{num(e.nunca_acionados)}</td><td style={td}>{num(e.sem_acionamento_limite)}</td>
                      <td style={td}>{Number(e.pct_sem_acionamento || 0).toFixed(0)}%</td><td style={td}>{num(e.sem_ac_7)}</td>
                      <td style={td}>{num(e.sem_ac_15)}</td><td style={td}>{num(e.sem_ac_30)}</td><td style={td}>{num(e.retornos_vencidos)}</td>
                      <td style={td}>{num(e.sem_telefone)}</td><td style={td}>{num(e.sem_responsavel)}</td><td style={td}>{num(e.criticos)}</td>
                      <td style={td}>{num(e.urgentes)}</td><td style={td}>{num(e.acordos_em_dia)}</td><td style={td}>{num(e.acordos_vencidos)}</td>
                      <td style={td}>{num(e.acordos_quebrados)}</td><td style={td}>{num(e.casos_revisao)}</td>
                    </tr>
                  ))}
                  <tr style={{ borderTop: "2px solid #cbd5e1", fontWeight: 800, background: "#f8fafc" }}>
                    <td style={td}>TOTAL DA CARTEIRA</td><td style={td}>{num(totais.casos_ativos)}</td><td style={td}>{num(totais.cpfs_unicos)}</td>
                    <td style={td}>{moeda(totais.saldo_vencido)}</td><td style={td}>{moeda(totais.saldo_total)}</td>
                    <td style={td}>{num(totais.nunca_acionados)}</td><td style={td}>{num(totais.sem_acionamento_limite)}</td>
                    <td style={td}>{Number(totais.pct_sem_acionamento || 0).toFixed(0)}%</td>
                    <td style={td} colSpan={3}></td>
                    <td style={td}>{num(totais.retornos_vencidos)}</td><td style={td}>{num(totais.sem_telefone)}</td>
                    <td style={td}>{num(totais.sem_responsavel)}</td><td style={td}>{num(totais.criticos)}</td><td style={td}>{num(totais.urgentes)}</td>
                    <td style={td}>{num(totais.acordos_em_dia)}</td><td style={td}>{num(totais.acordos_vencidos)}</td>
                    <td style={td}>{num(totais.acordos_quebrados)}</td><td style={td}>{num(totais.casos_revisao)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Secao>

          <Secao titulo="Estabelecimento × faixa de atraso"
            extra={<MetricaToggle valor={metricaFaixa} setValor={setMetricaFaixa} />}>
            <Matriz linhas={mtxFaixa} colunas={FAIXAS_ATRASO} metrica={metricaFaixa}
              onCelula={(estab, faixaFiltro) => abrirDrill(`${estab} · faixa`, { estabelecimento: estab, faixa_atraso: faixaFiltro })} />
          </Secao>

          <Secao titulo="Tempo sem acionamento">
            <Matriz linhas={mtxTempo} colunas={FAIXAS_TEMPO} metrica="casos"
              onCelula={(estab, tempoFiltro) => abrirDrill(`${estab} · tempo`, { estabelecimento: estab, faixa_tempo: tempoFiltro })} />
          </Secao>

          <Secao titulo="Por operador">
            <div style={{ overflowX: "auto" }}>
              <table style={tabela}>
                <thead><tr>{["Operador", "Casos", "CPFs", "Saldo vencido", "Saldo total", "Nunca acion.", "Sem acion.", "%", "Ret. venc.", "S/ tel.", "Crít.", "Urg.", "Ac. dia", "Ac. venc."].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
                <tbody>
                  {operadores.map((o) => (
                    <tr key={o.operador_email} style={{ borderTop: "1px solid #eef2f7", ...(o.operador_email === "(SEM RESPONSAVEL)" ? { background: "#fff7ed" } : {}) }}>
                      <td style={{ ...td, fontWeight: 600, cursor: "pointer" }} onClick={() => o.operador_email !== "(SEM RESPONSAVEL)" && abrirDrill(`Operador: ${o.operador_email}`, { operador_email: o.operador_email })}>{o.operador_email}</td>
                      <td style={td}>{num(o.casos_ativos)}</td><td style={td}>{num(o.cpfs_unicos)}</td><td style={td}>{moeda(o.saldo_vencido)}</td>
                      <td style={td}>{moeda(o.saldo_total)}</td><td style={td}>{num(o.nunca_acionados)}</td><td style={td}>{num(o.sem_acionamento_limite)}</td>
                      <td style={td}>{Number(o.pct_sem_acionamento || 0).toFixed(0)}%</td><td style={td}>{num(o.retornos_vencidos)}</td>
                      <td style={td}>{num(o.sem_telefone)}</td><td style={td}>{num(o.criticos)}</td><td style={td}>{num(o.urgentes)}</td>
                      <td style={td}>{num(o.acordos_em_dia)}</td><td style={td}>{num(o.acordos_vencidos)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Secao>

          {qualidade && (
            <Secao titulo="Qualidade da carteira">
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(200px,1fr))", gap: 10 }}>
                {Object.entries(qualidade).map(([k, v]) => (
                  <div key={k} style={{ ...card, background: v > 0 ? "#fef2f2" : "#f0fdf4" }}>
                    <div style={{ fontSize: 12, color: "#475569" }}>{QUALIDADE_LABEL[k] || k}</div>
                    <div style={{ fontSize: 18, fontWeight: 800, color: v > 0 ? "#b91c1c" : "#15803d" }}>{num(v)}</div>
                  </div>
                ))}
              </div>
            </Secao>
          )}
        </>
      )}

      {drill && (
        <DetalheDrawer titulo={drill.titulo} det={det} loading={detLoading}
          pag={detPag} setPag={setDetPag} ord={detOrd} setOrd={setDetOrd} onClose={() => { setDrill(null); setDet(null); }} />
      )}
    </div>
  );
}

function Filtros({ filtros, setFiltros, estabs, operadores, isGestao }) {
  const set = (k, v) => setFiltros((f) => ({ ...f, [k]: v === "" ? undefined : v }));
  return (
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 14, padding: 12, background: "#f8fafc", borderRadius: 10, border: "1px solid #e2e8f0" }}>
      <label style={lbl}>Sem acionamento há ≥
        <input type="number" min={0} value={filtros.min_dias_sem_acionamento ?? 5}
          onChange={(e) => set("min_dias_sem_acionamento", Number(e.target.value))} style={{ ...inp, width: 64 }} /> dias
      </label>
      <select value={filtros.estabelecimento || ""} onChange={(e) => set("estabelecimento", e.target.value)} style={inp}>
        <option value="">Todos estabelecimentos</option>
        {estabs.map((e) => <option key={e.estabelecimento} value={e.estabelecimento}>{e.estabelecimento}</option>)}
      </select>
      {isGestao && (
        <select value={filtros.operador_email || ""} onChange={(e) => set("operador_email", e.target.value)} style={inp}>
          <option value="">Todos operadores</option>
          {operadores.map((o) => <option key={o.operador_email} value={o.operador_email}>{o.operador_email}</option>)}
        </select>
      )}
      <select value={filtros.acordo_situacao || ""} onChange={(e) => set("acordo_situacao", e.target.value)} style={inp}>
        <option value="">Qualquer acordo</option>
        <option value="SEM_ACORDO">Sem acordo</option><option value="EM_DIA">Em dia</option>
        <option value="VENCIDO">Vencido</option><option value="QUEBRADO">Quebrado</option>
      </select>
      <label style={lbl}><input type="checkbox" checked={!!filtros.incluir_encerrados}
        onChange={(e) => set("incluir_encerrados", e.target.checked || undefined)} /> Incluir encerrados/bloqueados</label>
    </div>
  );
}

function MetricaToggle({ valor, setValor }) {
  const ops = [["casos", "Casos"], ["cpfs", "CPFs"], ["saldo_vencido", "Saldo venc."], ["saldo_total", "Saldo total"]];
  return (
    <div style={{ display: "flex", gap: 6 }}>
      {ops.map(([k, l]) => (
        <button key={k} onClick={() => setValor(k)} style={{ ...chip, ...(valor === k ? chipOn : {}) }}>{l}</button>
      ))}
    </div>
  );
}

function Matriz({ linhas, colunas, metrica, onCelula }) {
  const fmt = metrica.startsWith("saldo") ? moeda : num;
  const valorCelula = (linha, colKey) => {
    if (metrica === "casos") return linha[colKey] || 0;
    // para cpfs/saldo por célula não temos granularidade; mostramos casos por célula
    // e o total da linha na métrica escolhida.
    return linha[colKey] || 0;
  };
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={tabela}>
        <thead><tr><th style={th}>Estabelecimento</th>{colunas.map(([k, l]) => <th key={k} style={th}>{l}</th>)}
          <th style={th}>{metrica === "casos" ? "Total" : metrica === "cpfs" ? "CPFs" : metrica === "saldo_vencido" ? "Saldo venc." : "Saldo total"}</th></tr></thead>
        <tbody>
          {linhas.map((linha) => (
            <tr key={linha.estabelecimento} style={{ borderTop: "1px solid #eef2f7" }}>
              <td style={{ ...td, fontWeight: 600 }}>{linha.estabelecimento}</td>
              {colunas.map(([k, , faixaFiltro]) => {
                const v = valorCelula(linha, k);
                return <td key={k} style={{ ...td, cursor: v ? "pointer" : "default", color: v ? "#1e40af" : "#cbd5e1" }}
                  onClick={() => v && onCelula(linha.estabelecimento, faixaFiltro)}>{num(v)}</td>;
              })}
              <td style={{ ...td, fontWeight: 700 }}>{fmt(metrica === "casos" ? linha.total : linha[metrica])}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DetalheDrawer({ titulo, det, loading, pag, setPag, ord, setOrd, onClose }) {
  const rows = det?.rows || [];
  const total = det?.total || 0;
  const pagina = Math.floor(pag.offset / pag.limite) + 1;
  const nPaginas = Math.max(1, Math.ceil(total / pag.limite));
  const col = (ordenar_por) => setOrd((o) => ({ ordenar_por, ordem_dir: o.ordenar_por === ordenar_por && o.ordem_dir === "desc" ? "asc" : "desc" }));
  return (
    <div style={overlay} onClick={onClose}>
      <div style={drawer} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>{titulo} <span style={{ color: "#64748b", fontWeight: 500 }}>· {num(total)} casos</span></h3>
          <button onClick={onClose} style={btnSec}>Fechar ✕</button>
        </div>
        {loading ? <div style={vazio}>Carregando…</div> : rows.length === 0 ? <div style={vazio}>Nenhum caso.</div> : (
          <div style={{ overflowX: "auto" }}>
            <table style={tabela}>
              <thead><tr>
                {[["estabelecimento", "Estab."], ["caso_codigo", "Caso"], ["aluno_mascarado", "Aluno"], ["operador_email", "Operador"],
                  ["faixa_atraso", "Faixa"], ["dias_atraso", "Dias atr."], ["saldo_vencido", "Saldo venc."], ["saldo_total", "Saldo total"],
                  ["acordo_situacao", "Acordo"], ["criticidade", "Crít."], ["ultimo_acionamento", "Últ. acion."], ["dias_sem_acionamento", "Dias s/ ac."],
                  ["tipo_ultimo_acionamento", "Tipo"], ["proximo_retorno", "Próx. ret."], ["possui_telefone", "Tel?"], ["situacao_operacional", "Situação"]].map(([k, l]) => {
                    const ordenavel = ["saldo_vencido", "saldo_total", "dias_sem_acionamento", "dias_atraso"].includes(k);
                    return <th key={k} style={{ ...th, cursor: ordenavel ? "pointer" : "default" }} onClick={() => ordenavel && col(k)}>
                      {l}{ord.ordenar_por === k ? (ord.ordem_dir === "desc" ? " ▼" : " ▲") : ""}</th>;
                  })}
              </tr></thead>
              <tbody>
                {rows.map((rw) => (
                  <tr key={rw.caso_id} style={{ borderTop: "1px solid #eef2f7" }}>
                    <td style={td}>{rw.estabelecimento}</td><td style={td}>{rw.caso_codigo}</td><td style={td}>{rw.aluno_mascarado || "—"}</td>
                    <td style={td}>{rw.operador_email || "—"}</td><td style={td}>{rw.faixa_atraso}</td><td style={td}>{rw.dias_atraso ?? "—"}</td>
                    <td style={td}>{moeda(rw.saldo_vencido)}</td><td style={td}>{moeda(rw.saldo_total)}</td><td style={td}>{rw.acordo_situacao}</td>
                    <td style={td}>{rw.criticidade}</td><td style={td}>{dataBR(rw.ultimo_acionamento)}</td><td style={td}>{rw.dias_sem_acionamento ?? "nunca"}</td>
                    <td style={td}>{rw.tipo_ultimo_acionamento || "—"}</td><td style={td}>{dataBR(rw.proximo_retorno)}</td>
                    <td style={td}>{rw.possui_telefone ? "Sim" : "Não"}</td><td style={td}>{rw.situacao_operacional || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10 }}>
          <span style={{ fontSize: 12, color: "#64748b" }}>Página {pagina} de {nPaginas}</span>
          <div style={{ display: "flex", gap: 6 }}>
            <button style={btnSec} disabled={pag.offset === 0} onClick={() => setPag((p) => ({ ...p, offset: Math.max(0, p.offset - p.limite) }))}>← Anterior</button>
            <button style={btnSec} disabled={pagina >= nPaginas} onClick={() => setPag((p) => ({ ...p, offset: p.offset + p.limite }))}>Próxima →</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Secao({ titulo, extra, children }) {
  return (
    <div style={{ marginTop: 22 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <h2 style={{ margin: 0, fontSize: 16, color: "#0f172a" }}>{titulo}</h2>{extra}
      </div>
      {children}
    </div>
  );
}

const card = { textAlign: "left", background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: "12px 14px" };
const tabela = { width: "100%", borderCollapse: "collapse", fontSize: 12.5, background: "#fff" };
const th = { textAlign: "right", padding: "7px 8px", background: "#f1f5f9", color: "#334155", fontWeight: 700, whiteSpace: "nowrap", position: "sticky", top: 0 };
const td = { textAlign: "right", padding: "6px 8px", color: "#334155", whiteSpace: "nowrap" };
const btnSec = { background: "#fff", border: "1px solid #cbd5e1", borderRadius: 8, padding: "8px 12px", fontSize: 13, fontWeight: 700, cursor: "pointer", color: "#1e40af" };
const chip = { background: "#fff", border: "1px solid #cbd5e1", borderRadius: 999, padding: "4px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer", color: "#475569" };
const chipOn = { background: "#1e40af", color: "#fff", borderColor: "#1e40af" };
const vazio = { padding: 30, textAlign: "center", color: "#64748b", background: "#f8fafc", borderRadius: 10, marginTop: 16 };
const lbl = { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "#334155", fontWeight: 600 };
const inp = { padding: "6px 10px", border: "1px solid #cbd5e1", borderRadius: 8, fontSize: 13, background: "#fff" };
const overlay = { position: "fixed", inset: 0, background: "rgba(15,23,42,0.45)", display: "flex", justifyContent: "center", alignItems: "flex-start", padding: 24, zIndex: 1000, overflowY: "auto" };
const drawer = { background: "#fff", borderRadius: 12, padding: 18, width: "min(1300px,96vw)", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" };
