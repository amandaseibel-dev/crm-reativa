/* eslint-disable react-refresh/only-export-components */
// Preview do estado da MAIN (antes do fix) — sem minmax, sem overflowWrap, sem media query.
// Demonstra o overflow em telas ≤ 360px.
import { createRoot } from "react-dom/client";
import Dobra from "/src/ui/blocos";

const moeda = (v) =>
  Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

const dataCurta = (s) => {
  if (!s) return "—";
  const [a, m, d] = s.split("-");
  return `${d}/${m}/${a}`;
};

// ── estilos da MAIN (cópia fiel do Aluno.jsx no main) ─────────────────────────

const tabNegGrade = {
  display: "grid",
  gridTemplateColumns: "1.4fr 0.8fr 0.9fr 0.9fr 1fr",
  gap: 8,
  fontSize: 12.5,
  alignItems: "center",
};
const tabNegHead = {
  ...tabNegGrade,
  fontWeight: 700,
  color: "var(--rv-texto-suave)",
  padding: "0 0 4px",
  borderBottom: "1px solid var(--rv-borda)",
};
const tabNegLinha = {
  ...tabNegGrade,
  padding: "4px 0",
  borderBottom: "1px solid var(--rv-borda-suave)",
  color: "var(--rv-tinta)",
};
const tabNegRodape = {
  display: "flex",
  justifyContent: "space-between",
  gap: 8,
  paddingTop: 6,
  borderTop: "1px solid var(--rv-borda)",
  fontSize: 12,
  color: "var(--rv-texto-suave)",
};

// ── dados fictícios (mesmos do preview da PR) ─────────────────────────────────

const TITULOS = [
  { id: 1, documento: "MEN/2026/0001", competencia: "01/2026", vencimento: "2026-01-10", situacao: "LIQUIDADO", valor: 892.4 },
  { id: 2, documento: "MEN/2026/0002", competencia: "02/2026", vencimento: "2026-02-10", situacao: "LIQUIDADO", valor: 892.4 },
  { id: 3, documento: "MEN/2026/0003", competencia: "03/2026", vencimento: "2026-03-10", situacao: "EM CONFIRMAÇÃO DE PAGAMENTO", valor: 1234.56 },
];

const somaTitulos = (ts) => ts.reduce((s, t) => s + (t.valor || 0), 0);

function SecaoMensalidades() {
  return (
    <div style={{ padding: 24, maxWidth: 900, margin: "0 auto", fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 18, fontWeight: 800, marginBottom: 4, color: "var(--rv-tinta)" }}>
        MAIN — Mensalidades negociadas (antes do fix)
      </h1>
      <p style={{ fontSize: 13, color: "var(--rv-texto-suave)", marginBottom: 24 }}>
        Grid fixo sem minmax nem overflowWrap. Estreite para ver o comportamento original.
      </p>

      <Dobra
        titulo="Mensalidades negociadas neste acordo"
        contador={TITULOS.length}
        resumo={`${moeda(somaTitulos(TITULOS))} — representadas pelas parcelas; não somam ao total em aberto`}
      >
        <div style={tabNegHead}>
          <span>Documento</span>
          <span>Competência</span>
          <span>Vencimento</span>
          <span>Situação</span>
          <span style={{ textAlign: "right" }}>Valor</span>
        </div>

        {TITULOS.map((t) => (
          <div key={t.id} style={tabNegLinha}>
            <span>{t.documento || "—"}</span>
            <span>{t.competencia || "—"}</span>
            <span>{dataCurta(t.vencimento)}</span>
            <span>{t.situacao || "—"}</span>
            <span style={{ textAlign: "right", fontWeight: 600 }}>
              {moeda(t.valor)}
            </span>
          </div>
        ))}

        <div style={tabNegRodape}>
          <span>{TITULOS.length} mensalidades · vinculadas desde 10/01/2026</span>
          <strong>{moeda(somaTitulos(TITULOS))}</strong>
        </div>
      </Dobra>
    </div>
  );
}

createRoot(document.getElementById("raiz")).render(<SecaoMensalidades />);
