import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import Dobra from "../ui/blocos";

// Bloco DADOS ACADEMICOS — so leitura, no TOPO da ficha (sempre visivel,
// fora das abas). Busca as colunas academicas por id (resiliente ao select
// do componente pai). Modalidade = alunos.curso; Curso real e Situacao vem do
// Relatorio de Inadimplencia (import em Ferramentas). Nao altera nada.

function Item({ rot, val }) {
  return (
    <div style={S.item}>
      <span style={S.rot}>{rot}</span>
      <span style={S.val}>{val || "—"}</span>
    </div>
  );
}

// Cor por status do contrato. "Confirmado" = matrícula fechada. "Aberto" =
// iniciada e não confirmada -- é o estado da maioria das matrículas do semestre
// seguinte, e a operação precisa enxergar essa diferença antes de cobrar.
// "Anulado" não conta como matrícula.
const COR_STATUS = {
  Confirmado: { fundo: "rgba(15,118,110,0.12)", cor: "#0f766e", borda: "rgba(15,118,110,0.35)" },
  Aberto:     { fundo: "rgba(180,83,9,0.12)",   cor: "#b45309", borda: "rgba(180,83,9,0.35)" },
  Anulado:    { fundo: "rgba(100,116,139,0.12)", cor: "#64748b", borda: "rgba(100,116,139,0.3)" },
};

export default function DadosAcademicos({ aluno }) {
  const [dados, setDados] = useState(null);
  const [matriculas, setMatriculas] = useState([]);

  useEffect(() => {
    let vivo = true;
    if (!aluno?.id) { setMatriculas([]); return; }
    supabase
      .rpc("aluno_matricula_semestres", { p_aluno_id: aluno.id })
      .then(({ data }) => { if (vivo) setMatriculas(data || []); })
      .catch(() => {});
    return () => { vivo = false; };
  }, [aluno?.id]);

  useEffect(() => {
    let vivo = true;
    if (!aluno?.id) { setDados(null); return; }
    supabase
      .from("alunos")
      .select("curso, curso_real, situacao_academica, matricula, unidade, academico_fonte, academico_atualizado_em")
      .eq("id", aluno.id)
      .maybeSingle()
      .then(({ data }) => { if (vivo) setDados(data || null); })
      .catch(() => {});
    return () => { vivo = false; };
  }, [aluno?.id]);

  const d = dados || {};
  const modalidade = d.curso || aluno?.curso || null;
  const matricula = d.matricula || aluno?.matricula || null;
  const estab = d.unidade || aluno?.unidade || null;
  const curso = d.curso_real || null;
  const situacao = d.situacao_academica || null;
  const comp = d.academico_atualizado_em
    ? new Date(d.academico_atualizado_em).toLocaleDateString("pt-BR")
    : null;
  const fonte = (curso || situacao) ? "Relatório acadêmico" : "Borderô / base";

  // O bloco ocupava um cartao inteiro com sete campos sempre abertos. Curso e
  // situacao o operador le uma vez; matricula por semestre ele usa para decidir
  // se cobra. Entao o que decide fica na linha fechada, e a referencia abre
  // com um clique.
  const resumo = [curso || modalidade, situacao].filter(Boolean).join(" · ");

  const chips = matriculas.length > 0 ? (
    <span style={S.chips}>
      {matriculas.map((m) => {
        const c = COR_STATUS[m.status] || COR_STATUS.Anulado;
        return (
          <span
            key={`${m.semestre}-${m.valid_from}-${m.status}`}
            style={{ ...S.chip, background: c.fundo, color: c.cor, borderColor: c.borda }}
            title={`${m.curso || ""} · ${m.turno || ""} · ${m.valid_from} a ${m.valid_to || "—"}`}
          >
            {m.semestre} · {m.cancelado ? "Cancelado" : (m.status || "—")}
          </span>
        );
      })}
    </span>
  ) : null;

  return (
    <Dobra
      titulo="🎓 Acadêmico"
      contador={matricula || null}
      extraNoResumo={chips}
      resumo={resumo}
      style={S.caixa}
    >
      <div style={S.grid}>
        <Item rot="Matrícula" val={matricula} />
        <Item rot="Modalidade" val={modalidade} />
        <Item rot="Curso" val={curso} />
        <Item rot="Situação acadêmica" val={situacao} />
        <Item rot="Estabelecimento" val={estab} />
        <Item rot="Competência" val={comp} />
        <Item rot="Fonte" val={fonte} />
      </div>
    </Dobra>
  );
}

const S = {
  caixa: { marginBottom: 10, background: "rgba(139,92,246,0.07)", border: "1px solid rgba(139,92,246,0.28)" },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8 },
  item: { display: "flex", flexDirection: "column", gap: 2 },
  rot: { fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.04em", opacity: 0.6, fontWeight: 700 },
  val: { fontSize: 13, fontWeight: 600 },
  chips: { display: "inline-flex", gap: 6, flexWrap: "wrap" },
  chip: { fontSize: 11.5, fontWeight: 700, borderRadius: 999, padding: "2px 9px", border: "1px solid" },
};
