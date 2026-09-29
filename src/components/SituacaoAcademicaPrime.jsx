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
// identificador estável do vínculo nos endpoints e na amostra consultados, e a
// chave curso+campus+turno não os separa: há alunos com três vínculos de curso,
// campus e turno IDÊNTICOS e status diferentes -- medido e registrado em
// docs/integracoes/prime-mapa-identificadores.md. Então:
//
//   - nenhuma linha é escolhida como "a" situação;
//   - o status de um curso nunca vira status da pessoa;
//   - a correspondência com o curso da dívida é declarada NÃO CONFIRMADA, em
//     mensagem SEPARADA -- e os status encontrados aparecem de todo jeito,
//     nunca escondidos atrás dela;
//   - `alunos.situacao_academica` não é lida nem escrita por este bloco.
//
// QUEM PODE CONSULTAR. A Edge Function só atende gestão. O operador LÊ o que já
// está gravado -- é dado operacional, e escondê-lo produziria a cobrança errada
// -- mas não dispara consulta: o botão não aparece para ele, e a consulta
// automática não roda. Sem esse cuidado, abrir uma ficha nunca consultada como
// operador gerava uma chamada que só podia terminar em 403, e a tela mostraria
// um erro que não é problema dele nem tem ação possível do lado dele.
//
// CINCO ESTADOS DISTINTOS, nunca achatados em "sem informação":
//   erro ao LER o que está gravado -> é erro, e diz que é
//   nunca consultado             -> gestão consulta sozinha; operador é orientado
//   SEM_RESULTADO                -> respondeu e não há linha desta pessoa
//   FALHA_COMUNICACAO            -> não se sabe nada
// E, dentro de uma linha, `status` nulo é "Não informado pelo Prime".

const ROTULO_NULO = "Não informado pelo Prime";

