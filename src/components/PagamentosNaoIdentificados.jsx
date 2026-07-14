import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

function moeda(v) {
  return Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export default function PagamentosNaoIdentificados() {
  const [itens, setItens] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [busca, setBusca] = useState({});
  const [resultados, setResultados] = useState({});
  const [msg, setMsg] = useState("");

  async function carregar() {
    setCarregando(true);
    const { data } = await supabase.rpc("pagamentos_nao_identificados");
    setItens(Array.isArray(data) ? data : []);
    setCarregando(false);
  }
  useEffect(() => {
    carregar();
  }, []);

  async function buscarAluno(nomeNorm, termo) {
    setBusca((b) => ({ ...b, [nomeNorm]: termo }));
    if (!termo || termo.trim().length < 3) {
      setResultados((r) => ({ ...r, [nomeNorm]: [] }));
      return;
    }
    const { data } = await supabase
      .from("alunos")
      .select("id,nome,cpf,unidade")
      .ilike("nome", "%" + termo.trim() + "%")
      .limit(8);
    setResultados((r) => ({ ...r, [nomeNorm]: data || [] }));
  }

  async function vincular(nomeNorm, alunoId, alunoNome) {
    if (!window.confirm("Vincular este pagamento a " + alunoNome + " e criar a confirmacao?")) return;
    const { data, error } = await supabase.rpc("vincular_pagamento_aluno", {
      p_nome_norm: nomeNorm,
      p_aluno_id: alunoId,
    });
    if (error || !data || data.ok === false) {
      setMsg("Erro ao vincular: " + (error?.message || data?.erro || "desconhecido"));
      return;
    }
    setMsg("Vinculado a " + alunoNome + (data.ja_tinha ? " (ja tinha confirmacao)." : " - confirmacao criada."));
    setItens((lista) => lista.filter((i) => i.nome_norm !== nomeNorm));
  }

  if (carregando) {
    return (
      <div style={s.bloco}>
        <p style={s.muted}>Carregando pagamentos nao identificados...</p>
      </div>
    );
  }

  return (
    <div style={s.bloco}>
      <div style={s.head}>
        <h3 style={s.h3}>Pagamentos nao identificados</h3>
        <span style={s.sub}>{itens.length} para vincular manualmente (mes atual)</span>
      </div>
      {msg && <div style={s.msg}>{msg}</div>}
      {itens.length === 0 && <p style={s.muted}>Nenhum pagamento pendente de vinculo.</p>}
      {itens.map((it) => (
        <div key={it.nome_norm} style={s.item}>
          <div style={s.itemTopo}>
            <span>
              <strong>{it.aluno_nome}</strong>{" "}
              <em style={{ ...s.tag, ...(it.motivo === "AMBIGUO" ? s.tagAmb : s.tagNao) }}>
                {it.motivo === "AMBIGUO" ? "nome ambiguo" : "nao encontrado"}
              </em>
            </span>
            <strong>{moeda(it.valor)}</strong>
          </div>
          <div style={s.itemSub}>
            {it.operador || "-"} - {it.parcelas} parcela(s) - {it.data}
          </div>
          {it.motivo === "AMBIGUO" ? (
            <div style={s.cands}>
              {(it.candidatos || []).map((c) => (
                <button key={c.id} style={s.btnCand} onClick={() => vincular(it.nome_norm, c.id, c.nome)}>
                  {c.nome} - CPF {c.cpf || "-"} - {c.unidade || "-"}
                </button>
              ))}
            </div>
          ) : (
            <div style={s.busca}>
              <input
                style={s.input}
                placeholder="Buscar aluno por nome na base..."
                value={busca[it.nome_norm] || ""}
                onChange={(e) => buscarAluno(it.nome_norm, e.target.value)}
              />
              <div style={s.cands}>
                {(resultados[it.nome_norm] || []).map((c) => (
                  <button key={c.id} style={s.btnCand} onClick={() => vincular(it.nome_norm, c.id, c.nome)}>
                    {c.nome} - CPF {c.cpf || "-"} - {c.unidade || "-"}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

const s = {
  bloco: { background: "#fff", border: "1px solid #eef2f6", borderRadius: 16, padding: 18, marginBottom: 16, boxShadow: "0 1px 3px rgba(15,23,42,0.05)" },
  head: { display: "flex", alignItems: "baseline", gap: 10, marginBottom: 12, flexWrap: "wrap" },
  h3: { margin: 0, fontSize: 15, fontWeight: 700, color: "#0f172a" },
  sub: { fontSize: 13, color: "#64748b" },
  muted: { color: "#64748b", margin: 0 },
  msg: { background: "#ecfdf5", border: "1px solid #a7f3d0", color: "#065f46", borderRadius: 8, padding: "8px 12px", fontSize: 13, marginBottom: 12 },
  item: { border: "1px solid #f1f5f9", borderRadius: 12, padding: 12, marginBottom: 10 },
  itemTopo: { display: "flex", justifyContent: "space-between", gap: 10, fontSize: 14, color: "#0f172a", marginBottom: 3 },
  itemSub: { fontSize: 12, color: "#94a3b8", marginBottom: 8 },
  tag: { fontStyle: "normal", fontSize: 11, fontWeight: 700, borderRadius: 6, padding: "2px 6px" },
  tagAmb: { background: "#fef3c7", color: "#92400e" },
  tagNao: { background: "#fee2e2", color: "#991b1b" },
  busca: {},
  input: { width: "100%", padding: "9px 11px", borderRadius: 8, border: "1px solid #d1d5db", fontSize: 13, marginBottom: 8, boxSizing: "border-box" },
  cands: { display: "flex", flexDirection: "column", gap: 6 },
  btnCand: { textAlign: "left", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, padding: "8px 10px", fontSize: 13, color: "#334155", cursor: "pointer" },
};
