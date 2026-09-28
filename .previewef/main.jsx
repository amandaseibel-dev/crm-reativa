import { useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import EfetividadeCompetencias from "/src/components/EfetividadeCompetencias.jsx";
import { cenario } from "./mock-supabase.js";

function Barra({ com, trocar }) {
  return (
    <div style={{ position: "sticky", top: 0, zIndex: 50, display: "flex", gap: 10,
                  alignItems: "center", background: "#0f172a", color: "#fff",
                  padding: "8px 16px", fontSize: 13, fontFamily: "system-ui, sans-serif" }}>
      <strong>PRÉVIA</strong>
      <span style={{ color: "#fca5a5" }}>
        totais MEDIDOS em 28/09 · quebra por mês e linhas do detalhe são DEMONSTRAÇÃO · sem banco · sem login
      </span>
      <span style={{ flex: 1 }} />
      <span style={{ color: "#94a3b8" }}>payload:</span>
      <button onClick={() => trocar(false)}
        style={{ padding: "4px 12px", borderRadius: 999, border: 0, cursor: "pointer",
                 background: com ? "#334155" : "#f59e0b", color: "#fff", fontWeight: 600 }}>
        Hoje (sem a migration)
      </button>
      <button onClick={() => trocar(true)}
        style={{ padding: "4px 12px", borderRadius: 999, border: 0, cursor: "pointer",
                 background: com ? "#22c55e" : "#334155", color: "#fff", fontWeight: 600 }}>
        Com a migration aplicada
      </button>
    </div>
  );
}

function App() {
  const [com, setCom] = useState(false);
  const [chave, setChave] = useState(0);
  function trocar(v) { cenario.comTabulacao = v; setCom(v); setChave((k) => k + 1); }
  return (
    <>
      <Barra com={com} trocar={trocar} />
      <BrowserRouter>
        <div style={{ display: "flex", minHeight: "100vh", background: "var(--rv-fundo)" }}>
          {/* A barra lateral do CRM come 280px. Sem ela a grade de cards mede
              errado e a revisao aprova um layout que nao existe na tela real. */}
          <aside style={{ width: 280, flexShrink: 0, background: "var(--rv-superficie)",
                          borderRight: "1px solid var(--rv-borda-suave)", padding: 16,
                          fontFamily: "system-ui, sans-serif", fontSize: 13,
                          color: "var(--rv-texto-suave)" }}>
            barra lateral do CRM (280px)
          </aside>
          <main style={{ flex: 1, minWidth: 0, padding: 16 }}>
            <Routes>
              <Route path="*" element={<EfetividadeCompetencias key={chave} />} />
            </Routes>
          </main>
        </div>
      </BrowserRouter>
    </>
  );
}

createRoot(document.getElementById("raiz")).render(<App />);
