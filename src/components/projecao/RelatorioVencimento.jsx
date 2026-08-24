import { useState } from "react";
import { supabase } from "../../services/supabase";
import { exportarPagamentosPorVencimento } from "../../utils/relatoriosProjecaoExcel";
import { exportarPagamentosVencimentoPdf } from "../../utils/relatorioVencimentoPdf";

// Bloco "Pagamentos por Vencimento" dentro da Central de Relatórios.
// Gestão escolhe os operadores (todos ou alguns, incluindo "Sem operador")
// e uma faixa de vencimento (vazio = todos) e baixa o Excel.
// A lista de operadores vem do próprio mês (RPC), então cobre também nomes
// que vieram na planilha sem e-mail mapeado.
export default function RelatorioVencimento({ mes }) {
  const [expandido, setExpandido] = useState(false);
  const [operadores, setOperadores] = useState(null); // [{operador_email, operador_nome, qtd}]
  const [selecionados, setSelecionados] = useState(new Set());
  const [vencDe, setVencDe] = useState("");
  const [vencAte, setVencAte] = useState("");
  const [incluirSemVenc, setIncluirSemVenc] = useState(true);
  const [ocupado, setOcupado] = useState(""); // "" | "excel" | "pdf"
  const [erro, setErro] = useState("");

  async function abrir() {
    setExpandido((v) => !v);
    if (operadores || expandido) return;
    try {
      const { data, error } = await supabase.rpc("projecao_relatorio_pagamentos_vencimento", {
        p_mes: mes, p_limit: 1, p_offset: 0,
      });
      if (error) throw error;
      const lista = data?.operadores_disponiveis || [];
      setOperadores(lista);
      setSelecionados(new Set(lista.map((o) => o.operador_email))); // padrão: todos
    } catch (e) {
      setErro(e?.message || "Falha ao carregar os operadores do mês.");
      setOperadores([]);
    }
  }

  function alternar(email) {
    setSelecionados((atual) => {
      const novo = new Set(atual);
      if (novo.has(email)) novo.delete(email);
      else novo.add(email);
      return novo;
    });
  }

  const todosMarcados = operadores && selecionados.size === operadores.length;

  async function gerar(formato) {
    setErro("");
    if (!selecionados.size) { setErro("Selecione ao menos um operador."); return; }
    setOcupado(formato);
    const filtros = {
      // todos marcados = sem filtro (pega inclusive operador novo que entrar depois)
      operadores: todosMarcados ? null : Array.from(selecionados),
      vencDe: vencDe || null,
      vencAte: vencAte || null,
      incluirSemVencimento: incluirSemVenc,
    };
    try {
      if (formato === "pdf") await exportarPagamentosVencimentoPdf(mes, filtros);
      else await exportarPagamentosPorVencimento(mes, filtros);
    } catch (e) {
      setErro(e?.message || "Falha ao gerar o relatório.");
    } finally {
      setOcupado("");
    }
  }

  return (
    <div style={estilos.bloco}>
      <button onClick={abrir} style={estilos.cabecalho}>
        🗓️ Pagamentos por Operador e Vencimento {expandido ? "▴" : "▾"}
      </button>
      {expandido && (
        <div style={estilos.corpo}>
          <div style={estilos.rotulo}>Operadores</div>
          {!operadores && <div style={estilos.aviso}>Carregando…</div>}
          {operadores && (
            <>
              <label style={estilos.check}>
                <input
                  type="checkbox"
                  checked={!!todosMarcados}
                  onChange={() =>
                    setSelecionados(todosMarcados ? new Set() : new Set(operadores.map((o) => o.operador_email)))
                  }
                />
                <b>Todos ({operadores.length})</b>
              </label>
              <div style={estilos.listaOps}>
                {operadores.map((o) => (
                  <label key={o.operador_email} style={estilos.check}>
                    <input
                      type="checkbox"
                      checked={selecionados.has(o.operador_email)}
                      onChange={() => alternar(o.operador_email)}
                    />
                    {o.operador_nome || o.operador_email} <span style={estilos.qtd}>({o.qtd})</span>
                  </label>
                ))}
              </div>
            </>
          )}

          <div style={estilos.rotulo}>Vencimento (vazio = todos)</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input type="date" value={vencDe} onChange={(e) => setVencDe(e.target.value)} style={estilos.data} />
            <span style={{ fontSize: 12, color: "#64748b" }}>até</span>
            <input type="date" value={vencAte} onChange={(e) => setVencAte(e.target.value)} style={estilos.data} />
          </div>
          <label style={estilos.check}>
            <input type="checkbox" checked={incluirSemVenc} onChange={(e) => setIncluirSemVenc(e.target.checked)} />
            Incluir pagamentos sem vencimento identificado
          </label>

          <div style={{ display: "flex", gap: 8 }}>
            <button disabled={!!ocupado} onClick={() => gerar("excel")} style={{ ...estilos.gerar, flex: 1 }}>
              {ocupado === "excel" ? "Gerando…" : "Gerar Excel"}
            </button>
            <button disabled={!!ocupado} onClick={() => gerar("pdf")} style={{ ...estilos.gerar, flex: 1, background: "#1e40af" }}>
              {ocupado === "pdf" ? "Gerando…" : "Gerar PDF"}
            </button>
          </div>
          {erro && <div style={estilos.erro}>{erro}</div>}
          <div style={estilos.nota}>
            O vencimento passa a ser gravado nas importações novas; para um mês já importado,
            reenvie o arquivo do Prime em "Substituir importação".
          </div>
        </div>
      )}
    </div>
  );
}

const estilos = {
  bloco: { border: "1px solid #edf0f5", borderRadius: 10, background: "#f8fafc", overflow: "hidden" },
  cabecalho: { width: "100%", textAlign: "left", padding: "10px 12px", border: "none", background: "transparent", color: "#0d1321", fontSize: 13, fontWeight: 600, cursor: "pointer" },
  corpo: { padding: "0 12px 12px", display: "flex", flexDirection: "column", gap: 8 },
  rotulo: { fontSize: 12, fontWeight: 700, color: "#475569", marginTop: 4 },
  listaOps: { display: "flex", flexDirection: "column", gap: 4, maxHeight: 160, overflowY: "auto", paddingLeft: 4 },
  check: { display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "#0d1321", cursor: "pointer" },
  qtd: { color: "#94a3b8", fontSize: 11.5 },
  data: { flex: 1, padding: "6px 8px", borderRadius: 8, border: "1px solid #e3e7ee", fontSize: 12.5 },
  gerar: { padding: "8px 12px", borderRadius: 8, border: "none", background: "#0f9d6b", color: "#fff", fontWeight: 700, fontSize: 12.5, cursor: "pointer" },
  aviso: { fontSize: 12, color: "#64748b" },
  erro: { color: "#b91c1c", fontSize: 12.5 },
  nota: { fontSize: 11, color: "#94a3b8" },
};
