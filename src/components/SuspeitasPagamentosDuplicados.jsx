import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import { STATUS_SUSPEITA, decisaoValida, rotuloStatusSuspeita } from "../utils/suspeitasDuplicados";

// Aba "Suspeitas de pagamentos duplicados" (Projeção Hora a Hora).
// Etapa de TRIAGEM: só registra a decisão manual. NÃO estorna, NÃO zera
// valores, NÃO recalcula projeção/metas/ranking/honorários e NÃO altera os
// pagamentos originais.

function moeda(v) {
  if (v === null || v === undefined || v === "") return "-";
  return Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
function data(v) {
  if (!v) return "-";
  try {
    return new Date(v).toLocaleDateString("pt-BR");
  } catch {
    return String(v);
  }
}

export default function SuspeitasPagamentosDuplicados() {
  const [itens, setItens] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");
  const [msg, setMsg] = useState("");
  // Estado de edição por suspeita: { [id]: { decisao, manterId, duplicadoId, motivo } }
  const [form, setForm] = useState({});
  const [salvandoId, setSalvandoId] = useState(null);

  async function carregar() {
    setCarregando(true);
    setErro("");
    const { data: d, error } = await supabase.rpc("projecao_suspeitas_pagamentos_duplicados");
    if (error) {
      setErro("Erro ao carregar suspeitas: " + error.message);
      setItens([]);
    } else {
      setItens(Array.isArray(d) ? d : []);
    }
    setCarregando(false);
  }
  useEffect(() => {
    carregar();
  }, []);

  function setCampo(id, campo, valor) {
    setForm((f) => ({ ...f, [id]: { ...(f[id] || {}), [campo]: valor } }));
  }

  async function salvar(suspeita) {
    const f = form[suspeita.id] || {};
    const payload = {
      decisao: f.decisao,
      motivo: f.motivo,
      pagamentoManterId: f.decisao === STATUS_SUSPEITA.DUPLICIDADE ? f.manterId : null,
      pagamentoDuplicadoId: f.decisao === STATUS_SUSPEITA.DUPLICIDADE ? f.duplicadoId : null,
    };
    if (!f.decisao) return alert("Escolha uma decisão: legítimo ou duplicidade.");
    if (!decisaoValida(payload)) {
      if (f.decisao === STATUS_SUSPEITA.DUPLICIDADE && (!f.manterId || !f.duplicadoId || f.manterId === f.duplicadoId)) {
        return alert("Selecione qual linha manter e qual é a duplicada (devem ser diferentes).");
      }
      return alert("Motivo é obrigatório.");
    }
    setSalvandoId(suspeita.id);
    setMsg("");
    try {
      const { data: r, error } = await supabase.rpc("registrar_decisao_suspeita_duplicidade", {
        p_suspeita_id: suspeita.id,
        p_decisao: f.decisao,
        p_pagamento_manter_id: payload.pagamentoManterId,
        p_pagamento_duplicado_id: payload.pagamentoDuplicadoId,
        p_motivo: f.motivo,
      });
      if (error || !r || r.ok === false) {
        setErro("Erro ao registrar decisão: " + (error?.message || "desconhecido"));
        return;
      }
      setMsg("Decisão registrada (nenhum pagamento foi alterado nesta etapa).");
      await carregar();
    } finally {
      setSalvandoId(null);
    }
  }

  if (carregando) return <p style={{ opacity: 0.7 }}>Carregando suspeitas de pagamentos duplicados...</p>;

  return (
    <div>
      <div style={s.head}>
        <div>
          <h3 style={s.h3}>Suspeitas de pagamentos duplicados</h3>
          <p style={s.sub}>
            Somente grupos com indício objetivo (a mesma referência bancária/parcela aparece mais de uma vez).
            Esta etapa é de triagem: registrar a decisão <strong>não</strong> estorna, não zera valores e não
            altera projeção, metas, ranking ou honorários.
          </p>
        </div>
        <button style={s.btnAtualizar} onClick={carregar}>Atualizar</button>
      </div>

      {erro && <div style={s.erro}>{erro}</div>}
      {msg && <div style={s.ok}>{msg}</div>}

      {itens.length === 0 && <p style={s.muted}>Nenhuma suspeita pendente.</p>}

      {itens.map((it) => {
        const linhas = it.linhas || [];
        const f = form[it.id] || {};
        const decidida = it.status !== STATUS_SUSPEITA.PENDENTE;
        return (
          <div key={it.id} style={s.card}>
            <div style={s.cardTopo}>
              <div>
                <strong>Título {it.titulo_numero || "-"}</strong>{" "}
                <span style={s.chave}>ref. {it.chave_grupo}</span>
              </div>
              <div style={s.badges}>
                <span style={{ ...s.badge, ...corStatus(it.status) }}>{rotuloStatusSuspeita(it.status)}</span>
                {it.exige_conferencia_manual && (
                  <span style={{ ...s.badge, ...s.badgeManual }}>exige conferência manual</span>
                )}
              </div>
            </div>

            <div style={s.linhasWrap}>
              {linhas.map((l) => {
                const suspeitaVisual = l.sugerido_duplicado;
                return (
                  <div key={l.pagamento_id} style={{ ...s.linha, ...(suspeitaVisual ? s.linhaSuspeita : {}) }}>
                    {suspeitaVisual && <div style={s.tagSuspeita}>sugestão: possível duplicada</div>}
                    {l.sugerido_manter && <div style={s.tagManter}>sugestão: manter</div>}
                    <div style={s.linhaAluno}>{l.aluno_nome || "-"}</div>
                    <div style={s.kv}><span>Valor</span><strong>{moeda(l.valor_pago)}</strong></div>
                    <div style={s.kv}><span>Honorário</span><span>{moeda(l.valor_honorario)}</span></div>
                    <div style={s.kv}><span>Data</span><span>{data(l.data_pagamento)}</span></div>
                    <div style={s.kv}><span>Parcela</span><span>{l.numero_parcela_completo}</span></div>
                    <div style={s.kv}><span>Título</span><span>{l.titulo_numero || "-"}</span></div>
                    <div style={s.kv}><span>Operador</span><span>{l.operador_nome || l.operador_email || "-"}</span></div>
                    <div style={s.kv}><span>Arquivo</span><span title={l.arquivo || ""}>{l.arquivo || "-"}</span></div>
                    <div style={s.kv}><span>Importação</span><span>{l.import_status}</span></div>
                    <div style={s.kvId}><span>ID</span><span>{l.pagamento_id}</span></div>
                  </div>
                );
              })}
            </div>

            {decidida ? (
              <div style={s.decidida}>
                <strong>{rotuloStatusSuspeita(it.status)}</strong> — {it.motivo}
                <div style={s.muted}>
                  por {it.decidido_por_nome || it.decidido_por_email || "-"} · {data(it.decidido_em)}
                  {it.pagamento_manter_id && ` · manter ${it.pagamento_manter_id} · duplicada ${it.pagamento_duplicado_id}`}
                </div>
                <button style={s.btnReabrir} onClick={() => setForm((x) => ({ ...x, [it.id]: { decisao: "", motivo: "" } }))}>
                  Revisar decisão
                </button>
              </div>
            ) : (
              <div style={s.acoes}>
                <div style={s.linhaBotoes}>
                  <label style={s.radio}>
                    <input type="radio" name={`dec-${it.id}`} checked={f.decisao === STATUS_SUSPEITA.LEGITIMO}
                      onChange={() => setCampo(it.id, "decisao", STATUS_SUSPEITA.LEGITIMO)} /> Marcar como legítimo
                  </label>
                  <label style={s.radio}>
                    <input type="radio" name={`dec-${it.id}`} checked={f.decisao === STATUS_SUSPEITA.DUPLICIDADE}
                      onChange={() => setCampo(it.id, "decisao", STATUS_SUSPEITA.DUPLICIDADE)} /> Confirmar duplicidade
                  </label>
                </div>

                {f.decisao === STATUS_SUSPEITA.DUPLICIDADE && (
                  <div style={s.selects}>
                    <label style={s.label}>Linha a MANTER
                      <select style={s.select} value={f.manterId || ""} onChange={(e) => setCampo(it.id, "manterId", e.target.value)}>
                        <option value="">Selecione…</option>
                        {linhas.map((l) => (
                          <option key={l.pagamento_id} value={l.pagamento_id}>{moeda(l.valor_pago)} · {data(l.data_pagamento)} · {l.import_status}</option>
                        ))}
                      </select>
                    </label>
                    <label style={s.label}>Linha DUPLICADA
                      <select style={s.select} value={f.duplicadoId || ""} onChange={(e) => setCampo(it.id, "duplicadoId", e.target.value)}>
                        <option value="">Selecione…</option>
                        {linhas.map((l) => (
                          <option key={l.pagamento_id} value={l.pagamento_id}>{moeda(l.valor_pago)} · {data(l.data_pagamento)} · {l.import_status}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                )}

                <label style={s.label}>Motivo (obrigatório)
                  <textarea style={s.textarea} value={f.motivo || ""} placeholder="Descreva por que é legítimo ou por que é duplicidade."
                    onChange={(e) => setCampo(it.id, "motivo", e.target.value)} />
                </label>

                <button style={s.btnSalvar} disabled={salvandoId === it.id} onClick={() => salvar(it)}>
                  {salvandoId === it.id ? "Registrando…" : "Registrar decisão"}
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function corStatus(status) {
  if (status === STATUS_SUSPEITA.LEGITIMO) return { background: "#dcfce7", color: "#166534", border: "1px solid #bbf7d0" };
  if (status === STATUS_SUSPEITA.DUPLICIDADE) return { background: "#fee2e2", color: "#991b1b", border: "1px solid #fecaca" };
  return { background: "#fef3c7", color: "#92400e", border: "1px solid #fde68a" };
}

const s = {
  head: { display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", marginBottom: 14, flexWrap: "wrap" },
  h3: { margin: 0, fontSize: 16, color: "#0f172a" },
  sub: { margin: "4px 0 0", color: "#64748b", fontSize: 13, maxWidth: 720 },
  btnAtualizar: { background: "#111827", color: "#fff", border: "none", borderRadius: 8, padding: "8px 14px", cursor: "pointer", fontWeight: 700, height: "fit-content" },
  erro: { background: "#fee2e2", border: "1px solid #fecaca", color: "#991b1b", padding: 10, borderRadius: 8, marginBottom: 12, fontSize: 13 },
  ok: { background: "#dcfce7", border: "1px solid #bbf7d0", color: "#166534", padding: 10, borderRadius: 8, marginBottom: 12, fontSize: 13 },
  muted: { color: "#94a3b8", fontSize: 12 },
  card: { background: "#fff", border: "1px solid #eef2f6", borderRadius: 14, padding: 16, marginBottom: 14 },
  cardTopo: { display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", marginBottom: 12, flexWrap: "wrap" },
  chave: { color: "#64748b", fontSize: 12 },
  badges: { display: "flex", gap: 6, flexWrap: "wrap" },
  badge: { borderRadius: 999, padding: "3px 9px", fontSize: 11, fontWeight: 700 },
  badgeManual: { background: "#ede9fe", color: "#5b21b6", border: "1px solid #ddd6fe" },
  linhasWrap: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 },
  linha: { border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, position: "relative" },
  linhaSuspeita: { border: "1px solid #fca5a5", background: "#fff7f7" },
  tagSuspeita: { position: "absolute", top: 8, right: 8, background: "#fee2e2", color: "#991b1b", borderRadius: 6, padding: "2px 6px", fontSize: 10, fontWeight: 700 },
  tagManter: { position: "absolute", top: 8, right: 8, background: "#dcfce7", color: "#166534", borderRadius: 6, padding: "2px 6px", fontSize: 10, fontWeight: 700 },
  linhaAluno: { fontWeight: 700, color: "#0f172a", marginBottom: 6 },
  kv: { display: "flex", justifyContent: "space-between", gap: 8, fontSize: 13, color: "#374151", padding: "2px 0" },
  kvId: { display: "flex", justifyContent: "space-between", gap: 8, fontSize: 10, color: "#94a3b8", padding: "4px 0 0", wordBreak: "break-all" },
  acoes: { marginTop: 14, borderTop: "1px solid #f1f5f9", paddingTop: 12 },
  linhaBotoes: { display: "flex", gap: 18, flexWrap: "wrap", marginBottom: 8 },
  radio: { fontSize: 13, color: "#0f172a", display: "flex", gap: 6, alignItems: "center", cursor: "pointer" },
  selects: { display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 8 },
  label: { display: "flex", flexDirection: "column", gap: 4, fontSize: 12, fontWeight: 700, color: "#0f172a", flex: 1, minWidth: 220 },
  select: { padding: "8px 10px", borderRadius: 8, border: "1px solid #d1d5db", fontSize: 13, fontWeight: 400 },
  textarea: { minHeight: 60, padding: 10, borderRadius: 8, border: "1px solid #d1d5db", fontSize: 13, fontWeight: 400, resize: "vertical", fontFamily: "inherit" },
  btnSalvar: { marginTop: 10, background: "#0ea5e9", color: "#fff", border: "none", borderRadius: 8, padding: "10px 16px", cursor: "pointer", fontWeight: 700 },
  decidida: { marginTop: 12, borderTop: "1px solid #f1f5f9", paddingTop: 10, fontSize: 13, color: "#374151" },
  btnReabrir: { marginTop: 8, background: "#e5e7eb", color: "#374151", border: "none", borderRadius: 8, padding: "6px 12px", cursor: "pointer", fontWeight: 700, fontSize: 12 },
};
