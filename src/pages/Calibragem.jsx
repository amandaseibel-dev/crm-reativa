import { useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";

const FONTE = "'Sora','Inter',system-ui,sans-serif";

function moeda(v) {
  return Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
function num(v) {
  return Number(v || 0).toLocaleString("pt-BR");
}
function qv(ind, chave) {
  const o = ind?.[chave] || {};
  return { qtd: Number(o.qtd || 0), valor: Number(o.valor || 0) };
}

// Grupos de indicadores exibidos em cada card de operador (item 2.1)
const GRUPOS = [
  {
    titulo: "Carteira",
    itens: [
      { chave: "cpfs", rotulo: "CPFs na carteira" },
      { chave: "mensalidades", rotulo: "Mensalidades originais" },
      { chave: "saldo_total", rotulo: "Saldo financeiro", soValor: true },
    ],
  },
  {
    titulo: "Operacional",
    itens: [
      { chave: "sem_acionamento", rotulo: "Sem acionamento" },
      { chave: "sem_acionamento_recente", rotulo: "Sem acionamento recente" },
      { chave: "criticos", rotulo: "Casos críticos" },
      { chave: "antigos", rotulo: "Casos antigos" },
    ],
  },
  {
    titulo: "Acordos",
    itens: [
      { chave: "acordos_em_dia", rotulo: "Em dia" },
      { chave: "acordos_a_vencer", rotulo: "A vencer no mês" },
      { chave: "acordos_vencidos", rotulo: "Vencidos" },
      { chave: "acordos_quebrados", rotulo: "Quebrados" },
    ],
  },
  {
    titulo: "Recuperação",
    itens: [
      { chave: "previsto_entrada_mes", rotulo: "Previsto no mês" },
      { chave: "recuperado_mes", rotulo: "Recuperado no mês" },
      { chave: "pagamentos_confirmados", rotulo: "Pagamentos confirmados" },
      { chave: "negociacoes_andamento", rotulo: "Negociações em andamento" },
    ],
  },
  {
    titulo: "Movimentação",
    itens: [
      { chave: "receptivo_recebidos", rotulo: "Recebidos por receptivo" },
      { chave: "nivelamento_recebidos", rotulo: "Recebidos por nivelamento" },
      { chave: "nivelamento_retirados", rotulo: "Retirados por nivelamento" },
    ],
  },
];

export default function Calibragem() {
  const [carregando, setCarregando] = useState(true);
  const [atualizando, setAtualizando] = useState(false);
  const [erro, setErro] = useState("");
  const [dados, setDados] = useState(null);
  const [detalhe, setDetalhe] = useState(null); // { operador, chave, rotulo }
  const [vista, setVista] = useState("visao"); // 'visao' | 'simulador'

  async function carregar() {
    setCarregando(true);
    setErro("");
    try {
      const { data, error } = await supabase.rpc("calibragem_visao_operadores");
      if (error) throw error;
      setDados(data);
    } catch (e) {
      setErro(e?.message || String(e));
    } finally {
      setCarregando(false);
    }
  }

  async function atualizar() {
    setAtualizando(true);
    setErro("");
    try {
      const { error } = await supabase.rpc("calibragem_recomputar_snapshot");
      if (error) throw error;
      await carregar();
    } catch (e) {
      setErro("Erro ao recalcular: " + (e?.message || String(e)));
    } finally {
      setAtualizando(false);
    }
  }

  useEffect(() => {
    carregar();
  }, []);

  const operadores = dados?.operadores || [];
  const geradoEm = dados?.gerado_em ? new Date(dados.gerado_em).toLocaleString("pt-BR") : null;

  // Totais da equipe para comparação rápida
  const totais = useMemo(() => {
    const t = { cpfs: 0, saldo: 0, criticos: 0, semAcion: 0, acVenc: 0 };
    for (const o of operadores) {
      const i = o.indicadores || {};
      t.cpfs += qv(i, "cpfs").qtd;
      t.saldo += qv(i, "saldo_total").valor;
      t.criticos += qv(i, "criticos").qtd;
      t.semAcion += qv(i, "sem_acionamento").qtd;
      t.acVenc += qv(i, "acordos_vencidos").qtd;
    }
    return t;
  }, [operadores]);

  return (
    <div style={S.container}>
      <div style={S.header}>
        <div>
          <h1 style={S.titulo}>⚖️ Calibragem</h1>
          <p style={S.subtitulo}>
            Centro de controle da composição das carteiras. Toda redistribuição passa por aqui —
            com simulação, aprovação e auditoria.
          </p>
          {geradoEm && (
            <p style={S.meta}>
              Snapshot de {geradoEm}
              {dados?.duracao_ms ? ` · calculado em ${dados.duracao_ms} ms` : ""}
            </p>
          )}
        </div>
        <button type="button" style={S.btnAtualizar} onClick={atualizar} disabled={atualizando}>
          {atualizando ? "Recalculando…" : "↻ Atualizar dados"}
        </button>
      </div>

      <div style={S.tabs}>
        <button
          type="button"
          style={{ ...S.tab, ...(vista === "visao" ? S.tabAtiva : {}) }}
          onClick={() => setVista("visao")}
        >
          Visão por operador
        </button>
        <button
          type="button"
          style={{ ...S.tab, ...(vista === "comparacao" ? S.tabAtiva : {}) }}
          onClick={() => setVista("comparacao")}
        >
          Comparação
        </button>
        <button
          type="button"
          style={{ ...S.tab, ...(vista === "criticidade" ? S.tabAtiva : {}) }}
          onClick={() => setVista("criticidade")}
        >
          Criticidade
        </button>
        <button
          type="button"
          style={{ ...S.tab, ...(vista === "simulador" ? S.tabAtiva : {}) }}
          onClick={() => setVista("simulador")}
        >
          Simulador de nivelamento
        </button>
      </div>

      {erro && <div style={S.erro}>{erro}</div>}

      {vista === "simulador" ? (
        <Simulador operadores={operadores} onExecutado={atualizar} />
      ) : vista === "comparacao" ? (
        <Comparacao operadores={operadores} />
      ) : vista === "criticidade" ? (
        <Criticidade />
      ) : carregando ? (
        <div style={S.vazio}>Carregando…</div>
      ) : !operadores.length ? (
        <div style={S.vazio}>
          Nenhum snapshot ainda. Clique em <strong>Atualizar dados</strong> para calcular a
          composição das carteiras.
        </div>
      ) : (
        <>
          {/* Faixa de totais da equipe */}
          <div style={S.totais}>
            <TotalChip rotulo="Operadores" valor={num(operadores.length)} />
            <TotalChip rotulo="CPFs na equipe" valor={num(totais.cpfs)} />
            <TotalChip rotulo="Saldo total" valor={moeda(totais.saldo)} destaque />
            <TotalChip rotulo="Críticos" valor={num(totais.criticos)} tom="critico" />
            <TotalChip rotulo="Sem acionamento" valor={num(totais.semAcion)} tom="alerta" />
            <TotalChip rotulo="Acordos vencidos" valor={num(totais.acVenc)} tom="alerta" />
          </div>

          <div style={S.grid}>
            {operadores.map((o) => (
              <CardOperador
                key={o.operador_email}
                operador={o}
                onDrill={(chave, rotulo, extra) =>
                  setDetalhe({ operador: o, chave, rotulo, ...(extra || {}) })
                }
              />
            ))}
          </div>
        </>
      )}

      {detalhe && (
        <ModalDetalhe detalhe={detalhe} onClose={() => setDetalhe(null)} />
      )}
    </div>
  );
}

const NIVEIS_CRIT = [
  { key: "critico", rotulo: "Crítico", cor: "#f87171" },
  { key: "urgente", rotulo: "Urgente", cor: "#fb923c" },
  { key: "atencao", rotulo: "Atenção", cor: "#fbbf24" },
  { key: "normal", rotulo: "Normal", cor: "#34d399" },
];

function Criticidade() {
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");
  const [dados, setDados] = useState(null);

  useEffect(() => {
    let ativo = true;
    (async () => {
      setCarregando(true);
      setErro("");
      try {
        const { data, error } = await supabase.rpc("calibragem_criticidade_auto");
        if (error) throw error;
        if (ativo) setDados(data);
      } catch (e) {
        if (ativo) setErro(e?.message || String(e));
      } finally {
        if (ativo) setCarregando(false);
      }
    })();
    return () => { ativo = false; };
  }, []);

  if (carregando) return <div style={S.vazio}>Calculando criticidade…</div>;
  if (erro) return <div style={S.erro}>{erro}</div>;
  const ops = dados?.operadores || [];
  const pesos = dados?.config?.pesos || {};

  return (
    <div>
      <div style={{ ...S.simConfig, marginBottom: 18 }}>
        <div>
          <div style={S.grupoTitulo}>Regras ativas (editáveis pela gestão)</div>
          <div style={{ fontSize: 13, opacity: 0.85, lineHeight: 1.7 }}>
            +{pesos.dias_vencido?.peso} se vencido ≥ {pesos.dias_vencido?.min} dias · +
            {pesos.dias_sem_acionamento?.peso} se sem acionamento ≥ {pesos.dias_sem_acionamento?.min} dias · +
            {pesos.valor?.peso} se saldo ≥ {moeda(pesos.valor?.min)} · +
            {pesos.termo_pendente?.peso} se termo pendente · +{pesos.fim_mes?.peso} perto do fim do mês
            {dados?.fim_mes ? " (ativo agora)" : ""}
            <br />
            <span style={{ opacity: 0.7 }}>
              Score ≥ {dados?.config?.niveis?.critico} → Crítico · ≥ {dados?.config?.niveis?.urgente} → Urgente · ≥{" "}
              {dados?.config?.niveis?.atencao} → Atenção · senão Normal.
            </span>
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 6 }}>
        {NIVEIS_CRIT.map((n) => (
          <span key={n.key} style={{ fontSize: 12, opacity: 0.8 }}>
            <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: n.cor, marginRight: 5 }} />
            {n.rotulo}
          </span>
        ))}
      </div>

      {ops.map((o) => {
        const total = NIVEIS_CRIT.reduce((s, n) => s + Number(o[n.key]?.qtd || 0), 0) || 1;
        return (
          <div key={o.operador_email} style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}>
              <strong>{o.operador_nome}</strong>
              <span style={{ opacity: 0.7 }}>
                {NIVEIS_CRIT.map((n) => `${num(o[n.key]?.qtd || 0)} ${n.rotulo.toLowerCase()}`).join(" · ")}
              </span>
            </div>
            <div style={{ display: "flex", height: 22, borderRadius: 6, overflow: "hidden" }}>
              {NIVEIS_CRIT.map((n) => {
                const q = Number(o[n.key]?.qtd || 0);
                const pct = (q / total) * 100;
                if (!pct) return null;
                return (
                  <div
                    key={n.key}
                    title={`${n.rotulo}: ${num(q)} · ${moeda(o[n.key]?.valor)}`}
                    style={{ width: `${pct}%`, background: n.cor, minWidth: q ? 2 : 0 }}
                  />
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function anoQtd(ind, ano) {
  const a = (ind?.anos || []).find((x) => Number(x.ano) === ano);
  return a ? Number(a.qtd || 0) : 0;
}

const METRICAS_COMP = [
  { key: "cpfs", rotulo: "CPFs", get: (i) => qv(i, "cpfs").qtd, fmt: num, ruim: false },
  { key: "saldo", rotulo: "Saldo", get: (i) => qv(i, "saldo_total").valor, fmt: moeda, ruim: false },
  { key: "medio", rotulo: "Médio/CPF", get: (i) => Number(i?.valor_medio_cpf || 0), fmt: moeda, ruim: false },
  { key: "criticos", rotulo: "Críticos", get: (i) => qv(i, "criticos").qtd, fmt: num, ruim: true },
  { key: "sem_ac", rotulo: "Sem acionam.", get: (i) => qv(i, "sem_acionamento").qtd, fmt: num, ruim: true },
  { key: "antigos", rotulo: "Antigos 360+", get: (i) => qv(i, "antigos").qtd, fmt: num, ruim: true },
  { key: "ac_venc", rotulo: "Acordos venc.", get: (i) => qv(i, "acordos_vencidos").qtd, fmt: num, ruim: true },
  { key: "d2026", rotulo: "Dívidas 2026", get: (i) => anoQtd(i, 2026), fmt: num, ruim: true },
];

function indiceEquilibrio(vals) {
  const arr = vals.filter((v) => typeof v === "number");
  if (arr.length < 2) return 100;
  const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
  if (!avg) return 100;
  const variance = arr.reduce((a, b) => a + (b - avg) ** 2, 0) / arr.length;
  const cv = Math.sqrt(variance) / avg;
  return Math.max(0, Math.round((1 - cv) * 1000) / 10);
}

function Comparacao({ operadores }) {
  const ops = (operadores || []).filter((o) => (o.operador_email || "").startsWith("cobranca"));
  if (!ops.length) {
    return <div style={S.vazio}>Sem snapshot para comparar. Clique em “Atualizar dados”.</div>;
  }

  // máximos por métrica (para normalizar barras) e médias (para alertas)
  const stats = {};
  for (const m of METRICAS_COMP) {
    const vals = ops.map((o) => m.get(o.indicadores || {}));
    stats[m.key] = {
      max: Math.max(...vals, 0),
      avg: vals.reduce((a, b) => a + b, 0) / vals.length,
      indice: indiceEquilibrio(vals),
    };
  }

  // alertas automáticos de desequilíbrio (item 2.2)
  const alertas = [];
  for (const m of METRICAS_COMP.filter((x) => x.ruim || x.key === "saldo" || x.key === "medio")) {
    const ranked = ops
      .map((o) => ({ nome: o.operador_nome, v: m.get(o.indicadores || {}) }))
      .sort((a, b) => b.v - a.v);
    const top = ranked[0];
    const avg = stats[m.key].avg;
    if (top && avg > 0 && top.v > avg * 1.4 && top.v > 0) {
      const frac = Math.round((top.v / avg - 1) * 100);
      alertas.push({
        ruim: m.ruim,
        texto: `${top.nome} tem ${m.fmt(top.v)} em "${m.rotulo}" — ${frac}% acima da média da equipe.`,
      });
    }
  }

  return (
    <div>
      {/* Índices de equilíbrio */}
      <div style={S.totais}>
        <TotalChip rotulo="Equilíbrio de saldo" valor={stats.saldo.indice} destaque />
        <TotalChip rotulo="Equilíbrio de CPFs" valor={stats.cpfs.indice} />
        <TotalChip rotulo="Equilíbrio de críticos" valor={stats.criticos.indice} tom="alerta" />
      </div>

      {/* Alertas */}
      {!!alertas.length && (
        <div style={{ marginBottom: 18 }}>
          <div style={S.grupoTitulo}>Alertas de desequilíbrio</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {alertas.map((a, idx) => (
              <div key={idx} style={{ ...S.alerta, ...(a.ruim ? S.alertaRuim : {}) }}>
                {a.ruim ? "⚠️ " : "ℹ️ "}
                {a.texto}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Matriz comparativa */}
      <div style={{ overflowX: "auto" }}>
        <table style={S.tabela}>
          <thead>
            <tr>
              <th style={S.th}>Operador</th>
              {METRICAS_COMP.map((m) => (
                <th key={m.key} style={{ ...S.th, textAlign: "right" }}>{m.rotulo}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ops.map((o) => {
              const i = o.indicadores || {};
              return (
                <tr key={o.operador_email}>
                  <td style={{ ...S.td, fontWeight: 700 }}>{o.operador_nome}</td>
                  {METRICAS_COMP.map((m) => {
                    const v = m.get(i);
                    const max = stats[m.key].max || 1;
                    const pct = Math.round((v / max) * 100);
                    const cor = m.ruim ? "#f87171" : "#38bdf8";
                    return (
                      <td key={m.key} style={{ ...S.td, textAlign: "right", minWidth: 92 }}>
                        <div style={{ fontSize: 13 }}>{m.fmt(v)}</div>
                        <div style={S.compTrack}>
                          <div style={{ ...S.compFill, width: `${pct}%`, background: cor }} />
                        </div>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p style={{ opacity: 0.5, fontSize: 12, marginTop: 10 }}>
        Barras vermelhas = indicadores de risco (quanto maior, pior); azuis = tamanho/valor da
        carteira. Índice de equilíbrio: 100 = carteiras idênticas na métrica.
      </p>
    </div>
  );
}

const CRITERIOS = [
  { valor: "EQUIPARAR_SALDO", rotulo: "Equiparar saldo financeiro (troca)" },
  { valor: "EQUIPARAR_QTD", rotulo: "Equiparar quantidade de CPFs" },
  { valor: "RETIRAR_SEM_ACIONAMENTO", rotulo: "Retirar sem acionamento e redistribuir" },
];

function Simulador({ operadores, onExecutado }) {
  const opcoesOp = (operadores || []).filter((o) => (o.operador_email || "").startsWith("cobranca"));
  const [tipo, setTipo] = useState("EQUIPARAR_SALDO");
  const [selecionados, setSelecionados] = useState(() => opcoesOp.map((o) => o.operador_email));
  const [origem, setOrigem] = useState("");
  const [simulando, setSimulando] = useState(false);
  const [erro, setErro] = useState("");
  const [sim, setSim] = useState(null);
  const [fase, setFase] = useState("idle"); // idle | simulado | aprovado | executado
  const [processando, setProcessando] = useState(false);

  function toggleOp(email) {
    setSelecionados((s) => (s.includes(email) ? s.filter((e) => e !== email) : [...s, email]));
  }

  async function simular() {
    setSimulando(true);
    setErro("");
    setSim(null);
    setFase("idle");
    try {
      const criterio = { tipo, operadores: selecionados };
      if (tipo === "RETIRAR_SEM_ACIONAMENTO" && origem) criterio.origem = origem;
      const { data, error } = await supabase.rpc("calibragem_simular", { p_criterio: criterio });
      if (error) throw error;
      setSim(data);
      setFase("simulado");
    } catch (e) {
      setErro(e?.message || String(e));
    } finally {
      setSimulando(false);
    }
  }

  async function aprovar() {
    if (!sim?.simulacao_id) return;
    setProcessando(true);
    setErro("");
    try {
      const { error } = await supabase.rpc("calibragem_aprovar_simulacao", { p_id: sim.simulacao_id });
      if (error) throw error;
      setFase("aprovado");
    } catch (e) {
      setErro(e?.message || String(e));
    } finally {
      setProcessando(false);
    }
  }

  async function executar() {
    if (!sim?.simulacao_id) return;
    const ok = window.confirm(
      `Executar ${sim.total_movimentacoes} movimentações? Os casos serão reatribuídos AGORA aos novos operadores (com auditoria e marcador "Retirado por nivelamento"). Esta ação move a carteira real.`
    );
    if (!ok) return;
    setProcessando(true);
    setErro("");
    try {
      const { data, error } = await supabase.rpc("calibragem_executar_simulacao", { p_id: sim.simulacao_id });
      if (error) throw error;
      setFase("executado");
      window.alert(`Executado: ${data.executados} movimentações (${data.pulados} puladas por mudança de estado).`);
      onExecutado?.();
    } catch (e) {
      setErro(e?.message || String(e));
    } finally {
      setProcessando(false);
    }
  }

  const antes = sim?.antes || [];
  const depois = sim?.depois || [];
  const depoisPorEmail = Object.fromEntries(depois.map((d) => [d.op_email, d]));
  const movs = sim?.movimentacoes || [];

  return (
    <div>
      <div style={S.simConfig}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <label style={S.simLabel}>Critério de nivelamento</label>
          <select style={S.simSelect} value={tipo} onChange={(e) => setTipo(e.target.value)}>
            {CRITERIOS.map((c) => (
              <option key={c.valor} value={c.valor}>{c.rotulo}</option>
            ))}
          </select>
          {tipo === "RETIRAR_SEM_ACIONAMENTO" && (
            <>
              <label style={{ ...S.simLabel, marginTop: 10 }}>Operador de origem (opcional)</label>
              <select style={S.simSelect} value={origem} onChange={(e) => setOrigem(e.target.value)}>
                <option value="">Todos os selecionados</option>
                {opcoesOp.map((o) => (
                  <option key={o.operador_email} value={o.operador_email}>{o.operador_nome}</option>
                ))}
              </select>
            </>
          )}
        </div>
        <div style={{ flex: 1, minWidth: 260 }}>
          <label style={S.simLabel}>Operadores participantes</label>
          <div style={S.opChips}>
            {opcoesOp.map((o) => {
              const on = selecionados.includes(o.operador_email);
              return (
                <button
                  key={o.operador_email}
                  type="button"
                  onClick={() => toggleOp(o.operador_email)}
                  style={{ ...S.opChip, ...(on ? S.opChipOn : {}) }}
                >
                  {o.operador_nome}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <button
        type="button"
        style={S.btnSimular}
        onClick={simular}
        disabled={simulando || selecionados.length < 2}
      >
        {simulando ? "Simulando…" : "▶ Simular"}
      </button>

      {erro && <div style={{ ...S.erro, marginTop: 12 }}>{erro}</div>}

      {sim && (
        <div style={{ marginTop: 20 }}>
          <div style={S.simResumo}>
            <div style={S.simKpi}>
              <div style={S.simKpiV}>{sim.total_movimentacoes}</div>
              <div style={S.simKpiR}>movimentações</div>
            </div>
            <div style={S.simKpi}>
              <div style={S.simKpiV}>{sim.indice_antes}</div>
              <div style={S.simKpiR}>índice antes</div>
            </div>
            <div style={S.simKpi}>
              <div style={{ ...S.simKpiV, color: "#34d399" }}>{sim.indice_depois}</div>
              <div style={S.simKpiR}>índice depois</div>
            </div>
            <div style={S.simKpi}>
              <div style={S.simKpiV}>
                {sim.metrica === "QTD" ? num(sim.alvo) : moeda(sim.alvo)}
              </div>
              <div style={S.simKpiR}>alvo ({sim.metrica === "QTD" ? "CPFs" : "saldo"})</div>
            </div>
          </div>

          {/* Antes/Depois por operador */}
          <div style={{ overflowX: "auto", marginTop: 16 }}>
            <table style={S.tabela}>
              <thead>
                <tr>
                  <th style={S.th}>Operador</th>
                  <th style={{ ...S.th, textAlign: "right" }}>CPFs antes</th>
                  <th style={{ ...S.th, textAlign: "right" }}>CPFs depois</th>
                  <th style={{ ...S.th, textAlign: "right" }}>Saldo antes</th>
                  <th style={{ ...S.th, textAlign: "right" }}>Saldo depois</th>
                </tr>
              </thead>
              <tbody>
                {antes.map((a) => {
                  const d = depoisPorEmail[a.op_email] || a;
                  const dSaldo = Number(d.saldo) - Number(a.saldo);
                  return (
                    <tr key={a.op_email}>
                      <td style={S.td}>{a.op_nome}</td>
                      <td style={{ ...S.td, textAlign: "right" }}>{num(a.qtd)}</td>
                      <td style={{ ...S.td, textAlign: "right" }}>{num(d.qtd)}</td>
                      <td style={{ ...S.td, textAlign: "right" }}>{moeda(a.saldo)}</td>
                      <td style={{ ...S.td, textAlign: "right" }}>
                        {moeda(d.saldo)}
                        <span style={{ fontSize: 11, marginLeft: 6, color: dSaldo < 0 ? "#f87171" : "#34d399" }}>
                          {dSaldo >= 0 ? "▲" : "▼"}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Movimentações */}
          {!!movs.length && (
            <div style={{ marginTop: 16 }}>
              <div style={S.grupoTitulo}>Movimentações sugeridas ({movs.length})</div>
              <div style={{ overflowX: "auto", maxHeight: 320, overflowY: "auto" }}>
                <table style={S.tabela}>
                  <thead>
                    <tr>
                      <th style={S.th}>Aluno</th>
                      <th style={{ ...S.th, textAlign: "right" }}>Valor</th>
                      <th style={S.th}>De</th>
                      <th style={S.th}>Para</th>
                      <th style={S.th}>Motivo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {movs.map((m) => (
                      <tr key={m.caso_id}>
                        <td style={S.td}>{m.nome || m.cpf}</td>
                        <td style={{ ...S.td, textAlign: "right" }}>{moeda(m.valor)}</td>
                        <td style={S.td}>{m.de_nome}</td>
                        <td style={S.td}>{m.para_nome}</td>
                        <td style={{ ...S.td, fontSize: 12, opacity: 0.8 }}>{m.motivo}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Ações de aprovação/execução */}
          {sim.total_movimentacoes > 0 && (
            <div style={S.simAcoes}>
              {fase === "simulado" && (
                <button type="button" style={S.btnAprovar} onClick={aprovar} disabled={processando}>
                  {processando ? "Aprovando…" : "✓ Aprovar simulação"}
                </button>
              )}
              {fase === "aprovado" && (
                <button type="button" style={S.btnExecutar} onClick={executar} disabled={processando}>
                  {processando ? "Executando…" : "⚡ Executar movimentações"}
                </button>
              )}
              {fase === "executado" && (
                <div style={S.simOk}>✓ Executado. Carteiras atualizadas.</div>
              )}
              <span style={S.simDica}>
                {fase === "simulado" && "Revise as movimentações e aprove para liberar a execução."}
                {fase === "aprovado" && "Aprovado. A execução move a carteira real e é auditada."}
              </span>
            </div>
          )}
          {sim.total_movimentacoes === 0 && (
            <div style={{ ...S.vazio, marginTop: 16 }}>
              As carteiras já estão equilibradas para este critério — nenhuma movimentação sugerida.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TotalChip({ rotulo, valor, destaque, tom }) {
  const cor = tom === "critico" ? "#f87171" : tom === "alerta" ? "#fbbf24" : destaque ? "#34d399" : "#e2e8f0";
  return (
    <div style={S.totalChip}>
      <div style={{ ...S.totalValor, color: cor }}>{valor}</div>
      <div style={S.totalRotulo}>{rotulo}</div>
    </div>
  );
}

function CardOperador({ operador, onDrill }) {
  const i = operador.indicadores || {};
  const limite = i.limite || {};
  const usado = Number(limite.usado || 0);
  const total = Number(limite.total || 500);
  const pct = Math.min(100, Math.round((usado / total) * 100));
  const saldo = qv(i, "saldo_total").valor;
  const vmCpf = Number(i.valor_medio_cpf || 0);
  const vmMen = Number(i.valor_medio_mensalidade || 0);

  return (
    <div style={S.card}>
      <div style={S.cardTopo}>
        <div>
          <div style={S.opNome}>{operador.operador_nome || operador.operador_email}</div>
          <div style={S.opEmail}>{operador.operador_email}</div>
        </div>
        <div style={S.saldoBox}>
          <div style={S.saldoValor}>{moeda(saldo)}</div>
          <div style={S.saldoRotulo}>saldo</div>
        </div>
      </div>

      {/* Barra do limite de 500 */}
      <div style={S.limiteWrap}>
        <div style={S.limiteInfo}>
          <span>{usado} / {total} casos</span>
          <span style={{ opacity: 0.7 }}>{Math.max(0, total - usado)} livres</span>
        </div>
        <div style={S.limiteTrack}>
          <div
            style={{
              ...S.limiteFill,
              width: `${pct}%`,
              background: pct >= 100 ? "#f87171" : pct >= 90 ? "#fbbf24" : "#34d399",
            }}
          />
        </div>
      </div>

      <div style={S.medias}>
        <span>Médio/CPF: <strong>{moeda(vmCpf)}</strong></span>
        <span>Médio/mensalidade: <strong>{moeda(vmMen)}</strong></span>
      </div>

      {GRUPOS.map((g) => (
        <div key={g.titulo} style={S.grupo}>
          <div style={S.grupoTitulo}>{g.titulo}</div>
          <div style={S.indicadores}>
            {g.itens.map((it) => {
              const d = qv(i, it.chave);
              return (
                <button
                  key={it.chave}
                  type="button"
                  style={S.indicador}
                  onClick={() => onDrill(it.chave, it.rotulo)}
                  title="Ver casos deste indicador"
                >
                  <div style={S.indRotulo}>{it.rotulo}</div>
                  <div style={S.indValores}>
                    {!it.soValor && <span style={S.indQtd}>{num(d.qtd)}</span>}
                    <span style={S.indValor}>{moeda(d.valor)}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      ))}

      {/* Distribuições por faixa de atraso e ano */}
      <div style={S.grupo}>
        <div style={S.grupoTitulo}>Por faixa de atraso</div>
        <div style={S.barras}>
          {(i.faixas_atraso || []).map((f) => (
            <BarraFaixa
              key={f.rotulo}
              rotulo={f.rotulo}
              qtd={f.qtd}
              valor={f.valor}
              onClick={() => onDrill("faixa_atraso", `Faixa ${f.rotulo} dias`, { faixa: f.rotulo })}
            />
          ))}
        </div>
      </div>
      <div style={S.grupo}>
        <div style={S.grupoTitulo}>Por ano da dívida</div>
        <div style={S.barras}>
          {(i.anos || []).map((a) => (
            <BarraFaixa
              key={a.ano}
              rotulo={String(a.ano)}
              qtd={a.qtd}
              valor={a.valor}
              onClick={() => onDrill("ano", `Dívidas de ${a.ano}`, { ano: a.ano })}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function BarraFaixa({ rotulo, qtd, valor, onClick }) {
  return (
    <button type="button" style={S.barraLinha} onClick={onClick} title="Ver casos">
      <span style={S.barraRotulo}>{rotulo}</span>
      <span style={S.barraQtd}>{num(qtd)}</span>
      <span style={S.barraValor}>{moeda(valor)}</span>
    </button>
  );
}

// Indicadores cuja lista vem da carteira (tabela casos) via drill-down
const DRILLABLE = new Set([
  "cpfs", "saldo_total", "mensalidades", "titulos_abertos",
  "sem_acionamento", "sem_acionamento_recente", "criticos", "antigos",
  "faixa_atraso", "ano",
]);

function ModalDetalhe({ detalhe, onClose }) {
  const { operador, chave, rotulo, faixa, ano } = detalhe;
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState("");
  const [lista, setLista] = useState(null);
  const drillable = DRILLABLE.has(chave);

  useEffect(() => {
    if (!drillable) return;
    let ativo = true;
    (async () => {
      setCarregando(true);
      setErro("");
      try {
        const { data, error } = await supabase.rpc("calibragem_listar_casos", {
          p_operador_email: operador.operador_email,
          p_indicador: chave,
          p_faixa: faixa ?? null,
          p_ano: ano ?? null,
        });
        if (error) throw error;
        if (ativo) setLista(data);
      } catch (e) {
        if (ativo) setErro(e?.message || String(e));
      } finally {
        if (ativo) setCarregando(false);
      }
    })();
    return () => {
      ativo = false;
    };
  }, [operador.operador_email, chave, faixa, ano, drillable]);

  const casos = lista?.casos || [];
  const totalSaldo = casos.reduce((s, c) => s + Number(c.saldo || 0), 0);

  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={{ ...S.modal, width: "min(880px, 100%)" }} onClick={(e) => e.stopPropagation()}>
        <div style={S.modalHeader}>
          <div>
            <div style={S.modalTitulo}>{rotulo}</div>
            <div style={S.modalSub}>{operador.operador_nome || operador.operador_email}</div>
          </div>
          <button type="button" style={S.modalX} onClick={onClose}>×</button>
        </div>
        <div style={S.modalCorpo}>
          {!drillable ? (
            <p style={{ opacity: 0.75, fontSize: 14, lineHeight: 1.5 }}>
              Este indicador é derivado de acordos/pagamentos. A lista detalhada de acordos deste
              indicador entra no próximo incremento (funil de acordos). Os números vêm do snapshot
              atual.
            </p>
          ) : carregando ? (
            <div style={{ padding: 20, opacity: 0.7 }}>Carregando casos…</div>
          ) : erro ? (
            <div style={S.erro}>{erro}</div>
          ) : (
            <>
              <div style={S.modalKpis}>
                <div style={S.modalKpi}>
                  <div style={S.modalKpiValor}>{num(casos.length)}</div>
                  <div style={S.modalKpiRot}>casos{lista?.total >= 300 ? " (top 300)" : ""}</div>
                </div>
                <div style={S.modalKpi}>
                  <div style={S.modalKpiValor}>{moeda(totalSaldo)}</div>
                  <div style={S.modalKpiRot}>saldo listado</div>
                </div>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={S.tabela}>
                  <thead>
                    <tr>
                      <th style={S.th}>Nome</th>
                      <th style={S.th}>CPF</th>
                      <th style={{ ...S.th, textAlign: "right" }}>Saldo</th>
                      <th style={{ ...S.th, textAlign: "right" }}>Atraso</th>
                      <th style={S.th}>Criticidade</th>
                      <th style={S.th}>Últ. acionamento</th>
                    </tr>
                  </thead>
                  <tbody>
                    {casos.map((c) => (
                      <tr key={c.caso_id}>
                        <td style={S.td}>{c.nome || "—"}</td>
                        <td style={S.tdMono}>{c.cpf || "—"}</td>
                        <td style={{ ...S.td, textAlign: "right" }}>{moeda(c.saldo)}</td>
                        <td style={{ ...S.td, textAlign: "right" }}>{num(c.dias_atraso)}d</td>
                        <td style={S.td}>
                          <TagCrit valor={c.criticidade} />
                        </td>
                        <td style={S.td}>
                          {c.ultimo_acionamento
                            ? new Date(c.ultimo_acionamento).toLocaleDateString("pt-BR")
                            : c.status_acionamento || "—"}
                        </td>
                      </tr>
                    ))}
                    {!casos.length && (
                      <tr>
                        <td style={S.td} colSpan={6}>Nenhum caso neste recorte.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function TagCrit({ valor }) {
  const v = String(valor || "").toUpperCase();
  const cor =
    v === "CRITICO" ? "#f87171" : v === "URGENTE" ? "#fb923c" : v === "ATENCAO" ? "#fbbf24" : "#94a3b8";
  return (
    <span style={{ color: cor, fontWeight: 700, fontSize: 12 }}>
      {valor && valor !== "-" ? valor : "—"}
    </span>
  );
}

const S = {
  container: { padding: "24px 28px", fontFamily: FONTE, color: "#e2e8f0", maxWidth: 1400, margin: "0 auto" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap", marginBottom: 20 },
  titulo: { fontSize: 26, fontWeight: 800, margin: 0 },
  subtitulo: { opacity: 0.7, margin: "6px 0 0", maxWidth: 620, fontSize: 14, lineHeight: 1.5 },
  meta: { opacity: 0.5, margin: "8px 0 0", fontSize: 12 },
  btnAtualizar: { padding: "10px 18px", borderRadius: 10, border: "1px solid rgba(52,211,153,0.5)", background: "rgba(52,211,153,0.14)", color: "#a7f3d0", fontWeight: 700, cursor: "pointer", fontSize: 14, whiteSpace: "nowrap" },
  erro: { background: "rgba(248,113,113,0.12)", border: "1px solid rgba(248,113,113,0.35)", color: "#fca5a5", padding: "10px 14px", borderRadius: 10, marginBottom: 16, fontSize: 14 },
  vazio: { padding: 40, textAlign: "center", opacity: 0.7, border: "1px dashed rgba(148,163,184,0.3)", borderRadius: 12 },
  totais: { display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20 },
  totalChip: { background: "rgba(148,163,184,0.08)", border: "1px solid rgba(148,163,184,0.15)", borderRadius: 12, padding: "12px 16px", minWidth: 130 },
  totalValor: { fontSize: 20, fontWeight: 800 },
  totalRotulo: { fontSize: 12, opacity: 0.65, marginTop: 2 },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))", gap: 16 },
  card: { background: "linear-gradient(180deg, rgba(30,41,59,0.6), rgba(15,23,42,0.4))", border: "1px solid rgba(148,163,184,0.15)", borderRadius: 16, padding: 18 },
  cardTopo: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, marginBottom: 14 },
  opNome: { fontSize: 17, fontWeight: 800 },
  opEmail: { fontSize: 12, opacity: 0.5, marginTop: 2 },
  saldoBox: { textAlign: "right" },
  saldoValor: { fontSize: 18, fontWeight: 800, color: "#34d399" },
  saldoRotulo: { fontSize: 11, opacity: 0.55 },
  limiteWrap: { marginBottom: 12 },
  limiteInfo: { display: "flex", justifyContent: "space-between", fontSize: 12, opacity: 0.8, marginBottom: 4 },
  limiteTrack: { height: 8, background: "rgba(148,163,184,0.15)", borderRadius: 999, overflow: "hidden" },
  limiteFill: { height: "100%", borderRadius: 999, transition: "width .3s" },
  medias: { display: "flex", justifyContent: "space-between", gap: 10, fontSize: 12, opacity: 0.85, marginBottom: 14, flexWrap: "wrap" },
  grupo: { marginBottom: 14 },
  grupoTitulo: { fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, opacity: 0.55, marginBottom: 8, fontWeight: 700 },
  indicadores: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 },
  indicador: { textAlign: "left", background: "rgba(148,163,184,0.06)", border: "1px solid rgba(148,163,184,0.12)", borderRadius: 10, padding: "8px 10px", cursor: "pointer", color: "inherit", fontFamily: FONTE },
  indRotulo: { fontSize: 11, opacity: 0.7, marginBottom: 3 },
  indValores: { display: "flex", alignItems: "baseline", gap: 6, justifyContent: "space-between" },
  indQtd: { fontSize: 16, fontWeight: 800 },
  indValor: { fontSize: 12, opacity: 0.85, color: "#93c5fd" },
  barras: { display: "flex", flexDirection: "column", gap: 4 },
  barraLinha: { display: "grid", gridTemplateColumns: "70px 50px 1fr", gap: 8, fontSize: 12, alignItems: "center", padding: "4px 6px", width: "100%", background: "none", border: "none", borderRadius: 6, color: "inherit", cursor: "pointer", fontFamily: FONTE, textAlign: "left" },
  barraRotulo: { opacity: 0.7 },
  barraQtd: { fontWeight: 700, textAlign: "right" },
  barraValor: { textAlign: "right", opacity: 0.85, color: "#93c5fd" },
  overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 20 },
  modal: { background: "#0f172a", border: "1px solid rgba(148,163,184,0.25)", borderRadius: 16, width: "min(560px, 100%)", maxHeight: "80vh", overflow: "auto" },
  modalHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 20px", borderBottom: "1px solid rgba(148,163,184,0.15)" },
  modalTitulo: { fontSize: 18, fontWeight: 800 },
  modalSub: { fontSize: 13, opacity: 0.6, marginTop: 2 },
  modalX: { background: "none", border: "none", color: "#e2e8f0", fontSize: 26, cursor: "pointer", lineHeight: 1 },
  modalCorpo: { padding: 20 },
  modalKpis: { display: "flex", gap: 14, marginBottom: 16 },
  modalKpi: { background: "rgba(148,163,184,0.08)", borderRadius: 12, padding: "14px 18px", flex: 1, textAlign: "center" },
  modalKpiValor: { fontSize: 22, fontWeight: 800 },
  modalKpiRot: { fontSize: 12, opacity: 0.6, marginTop: 2 },
  tabela: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", padding: "8px 10px", borderBottom: "1px solid rgba(148,163,184,0.2)", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, opacity: 0.6, position: "sticky", top: 0, background: "#0f172a" },
  td: { padding: "8px 10px", borderBottom: "1px solid rgba(148,163,184,0.08)" },
  tdMono: { padding: "8px 10px", borderBottom: "1px solid rgba(148,163,184,0.08)", fontFamily: "ui-monospace, monospace", fontSize: 12, opacity: 0.85 },
  tabs: { display: "flex", gap: 4, marginBottom: 18, borderBottom: "1px solid rgba(148,163,184,0.15)" },
  tab: { padding: "10px 16px", background: "none", border: "none", borderBottom: "2px solid transparent", color: "#94a3b8", fontWeight: 600, cursor: "pointer", fontFamily: FONTE, fontSize: 14 },
  tabAtiva: { color: "#e2e8f0", borderBottom: "2px solid #34d399" },
  simConfig: { display: "flex", gap: 24, flexWrap: "wrap", background: "rgba(148,163,184,0.05)", border: "1px solid rgba(148,163,184,0.12)", borderRadius: 12, padding: 16 },
  simLabel: { display: "block", fontSize: 12, opacity: 0.65, marginBottom: 6, fontWeight: 600 },
  simSelect: { width: "100%", padding: "9px 10px", borderRadius: 8, background: "#0f172a", color: "#e2e8f0", border: "1px solid rgba(148,163,184,0.25)", fontFamily: FONTE, fontSize: 14 },
  opChips: { display: "flex", flexWrap: "wrap", gap: 6 },
  opChip: { padding: "6px 10px", borderRadius: 999, border: "1px solid rgba(148,163,184,0.25)", background: "rgba(148,163,184,0.06)", color: "#94a3b8", cursor: "pointer", fontSize: 12, fontFamily: FONTE },
  opChipOn: { background: "rgba(52,211,153,0.16)", border: "1px solid rgba(52,211,153,0.5)", color: "#a7f3d0", fontWeight: 700 },
  btnSimular: { marginTop: 14, padding: "10px 22px", borderRadius: 10, border: "1px solid rgba(56,189,248,0.5)", background: "rgba(56,189,248,0.15)", color: "#bae6fd", fontWeight: 700, cursor: "pointer", fontSize: 14 },
  simResumo: { display: "flex", gap: 12, flexWrap: "wrap" },
  simKpi: { background: "rgba(148,163,184,0.08)", borderRadius: 12, padding: "12px 18px", minWidth: 120 },
  simKpiV: { fontSize: 22, fontWeight: 800 },
  simKpiR: { fontSize: 12, opacity: 0.6, marginTop: 2 },
  simAcoes: { display: "flex", alignItems: "center", gap: 14, marginTop: 18, flexWrap: "wrap" },
  btnAprovar: { padding: "10px 20px", borderRadius: 10, border: "1px solid rgba(251,191,36,0.5)", background: "rgba(251,191,36,0.15)", color: "#fde68a", fontWeight: 700, cursor: "pointer", fontSize: 14 },
  btnExecutar: { padding: "10px 20px", borderRadius: 10, border: "1px solid rgba(248,113,113,0.6)", background: "rgba(248,113,113,0.18)", color: "#fecaca", fontWeight: 800, cursor: "pointer", fontSize: 14 },
  simOk: { color: "#34d399", fontWeight: 700 },
  simDica: { fontSize: 13, opacity: 0.6 },
  alerta: { padding: "8px 12px", borderRadius: 8, background: "rgba(56,189,248,0.1)", border: "1px solid rgba(56,189,248,0.25)", fontSize: 13 },
  alertaRuim: { background: "rgba(248,113,113,0.1)", border: "1px solid rgba(248,113,113,0.3)" },
  compTrack: { height: 4, background: "rgba(148,163,184,0.15)", borderRadius: 999, overflow: "hidden", marginTop: 3 },
  compFill: { height: "100%", borderRadius: 999 },
};
