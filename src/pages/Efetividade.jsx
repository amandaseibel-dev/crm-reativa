import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";

const FONTE = "'Sora','Inter',system-ui,sans-serif";
const moeda = (v) => Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const num = (v) => Number(v || 0).toLocaleString("pt-BR");

function periodo(preset) {
  const hoje = new Date();
  const fmt = (d) => d.toISOString().slice(0, 10);
  const ate = fmt(hoje);
  const menos = (n) => {
    const d = new Date(hoje);
    d.setDate(d.getDate() - n);
    return fmt(d);
  };
  switch (preset) {
    case "hoje": return { de: ate, ate };
    case "7": return { de: menos(7), ate };
    case "15": return { de: menos(15), ate };
    case "30": return { de: menos(30), ate };
    case "mes": {
      const ini = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
      return { de: fmt(ini), ate };
    }
    default: return { de: menos(30), ate };
  }
}

const PRESETS = [
  { k: "hoje", r: "Hoje" }, { k: "7", r: "7 dias" }, { k: "15", r: "15 dias" },
  { k: "30", r: "30 dias" }, { k: "mes", r: "Mês atual" },
];

const COLS = [
  { k: "carteira_cpfs", r: "Carteira", fmt: num },
  { k: "cobertura_pct", r: "Cobertura", fmt: (v) => `${v ?? 0}%`, bar: true },
  { k: "trabalhados", r: "Trabalhados", fmt: num },
  { k: "acionamentos", r: "Acionam.", fmt: num },
  { k: "acordos", r: "Acordos", fmt: num },
  { k: "conv_acordo_pct", r: "Conv. acordo", fmt: (v) => `${v ?? 0}%` },
  { k: "pagamentos_confirmados", r: "Pagtos", fmt: num },
  { k: "recuperado", r: "Recuperado", fmt: moeda, forte: true },
  { k: "links_enviados", r: "Links", fmt: num },
  { k: "termos_enviados", r: "Termos", fmt: num },
  { k: "aguardando_confirmacao", r: "Aguard. conf.", fmt: num },
];

