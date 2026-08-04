import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

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

export default function DadosAcademicos({ aluno }) {
  const [dados, setDados] = useState(null);
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

  return (
    <div style={S.caixa}>
      <div style={S.cabecalho}><strong>🎓 Dados Acadêmicos</strong></div>
      <div style={S.grid}>
        <Item rot="Matrícula" val={matricula} />
        <Item rot="Modalidade" val={modalidade} />
        <Item rot="Curso" val={curso} />
        <Item rot="Situação acadêmica" val={situacao} />
        <Item rot="Estabelecimento" val={estab} />
        <Item rot="Competência" val={comp} />
        <Item rot="Fonte" val={fonte} />
      </div>
    </div>
  );
}

const S = {
  caixa: { padding: "12px 16px", marginBottom: 14, borderRadius: 10, background: "rgba(139,92,246,0.07)", border: "1px solid rgba(139,92,246,0.28)" },
  cabecalho: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8 },
  item: { display: "flex", flexDirection: "column", gap: 2 },
  rot: { fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.04em", opacity: 0.6, fontWeight: 700 },
  val: { fontSize: 13, fontWeight: 600 },
};
