import { useState } from "react";
import { createRoot } from "react-dom/client";
import SituacaoAcademicaPrime from "/src/components/SituacaoAcademicaPrime.jsx";
import { CASOS } from "./dados-academico.js";
import { cenario } from "./mock-supabase-academico.js";

// Preview da seção "Situação acadêmica consultada no Prime".
// O componente é o REAL; só a camada de serviço é dublada.

const s = {
  pagina: { fontFamily: "system-ui, -apple-system, sans-serif", background: "var(--rv-fundo)", minHeight: "100vh" },
  barra: { position: "sticky", top: 0, zIndex: 50, display: "flex", gap: 10, alignItems: "center",
           background: "#0f172a", color: "#fff", padding: "8px 16px", fontSize: 13 },
  corpo: { maxWidth: 940, margin: "0 auto", padding: "22px 16px 60px" },
  h1: { fontSize: 20, margin: "0 0 4px", color: "var(--rv-tinta)" },
  intro: { fontSize: 13.5, color: "var(--rv-texto)", margin: "0 0 22px" },
  caso: { marginBottom: 26, paddingBottom: 20, borderBottom: "1px solid var(--rv-borda)" },
  h2: { fontSize: 15, margin: "0 0 3px", color: "var(--rv-tinta)" },
  meta: { fontSize: 12, color: "var(--rv-texto)", margin: "0 0 6px", fontVariantNumeric: "tabular-nums" },
  nota: { fontSize: 12.5, color: "var(--rv-texto)", margin: "0 0 4px", maxWidth: 780 },
};

// Exportados para satisfazer react-refresh/only-export-components -- a regra
// reclama de arquivo que tem componente e nenhum export. Nao muda nada do que
// roda; evita empurrar a catraca de lint para cima.
export function Caso({ c }) {
  return (
    <section style={s.caso}>
      <h2 style={s.h2}>{c.rotulo}</h2>
      <p style={s.meta}>
        {c.alunoId.replace("aluno-", "matrícula ")}
        {c.situacaoNoCrm ? ` · situação no CRM hoje: ${c.situacaoNoCrm}` : " · sem situação no CRM"}
      </p>
      <p style={s.nota}>{c.nota}</p>
      {/* É aqui que o código do PR roda. */}
      <SituacaoAcademicaPrime aluno={{ id: c.alunoId }} />
    </section>
  );
}

// A barra troca o papel. Sem poder ver como OPERADOR, o cuidado mais
// importante da revisao -- ele nao dispara consulta -- fica invisivel.
export function Pagina() {
  const [gestao, setGestao] = useState(cenario.gestao);
  const [chave, setChave] = useState(0);
  function trocar(v) { cenario.gestao = v; setGestao(v); setChave((k) => k + 1); }
  const botao = (ligado) => ({
    padding: "4px 12px", borderRadius: 999, border: 0, cursor: "pointer",
    background: ligado ? "#22c55e" : "#334155", color: "#fff", fontWeight: 600, fontSize: 12,
  });
  return (
    <div style={s.pagina}>
      <div style={s.barra}>
        <strong>PREVIEW</strong>
        <span style={{ color: "#94a3b8" }}>
          componente real · matrículas fictícias · nada é gravado
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ color: "#94a3b8" }}>ver como:</span>
        <button onClick={() => trocar(false)} style={botao(!gestao)}>Operador</button>
        <button onClick={() => trocar(true)} style={botao(gestao)}>Gestão</button>
      </div>
      <div style={s.corpo} key={chave}>
      <h1 style={s.h1}>Situação acadêmica consultada no Prime</h1>
      <p style={s.intro}>
        Nove casos com a estrutura observada na consulta de 28/09/2026 — os seis
        padrões encontrados nos alunos consultados, mais os três desfechos que a
        tela precisa distinguir. <b>Matrículas fictícias</b>: nenhum dado real
        de aluno aparece aqui.
      </p>
      {CASOS.map((c) => <Caso key={c.alunoId} c={c} />)}
      </div>
    </div>
  );
}

createRoot(document.getElementById("raiz")).render(<Pagina />);
