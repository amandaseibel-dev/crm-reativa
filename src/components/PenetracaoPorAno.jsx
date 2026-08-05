import { useMemo, useRef, useState } from "react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid,
} from "recharts";
import { supabase } from "../services/supabase";

// ============================================================================
// PENETRAÇÃO POR ANO DA DÍVIDA (visão gerencial, dentro de Ações Massivas).
// Só leitura + agregação — mostra quanto da carteira ativa acionável já recebeu
// acionamento manual e/ou massivo em cada ano da dívida, para a gestão decidir
// onde concentrar. Backend: acoes_massivas_penetracao_por_ano / _ano_detalhe
// (SECURITY DEFINER, gate de gestão por JWT). Carrega SOB DEMANDA (botão).
// ============================================================================

const FONTE_TITULO = "'Sora', 'Inter', system-ui, sans-serif";
const AZUL = "#1e40af";
const COR_MANUAL = "#2563eb";
const COR_MASSIVO = "#7c3aed";
const COR_AMBOS = "#0891b2";
const COR_NUNCA = "#dc2626";
const COR_BASE = "#cbd5e1";

function moeda(v) {
  return Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
function pct(fracao) {
  return `${(Number(fracao || 0) * 100).toFixed(1)}%`;
}
function num(v) {
  return Number(v || 0).toLocaleString("pt-BR");
}
function dataBR(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("pt-BR");
  } catch {
    return "—";
  }
}

const PERIODOS = [
  { v: "tudo", r: "Histórico completo" },
  { v: "hoje", r: "Hoje" },
  { v: "7d", r: "Últimos 7 dias" },
  { v: "30d", r: "Últimos 30 dias" },
  { v: "mes_atual", r: "Mês atual" },
  { v: "mes_anterior", r: "Mês anterior" },
  { v: "custom", r: "Período personalizado" },
];

const CATEGORIAS = [
  { v: "nunca", r: "Nunca acionados" },
  { v: "manual", r: "Somente manual" },
  { v: "massivo", r: "Somente massivo" },
  { v: "ambos", r: "Manual e massivo" },
  { v: "bloqueados", r: "Bloqueados por confirmação" },
];

