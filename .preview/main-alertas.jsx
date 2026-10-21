/* eslint-disable react-refresh/only-export-components -- harness de preview:
   nao ha Fast Refresh a preservar aqui, e um arquivo de entrada. */
import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import AlertasParcelaAcordo from "/src/components/AlertasParcelaAcordo.jsx";

// Revisao visual do card de alerta de parcela, nos volumes REAIS medidos em
// producao em 21/10/2026: um operador (cobranca05) ve 144 alertas -- 1 a vencer
// e 143 vencidas de ate 30 dias. Antes da M2 a base inteira tinha 23.
//
// `limite={null}` reproduz o comportamento ANTERIOR (lista inteira aberta).
// `limite={5}` e o novo. Os dois lados usam o MESMO componente real.
const NOMES = ["Ana Clara Ribeiro","Bruno Henrique Alves","Carla Souza Lima","Diego Martins","Elisa Prado","Felipe Barcellos","Gisele Amaral","Hugo Tavares","Iara Menezes","Joana Beltrao","Kaue Freitas","Larissa Antunes"];
const alerta = (i, dias) => ({
  aluno_id: `a${i}`, aluno_nome: `${NOMES[i % NOMES.length]} ${i}`,
  acordo_id: `c${i}`, numero_acordo: 71000 + i,
  parcela_id: `p${i}`, numero_parcela: (i % 6) + 1,
  valor: 180 + ((i * 137) % 4200) + ((i % 7) * 11.37),
  vencimento: new Date(Date.UTC(2026, 9, 21 + dias)).toISOString().slice(0, 10),
  dias_restantes: dias,
  responsavel_email: "cobranca05@aelbra.com.br",
});
const A_VENCER = [alerta(0, 6)];
const VENCIDAS = Array.from({ length: 143 }, (_, i) => alerta(i + 1, -(1 + (i % 30))));

function Medida({ rotulo, children }) {
  const [h, setH] = useState(null);
  return (
    <div style={{ flex: "1 1 520px", minWidth: 0 }}>
      <div style={{ font: "700 13px system-ui", margin: "0 0 6px", color: "#334155" }}>
        {rotulo} — altura medida: <span data-testid={`altura-${rotulo}`}>{h == null ? "…" : `${h}px`}</span>
      </div>
      <div
        ref={(el) => { if (el && h == null) setH(Math.round(el.getBoundingClientRect().height)); }}
        style={{ border: "2px dashed #94a3b8", borderRadius: 10, padding: 6 }}
      >
        {children}
      </div>
    </div>
  );
}

function App() {
  useEffect(() => { document.title = "Alertas de parcela — antes x depois"; }, []);
  return (
    <div style={{ padding: 20, background: "#f8fafc", minHeight: "100vh", fontFamily: "system-ui" }}>
      <h1 style={{ font: "800 18px system-ui", margin: "0 0 4px" }}>Card de alerta de parcela — ANTES × DEPOIS</h1>
      <p style={{ font: "400 13px system-ui", color: "#475569", margin: "0 0 16px" }}>
        Volumes reais de 21/10/2026: 1 a vencer + 143 vencidas = 144 alertas num operador.
      </p>
      {/* Empilha no celular: lado a lado, cada coluna ficaria com ~142px e a
          medida nao representaria a tela real, onde o card ocupa a largura toda. */}
      <div style={{ display: "flex", gap: 20, alignItems: "flex-start", flexWrap: "wrap" }}>
        <Medida rotulo="antes">
          <AlertasParcelaAcordo
            alertas={[...A_VENCER, ...VENCIDAS]}
            titulo="🔔 Alerta de parcela de acordo ainda aberto"
            onAbrirFicha={() => {}}
          />
        </Medida>
        <Medida rotulo="depois">
          <>
            <AlertasParcelaAcordo alertas={A_VENCER} titulo="🔔 Parcela de acordo a vencer" onAbrirFicha={() => {}} />
            <AlertasParcelaAcordo
              alertas={VENCIDAS}
              titulo="⏰ Parcela de acordo vencida (até 30 dias)"
              limite={5}
              rotuloExpandir="Ver todas as vencidas"
              onAbrirFicha={() => {}}
            />
          </>
        </Medida>
      </div>
    </div>
  );
}
createRoot(document.getElementById("raiz")).render(<App />);