export default function Efetividade() {
  const [preset, setPreset] = useState("30");
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");
  const [dados, setDados] = useState(null);

  async function carregar() {
    setCarregando(true);
    setErro("");
    try {
      const { de, ate } = periodo(preset);
      const { data, error } = await supabase.rpc("calibragem_efetividade", { p_de: de, p_ate: ate });
      if (error) throw error;
      setDados(data);
    } catch (e) {
      setErro(e?.message || String(e));
    } finally {
      setCarregando(false);
    }
  }

  useEffect(() => { carregar(); /* eslint-disable-next-line */ }, [preset]);

  const ops = dados?.operadores || [];
  const totais = useMemo(() => {
    const t = { recuperado: 0, acordos: 0, pagamentos: 0, acionamentos: 0 };
    for (const o of ops) {
      t.recuperado += Number(o.recuperado || 0);
      t.acordos += Number(o.acordos || 0);
      t.pagamentos += Number(o.pagamentos_confirmados || 0);
      t.acionamentos += Number(o.acionamentos || 0);
    }
    return t;
  }, [ops]);

  return (
    <div style={S.container}>
      <div style={S.inner}>
      <div style={S.header}>
        <div>
          <h1 style={S.titulo}>📈 Efetividade da Equipe</h1>
          <p style={S.sub}>
            Execução por operador no período — só movimentações humanas válidas (automações do
            sistema não contam como trabalho).
          </p>
        </div>
        <div style={S.presets}>
          {PRESETS.map((p) => (
            <button
              key={p.k}
              type="button"
              onClick={() => setPreset(p.k)}
              style={{ ...S.preset, ...(preset === p.k ? S.presetOn : {}) }}
            >
              {p.r}
            </button>
          ))}
        </div>
      </div>

      {erro && <div style={S.erro}>{erro}</div>}

      {!erro && (
        <div style={S.totais}>
          <Chip r="Recuperado no período" v={moeda(totais.recuperado)} forte />
          <Chip r="Acordos" v={num(totais.acordos)} />
          <Chip r="Pagamentos" v={num(totais.pagamentos)} />
          <Chip r="Acionamentos" v={num(totais.acionamentos)} />
        </div>
      )}

      <SemTabulacao />

      <div style={{ marginBottom: 24 }}>
        <Saude />
      </div>

      {carregando ? (
        <div style={S.vazio}>Calculando…</div>
      ) : !ops.length ? (
        <div style={S.vazio}>Sem dados no período.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={S.tabela}>
            <thead>
              <tr>
                <th style={S.th}>Operador</th>
                {COLS.map((c) => (
                  <th key={c.k} style={{ ...S.th, textAlign: "right" }}>{c.r}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ops.map((o) => (
                <tr key={o.operador_email}>
                  <td style={{ ...S.td, fontWeight: 700 }}>{o.operador_nome}</td>
                  {COLS.map((c) => (
                    <td key={c.k} style={{ ...S.td, textAlign: "right", ...(c.forte ? { color: "#34d399", fontWeight: 700 } : {}) }}>
                      {c.fmt(o[c.k])}
                      {c.bar && (
                        <div style={S.track}>
                          <div style={{ ...S.fill, width: `${Math.min(100, Number(o[c.k] || 0))}%` }} />
                        </div>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ marginTop: 28 }}>
        <CarteiraPenetracao preset={preset} />
      </div>

      <div style={{ marginTop: 28 }}>
        <Funil />
      </div>
      </div>
    </div>
  );
}

function SemTabulacao() {
  const [ops, setOps] = useState(null);
  useEffect(() => {
    let ativo = true;
    (async () => {
      const { data } = await supabase.rpc("calibragem_atendimentos_sem_tabulacao", { p_horas: 24 });
      if (ativo) setOps(data?.por_operador || []);
    })();
    return () => { ativo = false; };
  }, []);
  if (!ops || !ops.length) return null;
  const total = ops.reduce((s, o) => s + Number(o.qtd || 0), 0);
  return (
    <div style={{ ...S.erro, background: "rgba(251,191,36,0.1)", border: "1px solid rgba(251,191,36,0.35)", color: "#fde68a", marginBottom: 18 }}>
      <strong>⚠️ {num(total)} atendimentos assumidos sem tabulação</strong> (mais de 24h) —{" "}
      {ops.slice(0, 6).map((o) => `${o.op_nome}: ${o.qtd}`).join(" · ")}. A falta de tabulação não
      gera vantagem: esses casos seguem responsabilizados e visíveis para nivelamento.
    </div>
  );
}

function corNota(n) {
  if (n >= 80) return "#34d399";
  if (n >= 60) return "#fbbf24";
  if (n >= 40) return "#fb923c";
  return "#f87171";
}

function Saude() {
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");
  const [ops, setOps] = useState([]);
  const [aberto, setAberto] = useState(null);

  useEffect(() => {
    let ativo = true;
    (async () => {
      setCarregando(true);
      try {
        const { data, error } = await supabase.rpc("calibragem_saude", { p_operador: null });
        if (error) throw error;
        if (ativo) setOps(data?.operadores || []);
      } catch (e) {
        if (ativo) setErro(e?.message || String(e));
      } finally {
        if (ativo) setCarregando(false);
      }
    })();
    return () => { ativo = false; };
  }, []);

  if (carregando) return <div style={S.vazio}>Calculando saúde…</div>;
  if (erro) return <div style={S.erro}>{erro}</div>;

  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 800, margin: "8px 0 6px" }}>❤️ Saúde da carteira</h2>
      <p style={{ opacity: 0.6, fontSize: 12, marginBottom: 14 }}>
        Nota 0–100 por operador. Clique para ver os fatores que reduzem a nota.
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 12 }}>
        {ops.filter((o) => Number(o.carteira_cpfs) > 20).map((o) => {
          const nota = Number(o.nota || 0);
          const on = aberto === o.operador_email;
          return (
            <div key={o.operador_email} style={{ ...S.chip, cursor: "pointer" }} onClick={() => setAberto(on ? null : o.operador_email)}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <strong>{o.operador_nome}</strong>
                <span style={{ fontSize: 24, fontWeight: 800, color: corNota(nota) }}>{nota}</span>
              </div>
              <div style={{ ...S.track, marginTop: 6 }}>
                <div style={{ height: "100%", width: `${nota}%`, background: corNota(nota), borderRadius: 999 }} />
              </div>
              {on && (
                <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 4 }}>
                  {(o.fatores || []).filter((f) => Number(f.penalidade) > 0).sort((a, b) => b.penalidade - a.penalidade).map((f, i) => (
                    <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                      <span style={{ opacity: 0.8 }}>{f.fator} <span style={{ opacity: 0.5 }}>({f.detalhe})</span></span>
                      <span style={{ color: "#f87171", fontWeight: 700 }}>−{f.penalidade}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const GRUPO_COR = { Links: "#38bdf8", "Confirmação": "#fbbf24", Termos: "#a78bfa", Acordos: "#34d399", Baixas: "#f472b6" };

function Funil() {
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");
  const [estagios, setEstagios] = useState([]);

  useEffect(() => {
    let ativo = true;
    (async () => {
      setCarregando(true);
      try {
        const { data, error } = await supabase.rpc("calibragem_funil", { p_operador: null });
        if (error) throw error;
        if (ativo) setEstagios(data?.estagios || []);
      } catch (e) {
        if (ativo) setErro(e?.message || String(e));
      } finally {
        if (ativo) setCarregando(false);
      }
    })();
    return () => { ativo = false; };
  }, []);

  if (carregando) return <div style={S.vazio}>Carregando funil…</div>;
  if (erro) return <div style={S.erro}>{erro}</div>;

  const grupos = [...new Set(estagios.map((e) => e.grupo))];
  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 800, margin: "8px 0 14px" }}>🫧 Funil de negociações</h2>
      {grupos.map((g) => (
        <div key={g} style={{ marginBottom: 16 }}>
          <div style={{ ...S.th, opacity: 0.7, color: GRUPO_COR[g], marginBottom: 6 }}>{g}</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 10 }}>
            {estagios.filter((e) => e.grupo === g).map((e) => (
              <div key={e.chave} style={{ ...S.chip, borderLeft: `3px solid ${GRUPO_COR[g]}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <div style={S.chipV}>{num(e.qtd)}</div>
                  {Number(e.valor) > 0 && <div style={{ fontSize: 13, color: "#93c5fd" }}>{moeda(e.valor)}</div>}
                </div>
                <div style={S.chipR}>{e.rotulo}</div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

const FAIXA_ROTULO = {
  A_VENCER: "A vencer", "1_30": "1–30 d", "31_60": "31–60 d", "61_90": "61–90 d",
  "91_180": "91–180 d", "181_365": "181–365 d", MAIS_365: "+365 d",
};
const FAIXAS_ORDEM = ["A_VENCER", "1_30", "31_60", "61_90", "91_180", "181_365", "MAIS_365"];

function corPenetracao(p) {
  if (p >= 80) return "#34d399";
  if (p >= 60) return "#fbbf24";
  if (p >= 40) return "#fb923c";
  return "#f87171";
}

/**
 * Composição da carteira + penetração + ritmo por operador.
 * Fonte: RPC calibragem_efetividade_carteira (mv_saude_carteira, refresh 2h).
 * Gestão vê todos; operador vê só a própria linha (forçado no backend).
 */
function CarteiraPenetracao({ preset }) {
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");
  const [dados, setDados] = useState(null);
  const [aberto, setAberto] = useState(null);

  useEffect(() => {
    let ativo = true;
    (async () => {
      setCarregando(true);
      setErro("");
      try {
        const { de, ate } = periodo(preset);
        const { data, error } = await supabase.rpc("calibragem_efetividade_carteira", { p_de: de, p_ate: ate });
        if (error) throw error;
        if (ativo) setDados(data);
      } catch (e) {
        if (ativo) setErro(e?.message || String(e));
      } finally {
        if (ativo) setCarregando(false);
      }
    })();
    return () => { ativo = false; };
  }, [preset]);

  const ops = (dados?.operadores || []).filter((o) => Number(o.ativos) > 0);
  const atualizada = dados?.carteira_atualizada_em
    ? new Date(dados.carteira_atualizada_em).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
    : null;

  const cols = [
    { k: "ativos", r: "Casos ativos", fmt: num, forte: true },
    { k: "mensalidades", r: "Mensalidades", fmt: num, sub: (o) => `${num(o.mens_vencidas)} venc. · ${num(o.mens_a_vencer)} a vencer` },
    { k: "acordos", r: "Acordos", fmt: num, sub: (o) => `${num(o.ac_em_dia)} em dia · ${num(o.ac_vencidos)} venc. · ${num(o.ac_quebrados)} quebr.` },
    { k: "saldo_total", r: "Saldo", fmt: moeda, sub: (o) => `vencido ${moeda(o.saldo_vencido)}` },
    { k: "penetracao_pct", r: "Penetração", fmt: (v) => `${v ?? 0}%`, bar: true, sub: (o) => `${num(o.acionados_na_carteira)} de ${num(o.ativos)} acionados` },
    { k: "acionamentos", r: "Acionamentos", fmt: num, sub: (o) => `${num(o.alunos_acionados)} alunos` },
    { k: "sem_acionamento_9d", r: "Sem acion. 9d+", fmt: num, sub: (o) => `${num(o.nunca_acionados)} nunca`, alerta: true },
    { k: "media_alunos_dia", r: "Média/dia útil", fmt: (v) => num(v), sub: (o) => `${num(o.media_acoes_dia)} ações · ${num(o.dias_uteis)} dias` },
    { k: "dias_percorrer_carteira", r: "Percorre em", fmt: (v) => (v == null ? "—" : `${num(v)} d úteis`), sub: (o) => (o.dias_terminar_restante == null ? "" : `faltam ${num(o.dias_terminar_restante)} d p/ fechar`) },
  ];

  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 800, margin: "8px 0 6px" }}>🗂️ Carteira e penetração por operador</h2>
      <p style={{ opacity: 0.6, fontSize: 12, marginBottom: 14 }}>
        Composição da carteira ativa (mensalidades × acordos), saldo, % da carteira acionada pelo próprio
        operador no período e ritmo por dia útil fechado. Clique no operador para ver a faixa de atraso.
        {atualizada && <> Carteira atualizada às {atualizada}.</>}
      </p>
      {erro && <div style={S.erro}>{erro}</div>}
      {carregando ? (
        <div style={S.vazio}>Calculando carteira…</div>
      ) : !ops.length ? (
        <div style={S.vazio}>Sem carteira para mostrar.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={S.tabela}>
            <thead>
              <tr>
                <th style={S.th}>Operador</th>
                {cols.map((c) => (
                  <th key={c.k} style={{ ...S.th, textAlign: "right" }}>{c.r}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ops.map((o) => {
                const on = aberto === o.operador_email;
                const pen = Number(o.penetracao_pct || 0);
                return [
                  <tr key={o.operador_email} onClick={() => setAberto(on ? null : o.operador_email)} style={{ cursor: "pointer", background: on ? "rgba(148,163,184,0.06)" : undefined }}>
                    <td style={{ ...S.td, fontWeight: 700 }}>{on ? "▾" : "▸"} {o.operador_nome}</td>
                    {cols.map((c) => (
                      <td key={c.k} style={{ ...S.td, textAlign: "right", verticalAlign: "top" }}>
                        <div style={{
                          fontWeight: c.forte || c.bar ? 700 : 500,
                          ...(c.bar ? { color: corPenetracao(pen) } : {}),
                          ...(c.alerta && Number(o[c.k]) > 0 ? { color: "#fca5a5" } : {}),
                        }}>
                          {c.fmt(o[c.k])}
                        </div>
                        {c.bar && (
                          <div style={S.track}>
                            <div style={{ ...S.fill, width: `${Math.min(100, pen)}%`, background: corPenetracao(pen) }} />
                          </div>
                        )}
                        {c.sub && <div style={{ fontSize: 11, opacity: 0.55, marginTop: 2 }}>{c.sub(o)}</div>}
                      </td>
                    ))}
                  </tr>,
                  on && (
                    <tr key={`${o.operador_email}-faixas`}>
                      <td colSpan={cols.length + 1} style={{ ...S.td, whiteSpace: "normal", background: "rgba(148,163,184,0.04)" }}>
                        <div style={{ ...S.th, padding: "0 0 8px", border: "none" }}>Faixa de atraso (vencimento em aberto mais antigo)</div>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 8 }}>
                          {FAIXAS_ORDEM.map((f) => {
                            const fx = (o.faixas || []).find((x) => x.faixa === f) || { qtd: 0, saldo: 0 };
                            const pct = o.ativos ? Math.round((100 * Number(fx.qtd)) / Number(o.ativos)) : 0;
                            return (
                              <div key={f} style={{ ...S.chip, minWidth: 0, padding: "10px 12px" }}>
                                <div style={S.chipR}>{FAIXA_ROTULO[f]}</div>
                                <div style={{ fontSize: 18, fontWeight: 800 }}>{num(fx.qtd)} <span style={{ fontSize: 11, opacity: 0.5 }}>({pct}%)</span></div>
                                <div style={{ fontSize: 12, color: "#93c5fd" }}>{moeda(fx.saldo)}</div>
                              </div>
                            );
                          })}
                        </div>
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Chip({ r, v, forte }) {
  return (
    <div style={S.chip}>
      <div style={{ ...S.chipV, ...(forte ? { color: "#34d399" } : {}) }}>{v}</div>
      <div style={S.chipR}>{r}</div>
    </div>
  );
}

const S = {
  container: { padding: "24px 28px", fontFamily: FONTE, color: "#e2e8f0", background: "#0f172a", minHeight: "100vh", boxSizing: "border-box" },
  inner: { maxWidth: 1400, margin: "0 auto" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap", marginBottom: 18 },
  titulo: { fontSize: 26, fontWeight: 800, margin: 0 },
  sub: { opacity: 0.7, margin: "6px 0 0", maxWidth: 620, fontSize: 14, lineHeight: 1.5 },
  presets: { display: "flex", gap: 6, flexWrap: "wrap" },
  preset: { padding: "8px 12px", borderRadius: 8, border: "1px solid rgba(148,163,184,0.25)", background: "rgba(148,163,184,0.06)", color: "#94a3b8", cursor: "pointer", fontSize: 13, fontFamily: FONTE },
  presetOn: { background: "rgba(52,211,153,0.16)", border: "1px solid rgba(52,211,153,0.5)", color: "#a7f3d0", fontWeight: 700 },
  erro: { background: "rgba(248,113,113,0.12)", border: "1px solid rgba(248,113,113,0.35)", color: "#fca5a5", padding: "10px 14px", borderRadius: 10, marginBottom: 16, fontSize: 14 },
  totais: { display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 18 },
  chip: { background: "rgba(148,163,184,0.08)", border: "1px solid rgba(148,163,184,0.15)", borderRadius: 12, padding: "12px 16px", minWidth: 150 },
  chipV: { fontSize: 20, fontWeight: 800 },
  chipR: { fontSize: 12, opacity: 0.65, marginTop: 2 },
  vazio: { padding: 40, textAlign: "center", opacity: 0.7, border: "1px dashed rgba(148,163,184,0.3)", borderRadius: 12 },
  tabela: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", padding: "9px 10px", borderBottom: "1px solid rgba(148,163,184,0.2)", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, opacity: 0.6, whiteSpace: "nowrap" },
  td: { padding: "9px 10px", borderBottom: "1px solid rgba(148,163,184,0.08)", whiteSpace: "nowrap" },
  track: { height: 3, background: "rgba(148,163,184,0.15)", borderRadius: 999, overflow: "hidden", marginTop: 3 },
  fill: { height: "100%", background: "#34d399", borderRadius: 999 },
};
