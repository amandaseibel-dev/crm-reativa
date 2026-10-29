import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import AcoesMassivas from "/src/pages/AcoesMassivas.jsx";

// Preview visual do painel "Registro das ações massivas". O componente é o
// real; só a camada de dados é dublê (.preview/mock-supabase-massivas.js).
createRoot(document.getElementById("raiz")).render(
  <>
    <div style={{
      position: "sticky", top: 0, zIndex: 50, display: "flex", gap: 10, alignItems: "center",
      background: "#0f172a", color: "#fff", padding: "8px 16px", fontSize: 13,
      fontFamily: "system-ui, sans-serif",
    }}>
      <strong>PREVIEW</strong>
      <span style={{ color: "#94a3b8" }}>dados de exemplo · sem banco · sem login</span>
    </div>
    <BrowserRouter>
      <AcoesMassivas />
    </BrowserRouter>
  </>
);
