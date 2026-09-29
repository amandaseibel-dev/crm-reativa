import { useCallback, useEffect, useState } from "react";
import { supabase } from "../services/supabase";

// SITUAÇÃO ACADÊMICA CONSULTADA NO PRIME
// ============================================================================
//
// Mostra TODAS as linhas que a API devolveu, uma por vínculo de curso.
//
// POR QUE NÃO EXISTE AQUI UM CAMPO "SITUAÇÃO DO ALUNO". A API devolve a situação
// por vínculo de curso, e os vínculos de uma mesma pessoa discordam entre si
// (sondado em 28/09/2026, 6 alunos, 35 vínculos). Não foi encontrado
// identificador estável do vínculo nos endpoints consultados, e a chave
// curso+campus+turno não os separa -- na matrícula 222007757 três vínculos têm
// curso, campus e turno IDÊNTICOS com status "Reopção de Curso", "Cancelado" e
// nulo. Então:
//
//   - nenhuma linha é escolhida como "a" situação;
//   - o status de um curso nunca vira status da pessoa;
//   - a correspondência com o curso da dívida é declarada NÃO CONFIRMADA, em
//     mensagem SEPARADA -- e os status encontrados aparecem de todo jeito,
//     nunca escondidos atrás dela;
//   - `alunos.situacao_academica` não é lida nem escrita por este bloco.
//
// TRÊS DESFECHOS DISTINTOS, nunca achatados em "sem informação":
//   nunca consultado    -> consulta a API sozinho
//   SEM_RESULTADO       -> a API respondeu e não achou o CPF naquela busca
//   FALHA_COMUNICACAO   -> não se sabe nada; oferece tentar de novo
// E, dentro de uma linha, `status` nulo é "Não informado pelo Prime" -- que não
// é nenhum dos três acima.

const ROTULO_NULO = "Não informado pelo Prime";

