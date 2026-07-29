import { useEffect, useState, useCallback } from "react";
import { supabase } from "../../services/supabase";

function moeda(v) {
  const n = Number(v);
  return Number.isNaN(n) ? "R$ 0,00" : n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
function dataBR(iso) {
  if (!iso) return "-";
  const [a, m, d] = String(iso).slice(0, 10).split("-");
  return `${d}/${m}/${a}`;
}
const PAG = 25;

// Conferência dos pagamentos que compõem um dia do gráfico. Lê EXCLUSIVAMENTE
// a RPC paginada projecao_snapshot_pagamentos_ler (snapshot; nunca public.pagamentos).
// Compara a soma do dia com o valor esperado (ponto do gráfico) -> confere/diverge.
export default function ModalConferenciaDia({ mes, dia, operadorEmail, esperado, onClose }) {
  const [itens, setItens] = useState([]);
  const [total, setTotal] = useState(0);
  const [somaPago, setSomaPago] = useState(0);
  const [somaHon, setSomaHon] = useState(0);
  const [offset, setOffset] = useState(0);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState("");

  const carregar = useCallback(async (off) => {
    setCarregando(true);
    setErro("");
    const { data, error } = await supabase.rpc("projecao_snapshot_pagamentos_ler", {
      p_mes: mes, p_dia: dia, p_operador_email: operadorEmail, p_limit: PAG, p_offset: off,
    });
    setCarregando(false);
    if (error) { setErro(error.message); return; }
    setItens(data?.itens || []);
    setTotal(Number(data?.total || 0));
    setSomaPago(Number(data?.soma_pago || 0));
    setSomaHon(Number(data?.soma_honorario || 0));
    setOffset(off);
  }, [mes, dia, operadorEmail]);

  useEffect(() => { carregar(0); }, [carregar]);

  const esperadoRec = Number(esperado?.recuperado ?? 0);
  const esperadoHon = Number(esperado?.honorario ?? 0);
  // tolerância de centavos p/ arredondamento
  const confere = Math.abs(somaPago - esperadoRec) < 0.05 && Math.abs(somaHon - esperadoHon) < 0.05;
  const paginaAtual = Math.floor(offset / PAG) + 1;
  const totalPaginas = Math.max(1, Math.ceil(total / PAG));

  const pagPago = itens.reduce((s, p) => s + Number(p.valor_pago || 0), 0);
  const pagHon = itens.reduce((s, p) => s + Number(p.valor_honorario || 0), 0);

  return (
    <div style={estilos.overlay} onClick={onClose}>
      <div style={estilos.modal} onClick={(e) => e.stopPropagation()}>
        <div style={estilos.topo}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 800, color: "#0d1321" }}>
              💳 Conferência de {dataBR(dia)}
            </div>
            <div style={{ fontSize: 12.5, color: "#64748b" }}>
              Operador: <strong>{operadorEmail}</strong> · {total} pagamento(s)
            </div>
          </div>
          <button onClick={onClose} style={estilos.fechar}>✕</button>
        </div>

        <div style={{ ...estilos.conferencia, ...(confere ? estilos.conferOk : estilos.conferDiverge) }}>
          {confere ? "✅ Valores conferem" : "⚠️ Divergência"} — soma do dia:{" "}
          <strong>{moeda(somaPago)}</strong> recuperado / <strong>{moeda(somaHon)}</strong> honorário
          {" · "}gráfico: {moeda(esperadoRec)} / {moeda(esperadoHon)}
        </div>

        {erro && <p style={{ color: "#dc2626" }}>{erro}</p>}

        <div style={{ overflowX: "auto", maxHeight: "48vh" }}>
          <table style={estilos.tabela}>
            <thead>
              <tr>
                <th style={estilos.th}>Aluno</th>
                <th style={estilos.th}>Pagamento (id)</th>
                <th style={estilos.th}>Origem/import.</th>
                <th style={estilos.th}>Ajuste op.</th>
                <th style={{ ...estilos.th, textAlign: "right" }}>Recuperado</th>
                <th style={{ ...estilos.th, textAlign: "right" }}>Honorário</th>
              </tr>
            </thead>
            <tbody>
              {carregando ? (
                <tr><td style={estilos.td} colSpan={6}>Carregando…</td></tr>
              ) : itens.length === 0 ? (
                <tr><td style={estilos.td} colSpan={6}>Nenhum pagamento neste dia.</td></tr>
              ) : itens.map((p) => (
                <tr key={p.pagamento_id}>
                  <td style={estilos.td}>{p.aluno_nome || "-"}</td>
                  <td style={{ ...estilos.td, fontFamily: "monospace", fontSize: 11 }}>{String(p.pagamento_id).slice(0, 8)}…</td>
                  <td style={estilos.td}>{p.importacao_id ? `imp ${String(p.importacao_id).slice(0, 8)}…` : "manual/direto"}</td>
                  <td style={estilos.td}>{p.operador_ajustado_manualmente ? "🔁 sim" : "—"}</td>
                  <td style={{ ...estilos.td, textAlign: "right" }}>{moeda(p.valor_pago)}</td>
                  <td style={{ ...estilos.td, textAlign: "right" }}>{moeda(p.valor_honorario)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td style={estilos.tf} colSpan={4}>Totais da página ({itens.length})</td>
                <td style={{ ...estilos.tf, textAlign: "right" }}>{moeda(pagPago)}</td>
                <td style={{ ...estilos.tf, textAlign: "right" }}>{moeda(pagHon)}</td>
              </tr>
              <tr>
                <td style={{ ...estilos.tf, fontWeight: 800 }} colSpan={4}>Totais do dia ({total})</td>
                <td style={{ ...estilos.tf, textAlign: "right", fontWeight: 800 }}>{moeda(somaPago)}</td>
                <td style={{ ...estilos.tf, textAlign: "right", fontWeight: 800 }}>{moeda(somaHon)}</td>
              </tr>
            </tfoot>
          </table>
        </div>

        <div style={estilos.paginacao}>
          <button style={estilos.btnPag} disabled={offset === 0 || carregando} onClick={() => carregar(Math.max(0, offset - PAG))}>← Anterior</button>
          <span style={{ fontSize: 12.5, color: "#64748b" }}>Página {paginaAtual} de {totalPaginas}</span>
          <button style={estilos.btnPag} disabled={paginaAtual >= totalPaginas || carregando} onClick={() => carregar(offset + PAG)}>Próxima →</button>
        </div>
      </div>
    </div>
  );
}

const estilos = {
  overlay: { position: "fixed", inset: 0, background: "rgba(15,23,42,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16 },
  modal: { background: "#fff", borderRadius: 16, padding: 20, width: "min(860px, 96vw)", maxHeight: "90vh", display: "flex", flexDirection: "column", gap: 12, boxShadow: "0 20px 60px rgba(15,23,42,0.35)" },
  topo: { display: "flex", justifyContent: "space-between", alignItems: "flex-start" },
  fechar: { background: "transparent", border: "none", fontSize: 18, cursor: "pointer", color: "#64748b" },
  conferencia: { padding: "9px 13px", borderRadius: 10, fontSize: 13, fontWeight: 600 },
  conferOk: { background: "#e9f9f1", color: "#0f7a4f", border: "1px solid #bdeed4" },
  conferDiverge: { background: "#fff7e6", color: "#b45309", border: "1px solid #fde3b3" },
  tabela: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", padding: "9px 10px", color: "#8a93a3", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", background: "#f8fafc", borderBottom: "1px solid #e3e7ee", position: "sticky", top: 0 },
  td: { padding: "9px 10px", borderBottom: "1px solid #edf0f5", color: "#475569" },
  tf: { padding: "9px 10px", borderTop: "2px solid #e3e7ee", color: "#0d1321", fontWeight: 700 },
  paginacao: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 },
  btnPag: { padding: "7px 14px", borderRadius: 8, border: "1px solid #e3e7ee", background: "#fff", color: "#475569", cursor: "pointer", fontSize: 12.5, fontWeight: 700 },
};
