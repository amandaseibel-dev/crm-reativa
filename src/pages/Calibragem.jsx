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

      {erro && <div style={S.erro}>{erro}</div>}

      {carregando ? (
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
                onDrill={(chave, rotulo) => setDetalhe({ operador: o, chave, rotulo })}
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
            <BarraFaixa key={f.rotulo} rotulo={f.rotulo} qtd={f.qtd} valor={f.valor} />
          ))}
        </div>
      </div>
      <div style={S.grupo}>
        <div style={S.grupoTitulo}>Por ano da dívida</div>
        <div style={S.barras}>
          {(i.anos || []).map((a) => (
            <BarraFaixa key={a.ano} rotulo={String(a.ano)} qtd={a.qtd} valor={a.valor} />
          ))}
        </div>
      </div>
    </div>
  );
}

function BarraFaixa({ rotulo, qtd, valor }) {
  return (
    <div style={S.barraLinha}>
      <span style={S.barraRotulo}>{rotulo}</span>
      <span style={S.barraQtd}>{num(qtd)}</span>
      <span style={S.barraValor}>{moeda(valor)}</span>
    </div>
  );
}

function ModalDetalhe({ detalhe, onClose }) {
  const { operador, chave, rotulo } = detalhe;
  const d = qv(operador.indicadores, chave);
  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.modal} onClick={(e) => e.stopPropagation()}>
        <div style={S.modalHeader}>
          <div>
            <div style={S.modalTitulo}>{rotulo}</div>
            <div style={S.modalSub}>{operador.operador_nome || operador.operador_email}</div>
          </div>
          <button type="button" style={S.modalX} onClick={onClose}>×</button>
        </div>
        <div style={S.modalCorpo}>
          <div style={S.modalKpis}>
            <div style={S.modalKpi}>
              <div style={S.modalKpiValor}>{num(d.qtd)}</div>
              <div style={S.modalKpiRot}>casos</div>
            </div>
            <div style={S.modalKpi}>
              <div style={S.modalKpiValor}>{moeda(d.valor)}</div>
              <div style={S.modalKpiRot}>saldo</div>
            </div>
          </div>
          <p style={{ opacity: 0.75, fontSize: 14, lineHeight: 1.5 }}>
            A lista detalhada dos casos deste indicador (clicável, com filtros combináveis) será
            aberta aqui — próximo incremento da Calibragem. Por ora, os números vêm do último
            snapshot calculado.
          </p>
        </div>
      </div>
    </div>
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
  barraLinha: { display: "grid", gridTemplateColumns: "70px 50px 1fr", gap: 8, fontSize: 12, alignItems: "center", padding: "3px 0" },
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
};