function dataHora(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

function Vinculo({ v }) {
  const semStatus = v.status == null || v.status === "";
  return (
    <tr>
      <td style={S.td}>
        <span style={S.curso}>{v.curso || <span style={S.nd}>Curso não informado</span>}</span>
        <span style={S.sub}>
          {[v.campus, v.turno].filter(Boolean).join(" · ") || "campus e turno não informados"}
        </span>
      </td>
      <td style={S.td}>
        {semStatus
          ? <span style={S.tagVazia}>{ROTULO_NULO}</span>
          : <span style={S.tag}>{v.status}</span>}
      </td>
      <td style={S.td}>
        {/* graduated é INDEPENDENTE do status -- linha com "Mudança de Campus"
            veio graduated:true. Por isso é coluna própria, e não um derivado
            de status === 'Formado'. */}
        {v.graduated === true ? <b>sim</b> : v.graduated === false ? "não" : <span style={S.nd}>—</span>}
      </td>
      <td style={S.td}>
        {v.admission_year || <span style={S.nd}>—</span>}
      </td>
    </tr>
  );
}

export default function SituacaoAcademicaPrime({ aluno }) {
  // A leitura carrega DE QUAL ALUNO ela é. Sem isso, trocar de ficha mostraria
  // por um instante os vínculos do aluno anterior -- numa tela de cobrança, o
  // tipo de erro que faz alguém ligar para a pessoa errada.
  //
  // Guardar o dono junto do dado também evita `setState` síncrono dentro do
  // efeito (que a regra react-hooks/set-state-in-effect proíbe, e com razão:
  // gera renderização em cascata). "Carregando" passa a ser uma CONCLUSÃO --
  // "o que tenho não é deste aluno" -- em vez de um estado que alguém precisa
  // lembrar de ligar e desligar.
  const [carga, setCarga] = useState({ paraAluno: null, dados: null });
  const [consultando, setConsultando] = useState(false);
  const [erroTela, setErroTela] = useState(null);

  const alunoId = aluno?.id || null;
  const leitura = carga.paraAluno === alunoId ? carga.dados : null;
  const carregando = Boolean(alunoId) && carga.paraAluno !== alunoId;

  const consultarApi = useCallback(async () => {
    if (!alunoId) return;
    setConsultando(true);
    setErroTela(null);
    try {
      const { data, error } = await supabase.functions.invoke("prime-academico", {
        body: { aluno_id: alunoId },
      });
      if (error) throw error;
      if (data?.leitura) setCarga({ paraAluno: alunoId, dados: data.leitura });
      else if (data?.erro) setErroTela(String(data.erro));
    } catch (e) {
      // Falha ao FALAR com a nossa função é diferente de falha da API do Prime:
      // esta nem chegou a registrar consulta. A tela diz isso.
      setErroTela(e?.message ? `Não foi possível consultar: ${e.message}` : "Não foi possível consultar.");
    } finally {
      setConsultando(false);
    }
  }, [alunoId]);

  // Lê o que já está gravado. `null` = nunca consultado, e aí consulta a API
  // por conta própria -- é o caso "não houver dados locais".
  useEffect(() => {
    if (!alunoId) return undefined;
    let vivo = true;
    supabase
      .rpc("prime_academico_ultima", { p_aluno_id: alunoId })
      .then(({ data }) => {
        if (!vivo) return;
        // `null` = NUNCA consultado. Diferente de consultado sem resultado, e
        // por isso é aqui que a consulta à API acontece sozinha.
        if (data) setCarga({ paraAluno: alunoId, dados: data });
        else { setCarga({ paraAluno: alunoId, dados: null }); consultarApi(); }
      })
      .catch(() => { if (vivo) setCarga({ paraAluno: alunoId, dados: null }); });
    return () => { vivo = false; };
  }, [alunoId, consultarApi]);

  if (!alunoId) return null;

  const vinculos = Array.isArray(leitura?.vinculos) ? leitura.vinculos : [];
  const quando = dataHora(leitura?.consultado_em);

  return (
    <div style={S.caixa}>
      <div style={S.cab}>
        <span style={S.titulo}>Situação acadêmica consultada no Prime</span>
        <button
          type="button"
          onClick={consultarApi}
          disabled={consultando}
          style={{ ...S.botao, ...(consultando ? S.botaoOcupado : null) }}
        >
          {consultando ? "Consultando…" : "Atualizar consulta"}
        </button>
      </div>

      {carregando && <p style={S.mudo}>Carregando…</p>}

      {erroTela && <p style={S.falha}>{erroTela}</p>}

      {/* FALHA DE COMUNICAÇÃO -- não se sabe nada. Nunca dizer "sem vínculo". */}
      {leitura?.resultado === "FALHA_COMUNICACAO" && (
        <p style={S.falha}>
          Não foi possível falar com o Prime nesta consulta
          {leitura.detalhe_falha ? ` (${leitura.detalhe_falha})` : ""}. Isto não
          significa que o aluno não tenha vínculo — significa que a resposta não
          chegou. Tente atualizar a consulta.
        </p>
      )}

      {/* CONSULTA SEM RESULTADO -- a API respondeu, e não achou. Também não é
          "não tem vínculo": a busca é por CPF e pode não encontrar. */}
      {leitura?.resultado === "SEM_RESULTADO" && (
        <p style={S.vazio}>
          O Prime respondeu e não retornou nenhum vínculo para o CPF desta ficha.
          Não é o mesmo que “o aluno não tem vínculo”: a busca pode não encontrar
          o cadastro.
        </p>
      )}

      {leitura?.resultado === "COM_VINCULOS" && (
        <>
          {/* A correspondência com o curso da dívida vem SEPARADA, e ANTES da
              tabela -- mas não no lugar dela. Os status ficam visíveis. */}
          <p style={S.naoConfirmada}>
            Correspondência com o curso desta dívida não confirmada.
          </p>
          <table style={S.tabela}>
            <thead>
              <tr>
                <th style={S.th}>Curso · campus · turno</th>
                <th style={S.th}>Situação</th>
                <th style={S.th}>Formado?</th>
                <th style={S.th}>Ingresso</th>
              </tr>
            </thead>
            <tbody>
              {/* `linha_id` é identificador INTERNO nosso, usado só como chave
                  de render -- nunca apresentado como id do Prime. Duas linhas
                  com curso, campus e turno iguais são vínculos diferentes e
                  ficam as duas. */}
              {vinculos.map((v) => <Vinculo key={v.linha_id || `ordem-${v.ordem}`} v={v} />)}
            </tbody>
          </table>
          <p style={S.contagem}>
            {vinculos.length} {vinculos.length === 1 ? "vínculo" : "vínculos"} de curso
            {vinculos.some((v) => v.status == null || v.status === "")
              ? ` · ${vinculos.filter((v) => v.status == null || v.status === "").length} sem situação informada`
              : ""}
          </p>
        </>
      )}

      {leitura && (
        <p style={S.fonte}>
          Fonte: Prime · <code>students_search</code>
          {quando ? ` · consultado em ${quando}` : ""}
          {leitura.registration ? ` · matrícula ${leitura.registration}` : ""}
        </p>
      )}
    </div>
  );
}

const S = {
  caixa: {
    marginTop: 10, padding: "12px 14px", borderRadius: 10,
    background: "var(--rv-fundo-suave)", border: "1px solid var(--rv-borda)",
  },
  cab: { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", justifyContent: "space-between", marginBottom: 10 },
  titulo: { fontSize: 12.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--rv-texto)" },
  botao: {
    fontSize: 12, fontWeight: 600, padding: "5px 11px", borderRadius: 7, cursor: "pointer",
    background: "var(--rv-fundo)", color: "var(--rv-tinta)", border: "1px solid var(--rv-borda)",
  },
  botaoOcupado: { cursor: "progress", opacity: 0.75 },
  naoConfirmada: {
    margin: "0 0 10px", padding: "8px 10px", borderRadius: 7, fontSize: 12.5, fontWeight: 600,
    background: "rgba(180,83,9,0.10)", color: "var(--rv-ambar-texto)", border: "1px solid rgba(180,83,9,0.30)",
  },
  tabela: { width: "100%", borderCollapse: "collapse", fontSize: 12.5 },
  th: {
    textAlign: "left", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em",
    color: "var(--rv-texto)", padding: "5px 7px", borderBottom: "1px solid var(--rv-borda)",
  },
  td: { padding: "7px 7px", borderBottom: "1px solid var(--rv-borda)", verticalAlign: "top", color: "var(--rv-tinta)" },
  curso: { display: "block", fontWeight: 600 },
  sub: { display: "block", fontSize: 11.5, color: "var(--rv-texto)" },
  tag: {
    display: "inline-block", padding: "2px 8px", borderRadius: 999, fontSize: 11.5, fontWeight: 700,
    background: "rgba(100,116,139,0.14)", color: "var(--rv-tinta)", border: "1px solid rgba(100,116,139,0.30)",
  },
  tagVazia: { fontSize: 11.5, fontStyle: "italic", color: "var(--rv-texto)" },
  nd: { fontStyle: "italic", color: "var(--rv-texto)" },
  contagem: { margin: "8px 0 0", fontSize: 11.5, color: "var(--rv-texto)" },
  fonte: { margin: "9px 0 0", paddingTop: 8, borderTop: "1px dashed var(--rv-borda)", fontSize: 11.5, color: "var(--rv-texto)" },
  mudo: { margin: 0, fontSize: 12.5, color: "var(--rv-texto)" },
  vazio: { margin: 0, fontSize: 12.5, color: "var(--rv-texto)" },
  falha: {
    margin: "0 0 8px", padding: "8px 10px", borderRadius: 7, fontSize: 12.5,
    background: "rgba(185,28,28,0.10)", color: "var(--rv-vermelho-texto)", border: "1px solid rgba(185,28,28,0.30)",
  },
};