export default function PenetracaoPorAno({ opcoesUnidade = [], opcoesCurso = [], onUsarComoFiltro }) {
  const [aberto, setAberto] = useState(false);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState("");
  const [dados, setDados] = useState(null);
  const [geradoEm, setGeradoEm] = useState(null);
  const emVoo = useRef(false);
  const bloqueadoAte = useRef(0);

  // filtros
  const [periodo, setPeriodo] = useState("tudo");
  const [dataIni, setDataIni] = useState("");
  const [dataFim, setDataFim] = useState("");
  const [unidade, setUnidade] = useState("");
  const [curso, setCurso] = useState("");
  const [saldoMin, setSaldoMin] = useState("");
  const [saldoMax, setSaldoMax] = useState("");

  // ordenação da matriz
  const [ordenarPor, setOrdenarPor] = useState("saldo_nunca");
  const [ordemDir, setOrdemDir] = useState("desc");

  // detalhamento
  const [det, setDet] = useState(null); // {ano, ano_label, categoria}
  const [detData, setDetData] = useState(null);
  const [detLoading, setDetLoading] = useState(false);
  const [detOffset, setDetOffset] = useState(0);

  function montarFiltros() {
    return {
      periodo,
      data_ini: periodo === "custom" ? dataIni || "" : "",
      data_fim: periodo === "custom" ? dataFim || "" : "",
      unidade: unidade || "",
      curso: curso || "",
      saldo_min: saldoMin ? String(Number(saldoMin)) : "",
      saldo_max: saldoMax ? String(Number(saldoMax)) : "",
    };
  }

  async function carregar() {
    const agora = Date.now();
    if (emVoo.current || agora < bloqueadoAte.current) return;
    emVoo.current = true;
    bloqueadoAte.current = agora + 8000;
    setCarregando(true);
    setErro("");
    try {
      const { data, error } = await supabase.rpc("acoes_massivas_penetracao_por_ano", {
        p_filtros: montarFiltros(),
      });
      if (error) throw error;
      setDados(data);
      setGeradoEm(data?.gerado_em || null);
    } catch (e) {
      setErro(e.message || "Falha ao carregar a penetração por ano.");
    } finally {
      emVoo.current = false;
      setCarregando(false);
    }
  }

  async function abrirDetalhe(linha, categoria) {
    setDet({ ano: linha.ano, ano_label: linha.ano_label, categoria });
    setDetOffset(0);
    await carregarDetalhe(linha.ano, categoria, 0);
  }
  async function carregarDetalhe(ano, categoria, offset) {
    setDetLoading(true);
    try {
      const { data, error } = await supabase.rpc("acoes_massivas_penetracao_ano_detalhe", {
        p_ano: ano,
        p_categoria: categoria,
        p_filtros: montarFiltros(),
        p_limite: 100,
        p_offset: offset,
      });
      if (error) throw error;
      setDetData(data);
    } catch (e) {
      setDetData({ erro: e.message, itens: [] });
    } finally {
      setDetLoading(false);
    }
  }

  const matriz = useMemo(() => {
    const linhas = [...(dados?.matriz || [])];
    const dir = ordemDir === "asc" ? 1 : -1;
    linhas.sort((a, b) => {
      const va = a[ordenarPor], vb = b[ordenarPor];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "string") return va.localeCompare(vb) * dir;
      return (va - vb) * dir;
    });
    return linhas;
  }, [dados, ordenarPor, ordemDir]);

  const grafico = useMemo(() => {
    return (dados?.matriz || [])
      .slice()
      .sort((a, b) => (a.ano == null ? 1 : b.ano == null ? -1 : a.ano - b.ano))
      .map((l) => ({
        ano: l.ano_label,
        Manual: l.so_manual,
        Massivo: l.so_massivo,
        Ambos: l.ambos,
        Nunca: l.nunca_acionado,
        base: l.base_ativa,
      }));
  }, [dados]);

  const ranking = useMemo(() => {
    const base = (dados?.matriz || []).filter((l) => l.ano != null);
    const porSaldo = [...base].sort((a, b) => b.saldo_nunca - a.saldo_nunca).slice(0, 5);
    const porQtd = [...base].sort((a, b) => b.nunca_acionado - a.nunca_acionado).slice(0, 5);
    const porPen = [...base].sort((a, b) => a.pen_total - b.pen_total).slice(0, 5);
    return { porSaldo, porQtd, porPen };
  }, [dados]);

  function ordenar(col) {
    if (ordenarPor === col) setOrdemDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setOrdenarPor(col);
      setOrdemDir("desc");
    }
  }
  const setaOrd = (col) => (ordenarPor === col ? (ordemDir === "asc" ? " ▲" : " ▼") : "");

  const cards = dados?.cards;
  const atrib = dados?.atribuicao;

  return (
    <div style={est.wrap}>
      <div style={est.cabecalho}>
        <button style={est.toggle} onClick={() => setAberto((v) => !v)}>
          {aberto ? "▾" : "▸"} 📊 Penetração por Ano da Dívida
          <span style={est.badge}>gestão</span>
        </button>
        {aberto && (
          <span style={est.hint}>
            {geradoEm ? `Atualizado ${new Date(geradoEm).toLocaleString("pt-BR")} · base ativa atual` : "Base ativa atual"}
          </span>
        )}
      </div>

      {aberto && (
        <div style={est.corpo}>
          <p style={est.sub}>
            Quanto da <strong>carteira ativa acionável</strong> já recebeu acionamento manual e/ou massivo
            em cada ano da dívida. Base = ativa atual; acionamentos consideram o período escolhido
            (America/Sao_Paulo). Não executa campanha — apenas mede.
          </p>

          {/* filtros */}
          <div style={est.filtros}>
            <label style={est.campo}>
              <span style={est.rot}>Período do acionamento</span>
              <select style={est.input} value={periodo} onChange={(e) => setPeriodo(e.target.value)}>
                {PERIODOS.map((p) => <option key={p.v} value={p.v}>{p.r}</option>)}
              </select>
            </label>
            {periodo === "custom" && (
              <>
                <label style={est.campo}><span style={est.rot}>De</span>
                  <input type="date" style={est.input} value={dataIni} onChange={(e) => setDataIni(e.target.value)} /></label>
                <label style={est.campo}><span style={est.rot}>Até</span>
                  <input type="date" style={est.input} value={dataFim} onChange={(e) => setDataFim(e.target.value)} /></label>
              </>
            )}
            <label style={est.campo}>
              <span style={est.rot}>Estabelecimento/Unidade</span>
              <select style={est.input} value={unidade} onChange={(e) => setUnidade(e.target.value)}>
                <option value="">Todas</option>
                {opcoesUnidade.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
            </label>
            <label style={est.campo}>
              <span style={est.rot}>Curso/Modalidade</span>
              <select style={est.input} value={curso} onChange={(e) => setCurso(e.target.value)}>
                <option value="">Todos</option>
                {opcoesCurso.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label style={est.campo}><span style={est.rot}>Saldo mín.</span>
              <input style={est.input} value={saldoMin} onChange={(e) => setSaldoMin(e.target.value)} placeholder="0" inputMode="numeric" /></label>
            <label style={est.campo}><span style={est.rot}>Saldo máx.</span>
              <input style={est.input} value={saldoMax} onChange={(e) => setSaldoMax(e.target.value)} placeholder="—" inputMode="numeric" /></label>
            <button style={est.btnPrim} onClick={carregar} disabled={carregando}>
              {carregando ? "Calculando…" : dados ? "Recalcular" : "Carregar penetração"}
            </button>
          </div>

          {erro && <div style={est.erro}>{erro}</div>}

          {!dados && !carregando && !erro && (
            <div style={est.vazio}>Clique em <strong>Carregar penetração</strong> para calcular sob demanda.</div>
          )}

          {cards && (
            <>
              {/* cards gerais */}
              <div style={est.cards}>
                <Card rot="Base ativa" val={num(cards.base_ativa)} sub={`${num(cards.base_acionavel)} acionáveis`} />
                <Card rot="Penetração manual" val={pct(cards.pen_manual)} sub={`${num(cards.acionados_manual)} alunos`} cor={COR_MANUAL} />
                <Card rot="Penetração massiva" val={pct(cards.pen_massivo)} sub={`${num(cards.acionados_massivo)} alunos`} cor={COR_MASSIVO} />
                <Card rot="Penetração total" val={pct(cards.pen_total)} sub={`${num(cards.acionados_algum)} alunos`} cor={COR_AMBOS} />
                <Card rot="Nunca acionados" val={num(cards.nunca_acionados)} sub={moeda(cards.saldo_nunca_acionado)} cor={COR_NUNCA} />
                <Card rot="Saldo ativo total" val={moeda(cards.saldo_ativo)} sub={`${num(cards.bloqueados_confirmacao)} bloqueados p/ confirmação`} />
              </div>

              {atrib && (
                <div style={est.atrib}>
                  Atribuição ao ano dos acionamentos no período — explícito: <strong>{num(atrib.ano_explicito)}</strong> ·
                  {" "}inferido: <strong>{num(atrib.ano_inferido)}</strong> ·
                  {" "}sem ano possível: <strong>{num(atrib.sem_ano)}</strong>
                </div>
              )}

              {/* gráfico por ano */}
              {grafico.length > 0 && (
                <div style={est.card}>
                  <h3 style={est.h3}>Alunos por ano — acionamento vs. base</h3>
                  <div style={{ width: "100%", height: 320 }}>
                    <ResponsiveContainer>
                      <BarChart data={grafico} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
                        <XAxis dataKey="ano" tick={{ fontSize: 12 }} />
                        <YAxis tick={{ fontSize: 12 }} />
                        <Tooltip formatter={(v) => num(v)} />
                        <Legend wrapperStyle={{ fontSize: 12 }} />
                        <Bar dataKey="Manual" stackId="a" fill={COR_MANUAL} />
                        <Bar dataKey="Massivo" stackId="a" fill={COR_MASSIVO} />
                        <Bar dataKey="Ambos" stackId="a" fill={COR_AMBOS} />
                        <Bar dataKey="Nunca" stackId="a" fill={COR_NUNCA} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}

              {/* matriz detalhada */}
              <div style={est.card}>
                <h3 style={est.h3}>Matriz por ano da dívida</h3>
                <div style={{ overflowX: "auto" }}>
                  <table style={est.tabela}>
                    <thead>
                      <tr>
                        {[
                          ["ano", "Ano"], ["base_ativa", "Base ativa"], ["saldo_ativo", "Saldo ativo"],
                          ["so_manual", "Só manual"], ["so_massivo", "Só massivo"], ["ambos", "Ambos"],
                          ["algum", "Algum"], ["nunca_acionado", "Nunca"], ["saldo_nunca", "Saldo nunca"],
                          ["bloqueados_conf", "Bloq. conf."], ["acoes_manuais", "Ações man."],
                          ["acoes_massivas", "Ações mass."], ["pen_total", "Pen. total"],
                          ["dias_medios_sem_acionamento", "Dias méd."],
                        ].map(([col, rot]) => (
                          <th key={col} style={est.th} onClick={() => ordenar(col)} title="Ordenar">
                            {rot}{setaOrd(col)}
                          </th>
                        ))}
                        <th style={est.th}>Detalhar</th>
                      </tr>
                    </thead>
                    <tbody>
                      {matriz.map((l) => (
                        <tr key={l.ano_label} style={l.ano == null ? { background: "#fafafa" } : undefined}>
                          <td style={est.tdb}>{l.ano_label}</td>
                          <td style={est.tdn}>{num(l.base_ativa)}</td>
                          <td style={est.tdn}>{moeda(l.saldo_ativo)}</td>
                          <td style={est.tdn}>{num(l.so_manual)}</td>
                          <td style={est.tdn}>{num(l.so_massivo)}</td>
                          <td style={est.tdn}>{num(l.ambos)}</td>
                          <td style={est.tdn}>{num(l.algum)}</td>
                          <td style={{ ...est.tdn, color: COR_NUNCA, fontWeight: 700 }}>{num(l.nunca_acionado)}</td>
                          <td style={est.tdn}>{moeda(l.saldo_nunca)}</td>
                          <td style={est.tdn}>{num(l.bloqueados_conf)}</td>
                          <td style={est.tdn}>{num(l.acoes_manuais)}</td>
                          <td style={est.tdn}>{num(l.acoes_massivas)}</td>
                          <td style={est.tdn}>{pct(l.pen_total)}</td>
                          <td style={est.tdn}>{l.dias_medios_sem_acionamento ?? "—"}</td>
                          <td style={est.td}>
                            <button style={est.link} onClick={() => abrirDetalhe(l, "nunca")}>abrir</button>
                          </td>
                        </tr>
                      ))}
                      {matriz.length === 0 && (
                        <tr><td colSpan={15} style={est.tdVazio}>Nenhum ano na base para os filtros atuais.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* ranking de oportunidade */}
              <div style={est.rankRow}>
                <RankCard titulo="Maior saldo nunca acionado" linhas={ranking.porSaldo}
                  valor={(l) => moeda(l.saldo_nunca)} onIr={(l) => abrirDetalhe(l, "nunca")} />
                <RankCard titulo="Maior qtd. nunca acionada" linhas={ranking.porQtd}
                  valor={(l) => `${num(l.nunca_acionado)} alunos`} onIr={(l) => abrirDetalhe(l, "nunca")} />
                <RankCard titulo="Menor penetração total" linhas={ranking.porPen}
                  valor={(l) => pct(l.pen_total)} onIr={(l) => abrirDetalhe(l, "nunca")} />
              </div>
            </>
          )}
        </div>
      )}

      {/* modal de detalhamento */}
      {det && (
        <div style={est.modalBg} onClick={() => setDet(null)}>
          <div style={est.modal} onClick={(e) => e.stopPropagation()}>
            <div style={est.modalTopo}>
              <strong style={{ fontFamily: FONTE_TITULO, fontSize: 16 }}>
                Ano {det.ano_label} — detalhamento
              </strong>
              <button style={est.fechar} onClick={() => setDet(null)}>✕</button>
            </div>
            <div style={est.abas}>
              {CATEGORIAS.map((c) => (
                <button key={c.v}
                  style={det.categoria === c.v ? est.abaAtiva : est.aba}
                  onClick={() => { setDet((d) => ({ ...d, categoria: c.v })); setDetOffset(0); carregarDetalhe(det.ano, c.v, 0); }}>
                  {c.r}
                </button>
              ))}
            </div>

            {det.categoria === "nunca" && onUsarComoFiltro && (
              <div style={est.faixaAcao}>
                <span style={{ fontSize: 12.5, color: "#475569" }}>
                  Transporta os filtros (ano {det.ano_label}{unidade ? `, ${unidade}` : ""}{curso ? `, ${curso}` : ""})
                  para a prévia de Ações Massivas. A prévia recalcula toda a elegibilidade e reexclui bloqueios.
                </span>
                <button style={est.btnPrim}
                  onClick={() => { onUsarComoFiltro({ ano: det.ano, unidade, curso }); setDet(null); }}>
                  ⚡ Usar como filtro em Ações Massivas
                </button>
              </div>
            )}

            <div style={est.modalCorpo}>
              {detLoading && <div style={est.vazio}>Carregando…</div>}
              {!detLoading && detData?.erro && <div style={est.erro}>{detData.erro}</div>}
              {!detLoading && detData && !detData.erro && (
                <>
                  <div style={{ fontSize: 12.5, color: "#8a93a3", marginBottom: 8 }}>
                    {num(detData.total)} aluno(s) · mostrando {detData.itens?.length || 0}
                  </div>
                  <div style={{ overflowX: "auto" }}>
                    <table style={est.tabela}>
                      <thead>
                        <tr>
                          <th style={est.th}>Aluno</th><th style={est.th}>Matrícula</th>
                          <th style={est.th}>Curso</th><th style={est.th}>Sit. acad.</th>
                          <th style={est.th}>Estab.</th><th style={est.thNum}>Ano</th>
                          <th style={est.thNum}>Saldo</th><th style={est.thNum}>Atraso</th>
                          <th style={est.th}>Responsável</th><th style={est.th}>Últ. acion.</th>
                          <th style={est.th}>Origem</th><th style={est.thNum}>Dias s/ ação</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(detData.itens || []).map((it, i) => (
                          <tr key={i}>
                            <td style={est.td}>{it.nome_mascarado}</td>
                            <td style={est.td}>{it.matricula_mascarada || "—"}</td>
                            <td style={est.td}>{it.curso || "—"}</td>
                            <td style={est.td}>{it.situacao_academica || "—"}</td>
                            <td style={est.td}>{it.estabelecimento || "—"}</td>
                            <td style={est.tdn}>{it.ano ?? "—"}</td>
                            <td style={est.tdn}>{moeda(it.saldo)}</td>
                            <td style={est.tdn}>{it.dias_atraso ?? "—"}</td>
                            <td style={est.td}>{it.responsavel}</td>
                            <td style={est.td}>{dataBR(it.data_ultimo_acionamento)}</td>
                            <td style={est.td}>{it.origem_ultimo_acionamento || "—"}</td>
                            <td style={est.tdn}>{it.dias_sem_acionamento ?? "—"}</td>
                          </tr>
                        ))}
                        {(detData.itens || []).length === 0 && (
                          <tr><td colSpan={12} style={est.tdVazio}>Nenhum aluno nesta categoria.</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                  {detData.total > (detData.itens?.length || 0) + detOffset && (
                    <button style={est.btnSec}
                      onClick={() => { const o = detOffset + 100; setDetOffset(o); carregarDetalhe(det.ano, det.categoria, o); }}>
                      Carregar mais
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Card({ rot, val, sub, cor }) {
  return (
    <div style={est.cardMini}>
      <div style={est.cardRot}>{rot}</div>
      <div style={{ ...est.cardVal, color: cor || "#0f172a" }}>{val}</div>
      {sub && <div style={est.cardSub}>{sub}</div>}
    </div>
  );
}

function RankCard({ titulo, linhas, valor, onIr }) {
  return (
    <div style={est.card}>
      <h3 style={est.h3}>{titulo}</h3>
      {linhas.length === 0 && <div style={est.tdVazio}>Sem dados.</div>}
      {linhas.map((l) => (
        <div key={l.ano_label} style={est.rankItem}>
          <button style={est.link} onClick={() => onIr(l)}>{l.ano_label}</button>
          <strong style={{ fontSize: 13 }}>{valor(l)}</strong>
        </div>
      ))}
    </div>
  );
}

const est = {
  wrap: { marginBottom: 18 },
  cabecalho: { display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" },
  toggle: {
    display: "inline-flex", alignItems: "center", gap: 8, background: "#eef2ff",
    border: "1px solid #c7d2fe", color: AZUL, fontFamily: FONTE_TITULO, fontWeight: 800,
    fontSize: 15, padding: "10px 16px", borderRadius: 12, cursor: "pointer",
  },
  badge: { fontSize: 10.5, fontWeight: 800, background: AZUL, color: "#fff", padding: "2px 7px", borderRadius: 999, letterSpacing: 0.4 },
  hint: { fontSize: 12, color: "#8a93a3" },
  corpo: { marginTop: 12, background: "#fff", border: "1px solid #e6eaf0", borderRadius: 16, padding: 18 },
  sub: { margin: "0 0 14px", fontSize: 13, color: "#64748b", lineHeight: 1.5 },
  filtros: { display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 14 },
  campo: { display: "flex", flexDirection: "column", gap: 4, minWidth: 150 },
  rot: { fontSize: 11.5, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.3 },
  input: { padding: "9px 11px", borderRadius: 10, border: "1px solid #d7dde7", fontSize: 13.5, background: "#fff" },
  btnPrim: { padding: "10px 18px", borderRadius: 10, border: "none", background: AZUL, color: "#fff", fontWeight: 700, fontSize: 13.5, cursor: "pointer" },
  btnSec: { marginTop: 10, padding: "8px 16px", borderRadius: 10, border: "1px solid #c7d2fe", background: "#eef2ff", color: AZUL, fontWeight: 700, fontSize: 13, cursor: "pointer" },
  erro: { background: "#fef2f2", border: "1px solid #fecaca", color: "#b91c1c", padding: "10px 14px", borderRadius: 10, fontSize: 13, marginBottom: 12 },
  vazio: { padding: 18, textAlign: "center", color: "#8a93a3", fontSize: 13 },
  cards: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginBottom: 14 },
  cardMini: { background: "#f8fafc", border: "1px solid #e6eaf0", borderRadius: 12, padding: "12px 14px" },
  cardRot: { fontSize: 11, fontWeight: 800, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 },
  cardVal: { fontFamily: FONTE_TITULO, fontSize: 22, fontWeight: 800, lineHeight: 1.1 },
  cardSub: { fontSize: 12, color: "#8a93a3", marginTop: 4 },
  atrib: { fontSize: 12.5, color: "#475569", background: "#f8fafc", border: "1px solid #e6eaf0", borderRadius: 10, padding: "9px 12px", marginBottom: 14 },
  card: { background: "#fff", border: "1px solid #e6eaf0", borderRadius: 14, padding: 16, marginBottom: 14 },
  h3: { margin: "0 0 12px", fontFamily: FONTE_TITULO, fontSize: 15, fontWeight: 800, color: "#0f172a" },
  tabela: { width: "100%", borderCollapse: "collapse", fontSize: 12.5 },
  th: { textAlign: "left", padding: "8px 10px", borderBottom: "2px solid #eef2f7", color: "#475569", fontWeight: 700, whiteSpace: "nowrap", cursor: "pointer", userSelect: "none" },
  thNum: { textAlign: "right", padding: "8px 10px", borderBottom: "2px solid #eef2f7", color: "#475569", fontWeight: 700, whiteSpace: "nowrap" },
  td: { padding: "7px 10px", borderBottom: "1px solid #f1f5f9", whiteSpace: "nowrap" },
  tdb: { padding: "7px 10px", borderBottom: "1px solid #f1f5f9", fontWeight: 700, whiteSpace: "nowrap" },
  tdn: { padding: "7px 10px", borderBottom: "1px solid #f1f5f9", textAlign: "right", whiteSpace: "nowrap" },
  tdVazio: { padding: 16, textAlign: "center", color: "#8a93a3" },
  link: { background: "none", border: "none", color: AZUL, fontWeight: 700, cursor: "pointer", fontSize: 12.5, padding: 0 },
  rankRow: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14 },
  rankItem: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: "1px solid #f1f5f9" },
  modalBg: { position: "fixed", inset: 0, background: "rgba(15,23,42,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16 },
  modal: { background: "#fff", borderRadius: 16, width: "min(1150px, 97vw)", maxHeight: "92vh", display: "flex", flexDirection: "column", overflow: "hidden" },
  modalTopo: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 18px", borderBottom: "1px solid #eef2f7" },
  fechar: { background: "none", border: "none", fontSize: 18, cursor: "pointer", color: "#64748b" },
  abas: { display: "flex", gap: 6, padding: "10px 18px 0", flexWrap: "wrap" },
  aba: { padding: "7px 13px", borderRadius: "10px 10px 0 0", border: "1px solid #e6eaf0", borderBottom: "none", background: "#f8fafc", color: "#475569", fontWeight: 700, fontSize: 12.5, cursor: "pointer" },
  abaAtiva: { padding: "7px 13px", borderRadius: "10px 10px 0 0", border: "1px solid #c7d2fe", borderBottom: "none", background: "#eef2ff", color: AZUL, fontWeight: 800, fontSize: 12.5, cursor: "pointer" },
  faixaAcao: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", padding: "10px 18px", background: "#f8fafc", borderTop: "1px solid #eef2f7", borderBottom: "1px solid #eef2f7" },
  modalCorpo: { padding: 18, overflow: "auto" },
};
