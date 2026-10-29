/* eslint-disable react-refresh/only-export-components -- harness de preview:
   não há Fast Refresh a preservar aqui, é um arquivo de entrada. */
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import CarteiraEfetividade from "/src/pages/CarteiraEfetividade.jsx";
import { usandoDadoReal } from "./mock-supabase-efetividade.js";

// A tela real abre em 2026/1, e é assim que ela deve abrir em produção. Esta
// entrega mexeu só em 2026/2, então o preview clica no "2º semestre" depois de
// montar — é código DO HARNESS, não da tela: nada aqui altera o padrão do CRM.
function AbrirNoSegundoSemestre() {
  useEffect(() => {
    // A tela mostra "Carregando" antes dos botões existirem, então uma só
    // tentativa não acha nada. Tenta por até 3s e desiste em silêncio.
    const fim = Date.now() + 3000;
    const t = setInterval(() => {
      // Dois cliques, em ordem: o seletor de Visão só existe depois que o
      // semestre é 2026/2.
      const clicar = (rotulo) => {
        const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === rotulo);
        if (b && b.getAttribute("aria-pressed") !== "true") b.click();
        return Boolean(b);
      };
      clicar("2º semestre");
      if (clicar("Resumo por vencimento")) clearInterval(t);
      else if (Date.now() > fim) clearInterval(t);
    }, 100);
    return () => clearInterval(t);
  }, []);
  return null;
}

createRoot(document.getElementById("raiz")).render(
  <>
    <AbrirNoSegundoSemestre />
    <div style={{
      position: "sticky", top: 0, zIndex: 50, display: "flex", gap: 10, alignItems: "center",
      background: "#0f172a", color: "#fff", padding: "8px 16px", fontSize: 13,
      fontFamily: "system-ui, sans-serif", flexWrap: "wrap",
    }}>
      <strong>PREVIEW</strong>
      <span style={{ color: "#94a3b8" }}>
        {usandoDadoReal
          ? "Resumo por vencimento com números reais (dados-efetividade.local.js, fora do Git); o resto da tela é sintético"
          : "fixture sintética · números inventados · nenhum dado de produção"}{" "}
        · sem login · nada foi publicado
      </span>
      <span style={{ flex: 1 }} />
      <span style={{ color: "#94a3b8" }}>abre em 2026 · Resumo por vencimento</span>
    </div>
    <CarteiraEfetividade />
  </>
);
