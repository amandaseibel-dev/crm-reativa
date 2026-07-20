import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import Aluno from "./Aluno";

// Fila de acordos importados para a operacao confirmar/acompanhar.
// Lista 1 linha por acordo (agrupado por CPF + base do bloqueto).

function moeda(n) { return (Number(n) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }

export default function FilaAcordosConfirmar() {
  const [itens, setItens] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [filtro, setFiltro] = useState("A_CONFIRMAR");
  const [busca, setBusca] = useState("");
  const [email, setEmail] = useState("");
  const [fichaId, setFichaId] = useState(null);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getUser();
      setEmail(data?.user?.email || "");
      carregar();
    })();
  }, [filtro]);

  async function carregar() {
    setCarregando(true);
    let q = supabase.from("fila_acordos_confirmar").select("*").order("valor_total", { ascending: false }).limit(1000);
    if (filtro !== "TODOS") q = q.eq("status_confirmacao", filtro);
    const { data } = await q;
    setItens(data || []);
    setCarregando(false);
  }

  async function confirmar(item) {
    const { error } = await supabase.from("fila_acordos_confirmar")
      .update({ status_confirmacao: "CONFIRMADO", operador_email: email, confirmado_em: new Date().toISOString() })
      .eq("id", item.id);
    if (error) { alert("Erro: " + error.message); return; }
    carregar();
  }

  async function reabrir(item) {
    const { error } = await supabase.from("fila_acordos_confirmar")
      .update({ status_confirmacao: "A_CONFIRMAR", confirmado_em: null })
      .eq("id", item.id);
    if (error) { alert("Erro: " + error.message); return; }
    carregar();
  }

  const filtrados = itens.filter((i) => {
    if (!busca.trim()) return true;
    const t = busca.toLowerCase();
    return String(i.nome || "").toLowerCase().includes(t) || String(i.cpf || "").includes(t.replace(/\D/g, ""));
  });

  const totalFila = filtrados.reduce((s, i) => s + (Number(i.valor_total) || 0), 0);

  return (
    <div style={S.wrap}>
      <div style={S.topo}>
        <div>
          <h1 style={S.titulo}>Fila de confirmação de acordos</h1>
          <p style={S.sub}>Acordos importados para a operação confirmar com o aluno e acompanhar.</p>
        </div>
        <button style={S.btnGhost} onClick={carregar}>Atualizar</button>
      </div>

      <div style={S.barra}>
        <select style={S.select} value={filtro} onChange={(e) => setFiltro(e.target.value)}>
          <option value="A_CONFIRMAR">A confirmar</option>
          <option value="CONFIRMADO">Confirmados</option>
          <option value="TODOS">Todos</option>
        </select>
        <input style={S.input} placeholder="Buscar por nome ou CPF..." value={busca} onChange={(e) => setBusca(e.target.value)} />
        <span style={S.contador}>{filtrados.length} acordos · {moeda(totalFila)}</span>
      </div>

      {carregando ? (
        <p style={S.muted}>Carregando...</p>
      ) : filtrados.length === 0 ? (
        <p style={S.muted}>Nenhum acordo nesta fila.</p>
      ) : (
        <table style={S.tabela}>
          <thead>
            <tr>
              <th style={S.th}>Aluno</th>
              <th style={S.th}>CPF</th>
              <th style={S.th}>Unidade</th>
              <th style={S.thNum}>Parcelas</th>
              <th style={S.thNum}>Valor</th>
              <th style={S.th}>Status</th>
              <th style={S.th}></th>
            </tr>
          </thead>
          <tbody>
            {filtrados.map((i) => (
              <tr key={i.id}>
                <td style={S.td}><strong>{i.nome || "-"}</strong></td>
                <td style={S.td}>{i.cpf}</td>
                <td style={S.tdMuted}>{i.unidade || "-"}</td>
                <td style={S.tdNum}>{i.qtd_parcelas}</td>
                <td style={S.tdNum}>{moeda(i.valor_total)}</td>
                <td style={S.td}>
                  <span style={{ ...S.chip, ...(i.status_confirmacao === "CONFIRMADO" ? S.chipOk : S.chipPend) }}>
                    {i.status_confirmacao === "CONFIRMADO" ? "Confirmado" : "A confirmar"}
                  </span>
                </td>
                <td style={S.td}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "flex-end" }}>
                    <button style={S.btnFicha} onClick={() => setFichaId(i.aluno_id)}>Abrir ficha</button>
                    {i.status_confirmacao === "CONFIRMADO"
                      ? <button style={S.btnMini} onClick={() => reabrir(i)}>reabrir</button>
                      : <button style={S.btnConf} onClick={() => confirmar(i)}>Confirmar</button>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {fichaId && (
        <div style={S.modalOverlay} onClick={() => setFichaId(null)}>
          <div style={S.modalBox} onClick={(e) => e.stopPropagation()}>
            <div style={S.modalTopo}>
              <span style={S.modalTitulo}>Ficha do aluno</span>
              <button style={S.modalFechar} onClick={() => setFichaId(null)}>Fechar ✕</button>
            </div>
            <div style={S.modalConteudo}>
              <Aluno fichaEmbedId={fichaId} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const S = {
  wrap: { padding: "28px 30px 40px", fontFamily: "'Inter', system-ui, sans-serif", color: "#0f172a", background: "#f4f6fa", minHeight: "100%" },
  topo: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap", marginBottom: 14 },
  titulo: { margin: 0, fontFamily: "'Sora', Inter, sans-serif", fontSize: 24, fontWeight: 800, color: "#0d1321", letterSpacing: "-0.03em" },
  sub: { margin: "5px 0 0", color: "#64748b", fontSize: 13 },
  btnGhost: { background: "#1e40af", color: "#fff", border: "none", borderRadius: 10, padding: "10px 18px", fontWeight: 700, fontSize: 13, cursor: "pointer" },
  barra: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 14 },
  select: { border: "1px solid #cbd5e1", borderRadius: 10, padding: "8px 12px", fontSize: 13, background: "#fff", color: "#0f172a" },
  input: { border: "1px solid #cbd5e1", borderRadius: 10, padding: "8px 12px", fontSize: 13, background: "#fff", color: "#0f172a", minWidth: 240, outline: "none" },
  contador: { fontSize: 12.5, color: "#64748b", fontWeight: 700, marginLeft: "auto" },
  muted: { color: "#64748b", fontSize: 14 },
  tabela: { width: "100%", borderCollapse: "collapse", fontSize: 13, background: "#fff", borderRadius: 12, overflow: "hidden", border: "1px solid #e6eaf0" },
  th: { textAlign: "left", padding: "10px 12px", color: "#8a93a3", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", background: "#f8fafc", borderBottom: "1px solid #e3e7ee" },
  thNum: { textAlign: "right", padding: "10px 12px", color: "#8a93a3", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", background: "#f8fafc", borderBottom: "1px solid #e3e7ee" },
  td: { padding: "10px 12px", borderBottom: "1px solid #f2f4f7", color: "#344054" },
  tdMuted: { padding: "10px 12px", borderBottom: "1px solid #f2f4f7", color: "#8a93a3", fontSize: 12.5 },
  tdNum: { padding: "10px 12px", borderBottom: "1px solid #f2f4f7", textAlign: "right", fontWeight: 700, color: "#101828" },
  chip: { fontSize: 11, fontWeight: 700, borderRadius: 999, padding: "2px 10px" },
  chipPend: { background: "#fffbeb", color: "#92400e", border: "1px solid #fde68a" },
  chipOk: { background: "#f0fdf4", color: "#166534", border: "1px solid #86efac" },
  btnConf: { background: "#15803d", color: "#fff", border: "none", borderRadius: 8, padding: "6px 14px", fontSize: 12.5, fontWeight: 700, cursor: "pointer" },
  btnMini: { background: "transparent", color: "#2563eb", border: "none", fontSize: 12, fontWeight: 700, cursor: "pointer" },
  btnFicha: { background: "#eef2ff", color: "#3730a3", border: "1px solid #c7d2fe", borderRadius: 8, padding: "6px 12px", fontSize: 12.5, fontWeight: 700, cursor: "pointer" },
  modalOverlay: { position: "fixed", inset: 0, background: "rgba(15,23,42,0.55)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "3vh 2vw", zIndex: 1000 },
  modalBox: { background: "#fff", borderRadius: 16, width: "min(1100px, 96vw)", maxHeight: "94vh", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 20px 60px rgba(0,0,0,0.35)" },
  modalTopo: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderBottom: "1px solid #e6eaf0", background: "#f8fafc" },
  modalTitulo: { fontFamily: "'Sora', Inter, sans-serif", fontSize: 15, fontWeight: 800, color: "#0d1321" },
  modalFechar: { background: "#0f172a", color: "#fff", border: "none", borderRadius: 8, padding: "7px 14px", fontSize: 12.5, fontWeight: 700, cursor: "pointer" },
  modalConteudo: { overflow: "auto", flex: 1 },
};
