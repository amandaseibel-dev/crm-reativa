/* eslint-disable react-refresh/only-export-components */
// Preview isolado da seção "Mensalidades negociadas neste acordo" do Aluno.jsx.
// Demonstra o layout responsivo: grid 5 colunas em desktop, 2 colunas rotuladas
// em telas ≤ 540px. Sem banco, sem login, sem rodadas extras.
import { createRoot } from "react-dom/client";
import Dobra from "/src/ui/blocos";

const moeda = (v) =>
  Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

const dataCurta = (s) => {
  if (!s) return "—";
  const [a, m, d] = s.split("-");
  return `${d}/${m}/${a}`;
};

// ── estilos (cópia fiel do Aluno.jsx após o ajuste) ──────────────────────────

const tabNegGrade = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 0.8fr) minmax(0, 0.9fr) minmax(0, 0.9fr) minmax(0, 1fr)",
  gap: 8,
  fontSize: 12.5,
  alignItems: "center",
};
const tabNegCelula = { overflowWrap: "break-word", minWidth: 0 };
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

// ── dados fictícios ───────────────────────────────────────────────────────────

const TITULOS = [
  { id: 1, documento: "MEN/2026/0001", competencia: "01/2026", vencimento: "2026-01-10", situacao: "LIQUIDADO", valor: 892.4 },
  { id: 2, documento: "MEN/2026/0002", competencia: "02/2026", vencimento: "2026-02-10", situacao: "LIQUIDADO", valor: 892.4 },
  { id: 3, documento: "MEN/2026/0003", competencia: "03/2026", vencimento: "2026-03-10", situacao: "EM CONFIRMAÇÃO DE PAGAMENTO", valor: 1234.56 },
];

const somaTitulos = (ts) => ts.reduce((s, t) => s + (t.valor || 0), 0);

// ── componente ────────────────────────────────────────────────────────────────

function SecaoMensalidades() {
  return (
    <div style={{ padding: 24, maxWidth: 900, margin: "0 auto", fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 18, fontWeight: 800, marginBottom: 4, color: "var(--rv-tinta)" }}>
        Preview — Mensalidades negociadas neste acordo
      </h1>
      <p style={{ fontSize: 13, color: "var(--rv-texto-suave)", marginBottom: 24 }}>
        Estreite a janela até ≤ 540 px para ver a reorganização responsiva.
        Em telas largas: 5 colunas side-by-side. Em estreitas: 2 colunas com rótulos.
      </p>

      <Dobra
        titulo="Mensalidades negociadas neste acordo"
        contador={TITULOS.length}
        resumo={`${moeda(somaTitulos(TITULOS))} — representadas pelas parcelas; não somam ao total em aberto`}
      >
        <style>{`
          @media (max-width: 540px) {
            .tn-cab { display: none !important; }
            .tn-lin {
              display: grid !important;
              grid-template-columns: 1fr 1fr !important;
              gap: 6px 8px !important;
              padding: 8px 0 !important;
            }
            .tn-cel::before {
              content: attr(data-rotulo);
              display: block;
              font-size: 10px;
              font-weight: 700;
              color: var(--rv-texto-suave, #6b7280);
              text-transform: uppercase;
              letter-spacing: 0.04em;
              margin-bottom: 1px;
            }
            .tn-val {
              grid-column: 1 / -1;
              text-align: right !important;
            }
          }
        `}</style>

        <div className="tn-cab" style={tabNegHead}>
          <span style={tabNegCelula}>Documento</span>
          <span style={tabNegCelula}>Competência</span>
          <span style={tabNegCelula}>Vencimento</span>
          <span style={tabNegCelula}>Situação</span>
          <span style={{ textAlign: "right" }}>Valor</span>
        </div>

        {TITULOS.map((t) => (
          <div key={t.id} className="tn-lin" style={tabNegLinha}>
            <span className="tn-cel" data-rotulo="Documento" style={tabNegCelula}>{t.documento || "—"}</span>
            <span className="tn-cel" data-rotulo="Competência" style={tabNegCelula}>{t.competencia || "—"}</span>
            <span className="tn-cel" data-rotulo="Vencimento" style={tabNegCelula}>{dataCurta(t.vencimento)}</span>
            <span className="tn-cel" data-rotulo="Situação" style={tabNegCelula}>{t.situacao || "—"}</span>
            <span className="tn-cel tn-val" data-rotulo="Valor" style={{ textAlign: "right", fontWeight: 600 }}>
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
