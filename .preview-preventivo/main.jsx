import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import Preventivo from "/src/pages/Preventivo.jsx";
import "/src/index.css";

// Preview visual do Preventivo: roda sob um roteador de verdade, na mesma rota
// da produção, para que o `?aba=` e o `?carteira=` se comportem igual.
if (!window.location.pathname.startsWith("/preventivo")) {
  window.history.replaceState({}, "", "/preventivo?aba=carteira");
}

createRoot(document.getElementById("root")).render(
  <>
    <div style={{ background: "#0f172a", color: "#fff", padding: "8px 16px",
                  fontSize: 13, fontFamily: "system-ui, sans-serif" }}>
      <strong>PREVIEW</strong>{" "}
      <span style={{ color: "#94a3b8" }}>dados de exemplo · sem banco · sem login · nada é enviado</span>
    </div>
    <BrowserRouter>
      <Routes>
        <Route path="/preventivo" element={<Preventivo />} />
        <Route path="*" element={<div style={{ padding: 40 }}>fora do Preventivo</div>} />
      </Routes>
    </BrowserRouter>
  </>
);