function dataHora(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

function Vinculo({ v, mostrarMatricula }) {
  const semStatus = v.status == null || v.status === "";
  return (
    <tr>
      <td style={S.td}>
        <span style={S.curso}>{v.curso || <span style={S.nd}>Curso não informado</span>}</span>
        <span style={S.sub}>
          {[v.campus, v.turno].filter(Boolean).join(" · ") || "campus e turno não informados"}
        </span>
        {/* A matrícula só ganha linha própria quando a resposta traz mais de
            uma. Repetir a mesma em todas as linhas seria ruído; escondê-la
            quando DIFEREM apagaria de qual vínculo é qual. */}
        {mostrarMatricula && (
          <span style={S.sub}>
            matrícula {v.registration || <span style={S.nd}>não informada</span>}
          </span>
        )}
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

// A tabela de vínculos, usada duas vezes: para a consulta atual e para a última
// que deu certo, quando a atual falhou.
function TabelaVinculos({ vinculos }) {
  const semStatusN = vinculos.filter((v) => v.status == null || v.status === "").length;
  // Matrícula por linha só aparece quando a resposta trouxe mais de uma.
  // Repetir a mesma em todas seria ruído; escondê-la quando DIFEREM apagaria
  // de qual vínculo é qual.
  const matriculas = new Set(vinculos.map((v) => v.registration ?? null));
  const mostrarMatricula = matriculas.size > 1;
  return (
    <>
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
          {/* `linha_id` é identificador INTERNO nosso, usado só como chave de
              render -- nunca apresentado como id do Prime. Duas linhas com
              curso, campus e turno iguais são vínculos diferentes e ficam as
              duas. */}
          {vinculos.map((v) => (
            <Vinculo key={v.linha_id || `ordem-${v.ordem}`} v={v} mostrarMatricula={mostrarMatricula} />
          ))}
        </tbody>
      </table>
      <p style={S.contagem}>
        {vinculos.length} {vinculos.length === 1 ? "vínculo" : "vínculos"} de curso
        {semStatusN ? ` · ${semStatusN} sem situação informada` : ""}
        {mostrarMatricula ? ` · ${matriculas.size} matrículas diferentes` : ""}
      </p>
    </>
  );
}

export default function SituacaoAcademicaPrime({ aluno }) {
  // A carga carrega DE QUAL ALUNO ela é. Sem isso, trocar de ficha mostraria
  // por um instante os vínculos do aluno anterior -- numa tela de cobrança, o
  // tipo de erro que faz alguém ligar para a pessoa errada.
  //
  // Guardar o dono junto do dado também evita `setState` síncrono dentro do
  // efeito. "Carregando" passa a ser uma CONCLUSÃO -- "o que tenho não é deste
  // aluno" -- em vez de um estado que alguém precisa lembrar de ligar e
  // desligar.
  //
  // `erroLeitura` é separado de `dados`: falhar ao LER o que está gravado NÃO é
  // "nunca consultado". Tratar os dois como o mesmo `null` fazia a tela dizer
  // que não havia consulta quando na verdade não se conseguiu olhar -- e, para
  // a gestão, disparava uma consulta nova à API por cima de um dado que talvez
  // já existisse.
  const [carga, setCarga] = useState({ paraAluno: null, dados: null, erroLeitura: null });
  const [consultando, setConsultando] = useState(false);
  const [erroConsulta, setErroConsulta] = useState(null);
  const [podeConsultar, setPodeConsultar] = useState(null); // null = ainda não se sabe

  const alunoId = aluno?.id || null;
  const daFicha = carga.paraAluno === alunoId;
  const leitura = daFicha ? carga.dados : null;
  const erroLeitura = daFicha ? carga.erroLeitura : null;
  const carregando = Boolean(alunoId) && !daFicha;

  // Quem pode consultar é o banco que diz, pela mesma função que a Edge usa.
  // Erro na pergunta vira `false`: na dúvida, não oferece um botão que vai
  // falhar.
  useEffect(() => {
    let vivo = true;
    supabase
      .rpc("usuario_e_gestao")
      .then(({ data, error }) => { if (vivo) setPodeConsultar(!error && data === true); })
      .catch(() => { if (vivo) setPodeConsultar(false); });
    return () => { vivo = false; };
  }, []);

  const consultarApi = useCallback(async () => {
    if (!alunoId) return;
    setConsultando(true);
    setErroConsulta(null);
    try {
      const { data, error } = await supabase.functions.invoke("prime-academico", {
        body: { aluno_id: alunoId },
      });
      if (error) throw error;
      if (data?.leitura) setCarga({ paraAluno: alunoId, dados: data.leitura, erroLeitura: null });
      else if (data?.erro) setErroConsulta(String(data.erro));
    } catch (e) {
      // A CONSULTA FALHOU, MAS O QUE JÁ SE SABIA CONTINUA NA TELA. `carga` não
      // é tocada: a última consulta bem-sucedida segue visível, com a data
      // dela, e este aviso aparece por cima dizendo que a tentativa de agora
      // não foi. Limpar a tela numa falha de atualização seria trocar
      // informação boa por nenhuma.
      setErroConsulta(e?.message ? `Não foi possível consultar agora: ${e.message}` : "Não foi possível consultar agora.");
    } finally {
      setConsultando(false);
    }
  }, [alunoId]);

  // Lê o que já está gravado. Só depois de saber se pode consultar, para não
  // disparar uma chamada que terminaria em 403.
  useEffect(() => {
    if (!alunoId || podeConsultar === null) return undefined;
    let vivo = true;
    supabase
      .rpc("prime_academico_ultima", { p_aluno_id: alunoId })
      .then(({ data, error }) => {
        if (!vivo) return;
        if (error) {
          // Não conseguir LER é erro, e não "nunca consultado".
          setCarga({ paraAluno: alunoId, dados: null, erroLeitura: error.message || "erro ao ler" });
          return;
        }
        setCarga({ paraAluno: alunoId, dados: data || null, erroLeitura: null });
        // `null` = nunca consultado. Só a gestão dispara a consulta.
        if (!data && podeConsultar) consultarApi();
      })
      .catch((e) => {
        if (vivo) setCarga({ paraAluno: alunoId, dados: null, erroLeitura: e?.message || "erro ao ler" });
      });
    return () => { vivo = false; };
  }, [alunoId, podeConsultar, consultarApi]);

  if (!alunoId) return null;

  const vinculos = Array.isArray(leitura?.vinculos) ? leitura.vinculos : [];
  const quando = dataHora(leitura?.consultado_em);
  // Só existe quando a consulta mais recente falhou e havia uma boa antes.
  const boa = leitura?.ultima_boa || null;
  const nuncaConsultado = !leitura && !erroLeitura && !carregando;

  return (
    <div style={S.caixa}>
      <div style={S.cab}>
        <span style={S.titulo}>Situação acadêmica consultada no Prime</span>
        {podeConsultar && (
          <button
            type="button"
            onClick={consultarApi}
            disabled={consultando}
            style={{ ...S.botao, ...(consultando ? S.botaoOcupado : null) }}
          >
            {consultando ? "Consultando…" : "Atualizar consulta"}
          </button>
        )}
      </div>

      {carregando && <p style={S.mudo}>Carregando…</p>}

      {/* ERRO DE LEITURA -- não é ausência de consulta, é não ter conseguido
          olhar. Dizer "nunca consultado" aqui mandaria alguém consultar de novo
          um dado que talvez já exista. */}
      {erroLeitura && (
        <p style={S.falha}>
          Não foi possível ler as consultas já gravadas ({erroLeitura}). Isto não
          quer dizer que o aluno nunca tenha sido consultado — quer dizer que o
          registro não pôde ser lido agora.
        </p>
      )}

      {/* Falha da tentativa de AGORA. Aparece por cima, e o que já estava
          gravado continua abaixo, com a data da consulta que deu certo. */}
      {erroConsulta && (
        <p style={S.falha}>
          {erroConsulta}
          {leitura ? " A consulta anterior, abaixo, continua valendo." : ""}
        </p>
      )}

      {/* FALHA DE COMUNICAÇÃO -- não se sabe nada. Nunca dizer "sem vínculo". */}
      {leitura?.resultado === "FALHA_COMUNICACAO" && (
        <p style={S.falha}>
          Não foi possível falar com o Prime nesta consulta
          {leitura.detalhe_falha ? ` (${leitura.detalhe_falha})` : ""}. Isto não
          significa que o aluno não tenha vínculo — significa que a resposta não
          chegou.{podeConsultar ? " Tente atualizar a consulta." : ""}
        </p>
      )}

      {/* CONSULTA SEM RESULTADO -- a API respondeu, e não há linha desta
          pessoa. Também não é "não tem vínculo": a busca é por CPF e pode não
          encontrar. */}
      {leitura?.resultado === "SEM_RESULTADO" && (
        <p style={S.vazio}>
          O Prime respondeu e não retornou nenhum vínculo para o CPF desta ficha.
          Não é o mesmo que “o aluno não tem vínculo”: a busca pode não encontrar
          o cadastro.
        </p>
      )}

      {/* PAGINAÇÃO INCOMPLETA. Há dado, e ele NÃO pode ser apresentado como
          lista completa: a consulta bateu no teto sem provar que acabou.
          Chamar isto de sucesso afirmaria um total que ninguém mediu. */}
      {leitura?.resultado === "PAGINACAO_INCOMPLETA" && (
        <p style={S.parcial}>
          Esta consulta pode estar <b>incompleta</b>
          {leitura.detalhe_falha ? ` (${leitura.detalhe_falha})` : ""}. Os vínculos
          abaixo vieram do Prime, mas não há garantia de que sejam todos.
          {boa ? " A última consulta completa aparece separada, mais abaixo." : ""}
        </p>
      )}

      {(leitura?.resultado === "COM_VINCULOS" || leitura?.resultado === "PAGINACAO_INCOMPLETA") && (
        <>
          {/* A correspondência com o curso da dívida vem SEPARADA, e ANTES da
              tabela -- mas não no lugar dela. Os status ficam visíveis. */}
          <p style={S.naoConfirmada}>
            Correspondência com o curso desta dívida não confirmada.
          </p>
          <TabelaVinculos vinculos={vinculos} />
        </>
      )}

      {/* A ÚLTIMA CONSULTA COMPLETA, quando a mais recente falhou ou veio
          incompleta. Vem do banco, não da memória da tela -- então sobrevive a
          recarregar a página e a fechar e reabrir a ficha. Sem isto, uma falha
          apagava de vez o que já se sabia.

          Fica em bloco PRÓPRIO, com data própria: os vínculos parciais da
          consulta de cima e os desta aqui são de momentos diferentes e não
          podem se misturar numa tabela só. */}
      {boa && (
        <div style={S.boa}>
          <p style={S.boaTitulo}>
            Última consulta completa
            {dataHora(boa.consultado_em) ? ` · ${dataHora(boa.consultado_em)}` : ""}
          </p>
          {Array.isArray(boa.vinculos) && boa.vinculos.length > 0 ? (
            <>
              <p style={S.naoConfirmada}>
                Correspondência com o curso desta dívida não confirmada.
              </p>
              <TabelaVinculos vinculos={boa.vinculos} />
            </>
          ) : (
            <p style={S.vazio}>
              Naquela consulta o Prime respondeu e não retornou nenhum vínculo
              para o CPF desta ficha.
            </p>
          )}
        </div>
      )}

      {/* NUNCA CONSULTADO. Para a gestão isto quase não aparece (a consulta
          dispara sozinha). Para o operador é o estado normal, e ele precisa de
          uma instrução que ele consiga seguir -- não de um botão que daria 403
          nem de um erro que não é problema dele. */}
      {nuncaConsultado && !erroConsulta && (
        <p style={S.mudo}>
          {podeConsultar
            ? "Nenhuma consulta gravada para este aluno."
            : "Nenhuma consulta ao Prime foi feita para este aluno ainda. A consulta é restrita à gestão — peça a ela para consultar, e o resultado aparece aqui para todos."}
        </p>
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
  parcial: {
    margin: "0 0 10px", padding: "8px 10px", borderRadius: 7, fontSize: 12.5,
    background: "rgba(180,83,9,0.10)", color: "var(--rv-ambar-texto)", border: "1px solid rgba(180,83,9,0.30)",
  },
  boa: { marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--rv-borda)" },
  boaTitulo: {
    margin: "0 0 8px", fontSize: 11, fontWeight: 700, textTransform: "uppercase",
    letterSpacing: "0.04em", color: "var(--rv-texto)",
  },
  mudo: { margin: 0, fontSize: 12.5, color: "var(--rv-texto)" },
  vazio: { margin: 0, fontSize: 12.5, color: "var(--rv-texto)" },
  falha: {
    margin: "0 0 8px", padding: "8px 10px", borderRadius: 7, fontSize: 12.5,
    background: "rgba(185,28,28,0.10)", color: "var(--rv-vermelho-texto)", border: "1px solid rgba(185,28,28,0.30)",
  },
};
