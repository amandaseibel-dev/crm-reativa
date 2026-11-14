import { useState } from "react";
import RelatorioMensalidadesSemNegociacao from "../components/relatorios/RelatorioMensalidadesSemNegociacao";
import { CONFIG_2026_1, CONFIG_2026_2 } from "../components/relatorios/configSemestres";
import CarteiraEfetividade from "./CarteiraEfetividade";

const SEMESTRES = [
  ["2026/1", "2026/1 — 1º semestre", CONFIG_2026_1],
  ["2026/2", "2026/2 — semestre vigente", CONFIG_2026_2],
];

const estiloBotao = (ativo) => ({
  padding: "6px 12px", borderRadius: 8, cursor: "pointer", fontWeight: 600,
  border: "1px solid var(--rv-borda, #d0d7e2)",
  background: ativo ? "var(--rv-azul)" : "transparent",
  color: ativo ? "#fff" : "var(--rv-texto, inherit)",
});

export default function MensalidadesSemNegociacao() {
  const [semestre, setSemestre] = useState("2026/1");
  const [vista, setVista] = useState("mensalidades");
  const config = SEMESTRES.find(([k]) => k === semestre)[2];
  const emEfetividade = semestre === "2026/2" && vista === "efetividade";

  return (
    <div>
      <div role="group" aria-label="Semestre do relatório" style={{ display: "flex", gap: 8, padding: "16px 24px 0", maxWidth: 1040, margin: "0 auto" }}>
        {SEMESTRES.map(([k, r]) => (
          <button key={k} type="button" aria-pressed={semestre === k} style={estiloBotao(semestre === k)}
                  onClick={() => { setSemestre(k); setVista("mensalidades"); }}>{r}</button>
        ))}
      </div>
      {semestre === "2026/2" && (
        <div role="group" aria-label="Tipo de relatório 2026/2" style={{ display: "flex", gap: 8, padding: "12px 24px 0", maxWidth: 1040, margin: "0 auto" }}>
          <button type="button" aria-pressed={vista === "mensalidades"} style={estiloBotao(vista === "mensalidades")}
                  onClick={() => setVista("mensalidades")}>Mensalidades sem negociação</button>
          <button type="button" aria-pressed={vista === "efetividade"} style={estiloBotao(vista === "efetividade")}
                  onClick={() => setVista("efetividade")}>Efetividade 2026/2</button>
        </div>
      )}
      {emEfetividade
        ? <CarteiraEfetividade safraFixa="2026/2" />
        : <RelatorioMensalidadesSemNegociacao key={config.semestre} config={config} />}
    </div>
  );
}
