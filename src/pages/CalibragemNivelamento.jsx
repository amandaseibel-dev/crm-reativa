import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import { Carregando, Erro } from "../ui/estados";

// Calibragem — NIVELAMENTO (tela enxuta): escolhe o ano da dívida, vê cada
// operador vs 500 CPFs (só mensalidades sem negociação), simula e aplica.
// Backend: calibragem_diagnostico_sem_negociacao(ano) + calibragem_simular_nivelamento(criterio)
// + calibragem_aprovar_simulacao/executar_simulacao (aplicar = move de verdade).

const ALVO = 500;
const moeda = (v) => Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const num = (v) => Number(v || 0).toLocaleString("pt-BR");
const mi = (v) => (Number(v || 0) / 1e6).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " mi";

function corBarra(qtd) {
  const pct = (qtd / ALVO) * 100;
  if (pct >= 99) return "#34d399";
  if (pct >= 70) return "#fbbf24";
  return "#f87171";
}

export default function CalibragemNivelamento() {
  const [ano, setAno] = useState(null); // null = todos
  const [anos, setAnos] = useState([]);
  const [diag, setDiag] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");

  const [sim, setSim] = useState(null);
  const [simulando, setSimulando] = useState(false);
  const [aplicando, setAplicando] = useState(false);
  const [aviso, setAviso] = useState("");

  async function carregarDiag(anoSel) {
    setCarregando(true);
    setErro("");
    setSim(null);
    setAviso("");
    const { data, error } = await supabase.rpc("calibragem_diagnostico_sem_negociacao", { p_ano: anoSel });
    setCarregando(false);
    if (error) { setErro("Não foi possível carregar o diagnóstico."); return; }
    setDiag(data);
    if (Array.isArray(data?.anos) && !anos.length) setAnos(data.anos.map((a) => a.ano));
  }

  useEffect(() => { carregarDiag(ano); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [ano]);

  async function simular() {
    setSimulando(true);
    setAviso("");
    const criterio = { alvo: ALVO, dias_sem_acionamento: 11 };
    if (ano) criterio.ano = ano;
    const { data, error } = await supabase.rpc("calibragem_simular_nivelamento", { p_criterio: criterio });
    setSimulando(false);
    if (error) { setAviso("Erro ao simular: " + (error.message || "")); return; }
    setSim(data);
    const abaixo = (data?.depois || []).filter((o) => Number(o.qtd) < ALVO);
    if (abaixo.length) {
      setAviso(`⚠️ Pool insuficiente: ${abaixo.length} operador(es) ficaram abaixo de ${ALVO} (não há casos "sem negociação" suficientes${ano ? " para " + ano : ""}).`);
    }
  }

  async function aplicar() {
    if (!sim?.simulacao_id) return;
    // PASSO 3 (aplicar de verdade) ainda em validação: o executor dedicado do
    // nivelamento — que sabe puxar do pool (sem responsável) e conviver com o
    // gatilho de teto 500 — está sendo testado. Até liberar, não movemos nada.
    setAviso(
      "🔒 Aplicar em validação (passo 3): a simulação está pronta e o plano acima é real, " +
      "mas o botão que MOVE os casos ainda está em teste (staging) para garantir que o pool " +
      "e o teto de 500 funcionem certo. Assim que validado, este botão passa a mover de verdade."
    );
  }

  const S = estilos;
  if (carregando && !diag) return <div style={S.container}><Carregando texto="Carregando calibragem…" tema="escuro" /></div>;
  if (erro) return <div style={S.container}><Erro texto={erro} onTentar={() => carregarDiag(ano)} /></div>;

  const lista = sim?.depois || diag?.operadores || [];
  const antesPorEmail = {};
  (sim?.antes || diag?.operadores || []).forEach((o) => { antesPorEmail[o.op_email] = o; });
  const base = sim ? null : diag?.base_total;
  const pool = sim ? null : diag?.pool_total;

  return (
    <div style={S.container}>
      <div style={S.inner}>
        <div style={S.header}>
          <div>
            <h1 style={S.titulo}>⚖️ Calibragem</h1>
            <p style={S.sub}>
              Nivelar cada operador em <strong>{ALVO} CPFs</strong> e valor na média — só mensalidades sem negociação.
            </p>
          </div>
        </div>

        {/* Filtros: ano + (todos operadores) */}
        <div style={S.toolbar}>
          <div style={S.grp}>
            <span style={S.lbl}>Ano da dívida</span>
            <div style={S.chips}>
              {anos.map((a) => (
                <button key={a} type="button" onClick={() => setAno(a)} style={{ ...S.chip, ...(ano === a ? S.chipOn : {}) }}>{a}</button>
              ))}
              <button type="button" onClick={() => setAno(null)} style={{ ...S.chip, ...(ano === null ? S.chipOn : {}) }}>Todos</button>
            </div>
          </div>
        </div>

        {/* Resumo */}
        {!sim && (
          <div style={S.resumo}>
            <div style={S.rcell}><div style={S.rk}>Base sem negociação</div><div style={S.rv}>{num(base)}</div></div>
            <div style={S.rcell}><div style={S.rk}>Pool disponível</div><div style={S.rv}>{num(pool)}</div></div>
            <div style={S.rcell}><div style={S.rk}>Alvo por operador</div><div style={S.rv}>{ALVO}</div></div>
          </div>
        )}

        {/* Modo */}
        <div style={{ ...S.modo, color: sim ? "#34d399" : "#60a5fa" }}>
          {sim
            ? `● Após simular — ${num(sim.total_movimentacoes)} movimentações · equilíbrio CPFs ${sim.indice_qtd_depois} · valor ${sim.indice_depois}`
            : "◔ Situação atual — clique em “Simular nivelamento”"}
        </div>

        {/* Lista de operadores */}
        <div>
          {lista.map((o) => {
            const q = Number(o.qtd);
            const pct = Math.min(100, (q / ALVO) * 100);
            const antes = antesPorEmail[o.op_email];
            const delta = sim && antes ? q - Number(antes.qtd) : null;
            const st = sim
              ? (q >= ALVO ? "✓ nivelado" : `${ALVO - q} abaixo (faltou pool)`)
              : (q >= ALVO ? "✓ nivelado" : `${ALVO - q} abaixo do alvo`);
            return (
              <div key={o.op_email} style={S.op}>
                <div><div style={S.nome}>{o.op_nome}</div><div style={S.st}>{st}</div></div>
                <div style={S.bar}>
                  <div style={{ ...S.fill, width: pct + "%", background: corBarra(q) }} />
                  <div style={S.alvo500} />
                  <div style={S.barnum}>{num(q)}{delta ? ` (${delta > 0 ? "+" : ""}${delta})` : ""}</div>
                </div>
                <div style={S.saldo}>R$ {mi(o.saldo)}<small style={S.saldoS}>saldo</small></div>
              </div>
            );
          })}
        </div>

        {aviso && <div style={S.aviso}>{aviso}</div>}

        {/* Ações */}
        <div style={S.cta}>
          <button type="button" onClick={simular} disabled={simulando} style={S.btn}>
            {simulando ? "Simulando…" : sim ? "↻ Simular de novo" : "Simular nivelamento"}
          </button>
          {sim && (
            <button type="button" onClick={aplicar} disabled={aplicando} style={S.btnAplicar}>
              {aplicando ? "Aplicando…" : `Aplicar ✓ (${num(sim.total_movimentacoes)} casos)`}
            </button>
          )}
          {sim && <button type="button" onClick={() => { setSim(null); setAviso(""); }} style={S.btnGhost}>Voltar</button>}
        </div>

        <p style={S.nota}>
          A linha azul marca o alvo de {ALVO}. Vermelho = abaixo · Verde = nivelado. Aplicar move os casos de verdade
          (tira parados +11 dias → pool; completa com os mais recentes) e é auditado.
        </p>
      </div>
    </div>
  );
}

const estilos = {
  container: { minHeight: "100vh", background: "#0f172a", color: "#e2e8f0", padding: "24px 28px", fontFamily: "'Sora','Inter',system-ui,sans-serif", boxSizing: "border-box" },
  inner: { maxWidth: 880, margin: "0 auto" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 18 },
  titulo: { fontSize: 24, fontWeight: 800, margin: "0 0 2px", letterSpacing: "-0.02em" },
  sub: { color: "#94a3b8", fontSize: 13.5, margin: 0 },
  toolbar: { display: "flex", gap: 18, flexWrap: "wrap", alignItems: "center", marginBottom: 16 },
  grp: { display: "flex", flexDirection: "column", gap: 6 },
  lbl: { fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: "#64748b", fontWeight: 700 },
  chips: { display: "flex", gap: 6, flexWrap: "wrap" },
  chip: { background: "#0b1424", border: "1px solid #22304a", color: "#94a3b8", borderRadius: 999, padding: "6px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer" },
  chipOn: { background: "#3b82f6", borderColor: "#3b82f6", color: "#fff" },
  resumo: { display: "flex", background: "#0b1424", border: "1px solid #22304a", borderRadius: 12, padding: "2px 0", marginBottom: 18 },
  rcell: { flex: 1, padding: "11px 16px", borderLeft: "1px solid #22304a" },
  rk: { fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em", color: "#64748b", fontWeight: 700 },
  rv: { fontSize: 19, fontWeight: 800, marginTop: 2 },
  modo: { fontSize: 12, fontWeight: 700, marginBottom: 10 },
  op: { display: "grid", gridTemplateColumns: "120px 1fr 120px", alignItems: "center", gap: 14, padding: "9px 0", borderBottom: "1px solid #0b1424" },
  nome: { fontWeight: 700, fontSize: 14 },
  st: { fontSize: 11, color: "#64748b", marginTop: 1 },
  bar: { position: "relative", height: 24, background: "#0b1424", borderRadius: 6, overflow: "hidden", border: "1px solid #22304a" },
  fill: { position: "absolute", top: 0, bottom: 0, left: 0, borderRadius: 5 },
  alvo500: { position: "absolute", top: -2, bottom: -2, left: "100%", width: 2, background: "#60a5fa" },
  barnum: { position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", fontSize: 11, fontWeight: 800, color: "#fff", fontVariantNumeric: "tabular-nums", textShadow: "0 1px 2px rgba(0,0,0,0.6)" },
  saldo: { textAlign: "right", fontVariantNumeric: "tabular-nums", fontSize: 13, fontWeight: 700 },
  saldoS: { display: "block", color: "#64748b", fontSize: 10, fontWeight: 600 },
  cta: { display: "flex", gap: 12, alignItems: "center", marginTop: 18, flexWrap: "wrap" },
  btn: { background: "#3b82f6", color: "#fff", border: "none", borderRadius: 10, padding: "12px 22px", fontSize: 14, fontWeight: 800, cursor: "pointer" },
  btnAplicar: { background: "#16a34a", color: "#fff", border: "none", borderRadius: 10, padding: "12px 22px", fontSize: 14, fontWeight: 800, cursor: "pointer" },
  btnGhost: { background: "transparent", border: "1px solid #22304a", color: "#94a3b8", borderRadius: 10, padding: "12px 18px", fontSize: 14, fontWeight: 700, cursor: "pointer" },
  aviso: { marginTop: 14, background: "rgba(251,191,36,0.12)", border: "1px solid rgba(251,191,36,0.35)", color: "#fcd34d", padding: "10px 14px", borderRadius: 10, fontSize: 13, fontWeight: 600 },
  nota: { fontSize: 11, color: "#64748b", marginTop: 12, fontStyle: "italic", lineHeight: 1.5 },
};
