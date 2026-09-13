import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import Dobra from "../ui/blocos";

// Bloco DADOS ACADEMICOS — so leitura, no TOPO da ficha (sempre visivel,
// fora das abas). Busca as colunas academicas por id (resiliente ao select
// do componente pai). Modalidade = alunos.curso; Curso real e Situacao vem do
// Relatorio de Inadimplencia (import em Ferramentas). Nao altera nada.

// Campo sem valor nao vira linha de "—". O bloco ocupava altura inteira
// exibindo trace: com aluno sem dado academico importado eram tres tracos de
// quatro campos, porque `Fonte` nunca e vazio. Quem tem valor continua
// exatamente onde estava -- nada e escondido, so o vazio deixa de ocupar lugar.
function Item({ rot, val }) {
  if (!val) return null;
  return (
    <div style={S.item}>
      <span style={S.rot}>{rot}</span>
      <span style={S.val}>{val}</span>
    </div>
  );
}

// Cor por status do contrato. "Confirmado" = matrícula fechada. "Aberto" =
// iniciada e não confirmada -- é o estado da maioria das matrículas do semestre
// seguinte, e a operação precisa enxergar essa diferença antes de cobrar.
// "Anulado" não conta como matrícula.
const COR_STATUS = {
  Confirmado: { fundo: "rgba(15,118,110,0.12)", cor: "var(--rv-teal-texto)", borda: "rgba(15,118,110,0.35)" },
  Aberto:     { fundo: "rgba(180,83,9,0.12)",   cor: "var(--rv-ambar-texto)", borda: "rgba(180,83,9,0.35)" },
  Anulado:    { fundo: "rgba(100,116,139,0.12)", cor: "var(--rv-texto-suave)", borda: "rgba(100,116,139,0.3)" },
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
  // "Tem dado academico?" tem de olhar TODAS as fontes do bloco, nao so as tres
  // que aparecem no corpo. A linha FECHADA ja mostra curso, situacao, matricula
  // e os chips de semestre: contar so modalidade/estabelecimento/competencia
  // produzia contradicao -- o resumo dizia "Administracao · Matriculado" e o
  // corpo, logo abaixo, "Nenhum dado academico importado".
  //
  // Curso, situacao e matricula continuam SO no resumo: entram nesta conta, mas
  // nao sao repetidos no corpo.
  //
  // `fonte` fica de fora de proposito: ela e derivada, nunca vazia, e sozinha
  // nao e dado academico -- se contasse, a mensagem nunca apareceria.
  const temInfoAcademica = Boolean(
    modalidade || estab || comp || curso || situacao || matricula || matriculas.length
  );

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
      {/* Matricula, Curso e Situacao nao se repetem aqui: os tres ja ficam na
          linha do titulo, que continua visivel com o bloco aberto. Aqui entra
          so o que nao cabia la.

          `Fonte` sempre aparece -- e ela que diz de ONDE veio (ou nao veio) o
          dado, e some-la deixaria o bloco mudo. Quando nao ha nenhum dos outros
          tres, o bloco diz isso com todas as letras em vez de mostrar tracos. */}
      {temInfoAcademica ? (
        <div style={S.grid}>
          <Item rot="Modalidade" val={modalidade} />
          <Item rot="Estabelecimento" val={estab} />
          <Item rot="Competência" val={comp} />
          <Item rot="Fonte" val={fonte} />
        </div>
      ) : (
        <div style={S.semDado}>
          <span style={S.semDadoTexto}>Nenhum dado acadêmico importado</span>
          <div style={S.item}>
            <span style={S.rot}>Fonte</span>
            <span style={S.val}>{fonte}</span>
          </div>
        </div>
      )}
    </Dobra>
  );
}

const S = {
  caixa: { marginBottom: 10, background: "rgba(139,92,246,0.07)", border: "1px solid rgba(139,92,246,0.28)" },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8 },
  item: { display: "flex", flexDirection: "column", gap: 2 },
  // A hierarquia do rotulo vem de TAMANHO, CAIXA e PESO -- nao de opacidade.
  // `opacity: 0.6` sobre o fundo lilas dava ~2,5:1, abaixo do minimo legivel.
  rot: { fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 700, color: "var(--rv-texto)" },
  val: { fontSize: 13, fontWeight: 600, color: "var(--rv-tinta)" },
  semDado: { display: "flex", flexDirection: "column", gap: 8 },
  semDadoTexto: { fontSize: 12.5, color: "var(--rv-texto)" },
  chips: { display: "inline-flex", gap: 6, flexWrap: "wrap" },
  chip: { fontSize: 11.5, fontWeight: 700, borderRadius: 999, padding: "2px 9px", border: "1px solid" },
};
