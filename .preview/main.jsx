import { useState } from "react";
import { createRoot } from "react-dom/client";
import CentralWhatsApp from "/src/pages/CentralWhatsApp.jsx";
import { cenario } from "./mock-whatsapp.js";

function Barra() {
  const [gestao, setGestao] = useState(cenario.gestao);
  const [chave, setChave] = useState(0);
  function trocar(v) { cenario.gestao = v; setGestao(v); setChave((k) => k + 1); }
  return (
    <>
      <div style={{
        position: "sticky", top: 0, zIndex: 50, display: "flex", gap: 10, alignItems: "center",
        background: "#0f172a", color: "#fff", padding: "8px 16px", fontSize: 13,
        fontFamily: "system-ui, sans-serif",
      }}>
        <strong>PREVIEW</strong>
        <span style={{ color: "#94a3b8" }}>dados de exemplo · sem banco · sem WhatsApp pareado</span>
        <span style={{ flex: 1 }} />
        <span style={{ color: "#94a3b8" }}>ver como:</span>
        <button onClick={() => trocar(false)}
          style={{ padding: "4px 12px", borderRadius: 999, border: 0, cursor: "pointer",
                   background: gestao ? "#334155" : "#22c55e", color: "#fff", fontWeight: 600 }}>
          Operador
        </button>
        <button onClick={() => trocar(true)}
          style={{ padding: "4px 12px", borderRadius: 999, border: 0, cursor: "pointer",
                   background: gestao ? "#22c55e" : "#334155", color: "#fff", fontWeight: 600 }}>
          Gestão
        </button>
      </div>
      <CentralWhatsApp key={chave} />
    </>
  );
}

createRoot(document.getElementById("root")).render(<Barra />);
