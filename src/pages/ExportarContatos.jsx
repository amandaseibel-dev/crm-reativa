import { useState } from "react";
import { supabase } from "../services/supabase";

const FONTE_TITULO = "'Sora', 'Inter', system-ui, sans-serif";
const VERDE = "#1e40af";

function formatarMoeda(valor) {
  return Number(valor || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function converterValor(texto) {
  const limpo = String(texto || "").replace(/\./g, "").replace(",", ".").trim();
  const numero = Number(limpo);
  return Number.isFinite(numero) ? numero : null;
}

export default function ExportarContatos() {
  const [valorMin, setValorMin] = useState("");
  const [valorMax, setValorMax] = useState("");
  const [quantidade, setQuantidade] = useState("100");
  const [somenteComTelefone, setSomenteComTelefone] = useState(true);
  const [somenteLivres, setSomenteLivres] = useState(false);
  const [carregando, setCarregando] = useState(false);
  const [resultados, setResultados] = useState(null);
  const [erro, setErro] = useState("");

  async function buscar() {
    setErro("");
    const min = valorMin.trim() ? converterValor(valorMin) : null;
    const max = valorMax.trim() ? converterValor(valorMax) : null;
    const qtd = Math.max(1, Math.min(5000, Number(quantidade) || 100));

    if (valorMin.trim() && min === null) {
      setErro("Valor mínimo inválido.");
      return;
    }
    if (valorMax.trim() && max === null) {
      setErro("Valor máximo inválido.");
      return;
    }

    setCarregando(true);
    setResultados(null);

    try {
      let query = supabase
        .from("casos")
        .select("aluno_id, total_em_aberto, operador_nome")
        .not("aluno_id", "is", null)
        .order("total_em_aberto", { ascending: false })
        .limit(qtd);

      if (min !== null) query = query.gte("total_em_aberto", min);
      if (max !== null) query = query.lte("total_em_aberto", max);
      if (somenteLivres) query = query.is("operador_email", null);

      const { data: casos, error: erroCasos } = await query;
      if (erroCasos) throw erroCasos;

      const idsAlunos = [...new Set((casos || []).map((c) => c.aluno_id))];
      if (idsAlunos.length === 0) {
        setResultados([]);
        setCarregando(false);
        return;
      }

      const { data: alunos, error: erroAlunos } = await supabase
        .from("alunos")
        .select("id, nome, telefone, cpf")
        .in("id", idsAlunos);

      if (erroAlunos) throw erroAlunos;

      const alunosPorId = Object.fromEntries((alunos || []).map((a) => [String(a.id), a]));

      let lista = (casos || []).map((c) => {
        const a = alunosPorId[String(c.aluno_id)] || {};
        return {
          nome: a.nome || "-",
          telefone: a.telefone || "",
          cpf: a.cpf || "-",
          valor: Number(c.total_em_aberto || 0),
          operador: c.operador_nome || "Livre",
        };
      });

      if (somenteComTelefone) {
        lista = lista.filter((l) => l.telefone && l.telefone.trim() !== "");
      }

      setResultados(lista);
    } catch (e) {
      console.error("Erro ao buscar contatos:", e);
      setErro("Erro ao buscar: " + (e.message || "tente novamente"));
    } finally {
      setCarregando(false);
    }
  }

  function exportarCSV() {
    if (!resultados || resultados.length === 0) return;

    const linhas = [
      ["Nome", "Telefone", "CPF", "Valor em aberto", "Operador"].join(";"),
      ...resultados.map((r) =>
        [r.nome, r.telefone, r.cpf, r.valor.toFixed(2).replace(".", ","), r.operador]
          .map((v) => `"${String(v).replace(/"/g, '""')}"`)
          .join(";")
      ),
    ];

    const csv = "\uFEFF" + linhas.join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `contatos-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const valorTotal = resultados ? resultados.reduce((s, r) => s + r.valor, 0) : 0;

  return (
    <div style={estilos.container}>
      <div style={estilos.cabecalho}>
        <div>
          <h1 style={estilos.titulo}>📇 Exportar Contatos</h1>
          <p style={estilos.subtitulo}>
            Filtra alunos por faixa de valor em aberto e quantidade, pra ação direcionada (nome + telefone).
          </p>
        </div>
      </div>

      <div style={estilos.card}>
        <div style={estilos.linhaFiltros}>
          <div style={estilos.campo}>
            <label style={estilos.label}>Valor mínimo</label>
            <input
              style={estilos.input}
              placeholder="Ex: 500,00"
              value={valorMin}
              onChange={(e) => setValorMin(e.target.value)}
            />
          </div>
          <div style={estilos.campo}>
            <label style={estilos.label}>Valor máximo</label>
            <input
              style={estilos.input}
              placeholder="Ex: 3000,00"
              value={valorMax}
              onChange={(e) => setValorMax(e.target.value)}
            />
          </div>
          <div style={estilos.campo}>
            <label style={estilos.label}>Quantidade</label>
            <input
              style={estilos.input}
              type="number"
              min="1"
              max="5000"
              value={quantidade}
              onChange={(e) => setQuantidade(e.target.value)}
            />
          </div>
        </div>

        <div style={estilos.linhaCheckbox}>
          <label style={estilos.checkboxLabel}>
            <input
              type="checkbox"
              checked={somenteComTelefone}
              onChange={(e) => setSomenteComTelefone(e.target.checked)}
            />
            Só com telefone cadastrado
          </label>
          <label style={estilos.checkboxLabel}>
            <input
              type="checkbox"
              checked={somenteLivres}
              onChange={(e) => setSomenteLivres(e.target.checked)}
            />
            Só casos livres (sem operador)
          </label>
        </div>

        {erro && <p style={estilos.erro}>{erro}</p>}

        <button style={estilos.botaoBuscar} onClick={buscar} disabled={carregando}>
          {carregando ? "Buscando..." : "Buscar"}
        </button>
      </div>

      {resultados && (
        <div style={estilos.card}>
          <div style={estilos.resumoTopo}>
            <div>
              <strong style={{ fontFamily: FONTE_TITULO, fontSize: 18 }}>{resultados.length}</strong>{" "}
              <span style={{ color: "#8a93a3" }}>contato(s) encontrado(s)</span>
              {resultados.length > 0 && (
                <span style={{ color: "#8a93a3" }}> · Total em aberto: {formatarMoeda(valorTotal)}</span>
              )}
            </div>
            {resultados.length > 0 && (
              <button style={estilos.botaoExportar} onClick={exportarCSV}>
                ⬇️ Exportar CSV
              </button>
            )}
          </div>

          {resultados.length === 0 ? (
            <p style={{ color: "#8a93a3" }}>Nenhum resultado com esses filtros.</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={estilos.tabela}>
                <thead>
                  <tr>
                    <th style={estilos.th}>Nome</th>
                    <th style={estilos.th}>Telefone</th>
                    <th style={estilos.th}>CPF</th>
                    <th style={estilos.thNum}>Valor em aberto</th>
                    <th style={estilos.th}>Operador</th>
                  </tr>
                </thead>
                <tbody>
                  {resultados.map((r, i) => (
                    <tr key={i}>
                      <td style={estilos.td}>{r.nome}</td>
                      <td style={estilos.td}>{r.telefone || "-"}</td>
                      <td style={estilos.td}>{r.cpf}</td>
                      <td style={estilos.tdNum}>{formatarMoeda(r.valor)}</td>
                      <td style={estilos.td}>{r.operador}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const estilos = {
  container: {
    padding: "28px 30px 40px",
    fontFamily: "'Inter', system-ui, sans-serif",
    background: "#f4f6fa",
    minHeight: "100%",
  },
  cabecalho: { marginBottom: 18 },
  titulo: {
    margin: 0,
    color: "#0d1321",
    fontFamily: FONTE_TITULO,
    fontSize: 26,
    fontWeight: 800,
    letterSpacing: "-0.03em",
  },
  subtitulo: { margin: "5px 0 0", color: "#8a93a3", fontSize: 13.5 },
  card: {
    background: "#fff",
    borderRadius: 16,
    padding: "20px 22px",
    boxShadow: "0 1px 2px rgba(16,24,40,0.04), 0 1px 3px rgba(16,24,40,0.05)",
    border: "1px solid #edf0f5",
    marginBottom: 18,
  },
  linhaFiltros: { display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 14 },
  campo: { display: "flex", flexDirection: "column", gap: 5, minWidth: 160 },
  label: { fontSize: 12, fontWeight: 700, color: "#475569" },
  input: {
    padding: "9px 12px",
    borderRadius: 10,
    border: "1px solid #e3e7ee",
    fontSize: 13,
  },
  linhaCheckbox: { display: "flex", gap: 20, flexWrap: "wrap", marginBottom: 14 },
  checkboxLabel: { display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#475569" },
  erro: { color: "#b91c1c", fontSize: 13, marginBottom: 10 },
  botaoBuscar: {
    background: VERDE,
    color: "#fff",
    border: "none",
    borderRadius: 10,
    padding: "10px 20px",
    fontWeight: 700,
    fontSize: 13,
    cursor: "pointer",
  },
  resumoTopo: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 10,
    marginBottom: 14,
  },
  botaoExportar: {
    background: "#eef6ff",
    color: "#1d4ed8",
    border: "1px solid #cfe6ff",
    borderRadius: 10,
    padding: "9px 16px",
    fontWeight: 700,
    fontSize: 13,
    cursor: "pointer",
  },
  tabela: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: {
    textAlign: "left",
    padding: "10px 12px",
    color: "#8a93a3",
    fontSize: 10.5,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    background: "#f8fafc",
    borderBottom: "1px solid #e3e7ee",
  },
  thNum: {
    textAlign: "right",
    padding: "10px 12px",
    color: "#8a93a3",
    fontSize: 10.5,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    background: "#f8fafc",
    borderBottom: "1px solid #e3e7ee",
  },
  td: { padding: "10px 12px", borderBottom: "1px solid #f2f4f7", color: "#344054" },
  tdNum: { padding: "10px 12px", borderBottom: "1px solid #f2f4f7", textAlign: "right", fontWeight: 700, color: "#101828" },
};
