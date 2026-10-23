// CENTRAL DE PAGAMENTOS · POR ARQUIVO
//
// Resolve uma dificuldade operacional concreta: ao importar a planilha do
// Santander, as divergências apareciam misturadas com pendências antigas, e não
// havia como dizer quais pagamentos DAQUELE arquivo foram baixados.
//
// ETAPA INICIAL, por decisão da gestão: seleção do arquivo, resumo financeiro
// por categoria e a listagem "Todos". As abas internas (Baixa confirmada,
// Baixa pendente, Divergências, Sem vínculo) vêm depois -- mas as quantidades e
// os valores de TODAS as categorias já aparecem no resumo, para a conferência
// não esperar pela tela completa.
//
// Nenhuma regra financeira vive aqui: a classificação é da view
// `vw_importacao_conferencia`, lida por duas RPCs com portão de gestão. Esta
// tela não dá baixa, não altera parcela, acordo ou saldo -- não há um único
// caminho de escrita.

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import {
  contagem,
  dinheiro,
  evidenciaDaLinha,
  fechamento,
  motivoDaLinha,
  resumoDoArquivo,
  rotuloArquivo,
  rotuloCategoria,
} from "../utils/conferenciaPorArquivo";

export default function CentralPagamentosPorArquivo() {
  const [arquivos, setArquivos] = useState([]);
  const [escolhido, setEscolhido] = useState("");
  const [linhas, setLinhas] = useState([]);
  const [busca, setBusca] = useState("");
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");

  useEffect(() => {
    let ativo = true;
    (async () => {
      const { data, error } = await supabase.rpc("importacao_conferencia_arquivos", { p_limite: 30 });
      if (!ativo) return;
      if (error) {
        setErro(error.message);
        setCarregando(false);
        return;
      }
      setArquivos(data || []);
      // Abre no mais recente, que é o caso de uso: acabei de importar, o que deu.
      if ((data || []).length) setEscolhido(data[0].importacao_id);
      setCarregando(false);
    })();
    return () => { ativo = false; };
  }, []);

  // A leitura das linhas acontece em dois caminhos, e eles sao DIFERENTES de
  // proposito:
  //
  //   * trocar de arquivo e um EFEITO (sincronizar com o estado externo). Aqui
  //     o primeiro comando e o `await`: nada de setState sincrono no corpo do
  //     efeito, que e o que `react-hooks/set-state-in-effect` cobra -- e com
  //     razao, porque setState sincrono em efeito encadeia renders.
  //   * pesquisar e um EVENTO do usuario. Ali setState e livre, e por isso o
  //     indicador de "carregando" aparece na busca e nao na troca de arquivo.
  const buscarNoArquivo = useCallback(async (importacaoId, termo) => {
    if (!importacaoId) return;
    setCarregando(true);
    const { data, error } = await supabase.rpc("importacao_conferencia_ler", {
      p_importacao_id: importacaoId,
      p_categoria: null,
      p_busca: termo || null,
      p_limite: 500,
    });
    setErro(error ? error.message : "");
    setLinhas(error ? [] : data || []);
    setCarregando(false);
  }, []);

  useEffect(() => {
    if (!escolhido) return undefined;
    let ativo = true;
    (async () => {
      const { data, error } = await supabase.rpc("importacao_conferencia_ler", {
        p_importacao_id: escolhido,
        p_categoria: null,
        p_busca: null,
        p_limite: 500,
      });
      if (!ativo) return;
      setErro(error ? error.message : "");
      setLinhas(error ? [] : data || []);
      setCarregando(false);
    })();
    return () => { ativo = false; };
  }, [escolhido]);

  const arquivo = useMemo(
    () => arquivos.find((a) => a.importacao_id === escolhido) || null,
    [arquivos, escolhido]
  );
  const resumo = useMemo(() => resumoDoArquivo(arquivo), [arquivo]);
  const conta = useMemo(() => fechamento(arquivo), [arquivo]);

  if (erro) {
    return (
      <div style={S.aviso}>
        Não foi possível carregar a conferência: {erro}
      </div>
    );
  }

  return (
    <div style={S.wrap}>
      <div style={S.topo}>
        <label style={S.rot} htmlFor="conf-arquivo">Arquivo importado</label>
        <select
          id="conf-arquivo"
          style={S.select}
          value={escolhido}
          onChange={(e) => { setBusca(""); setEscolhido(e.target.value); }}
          disabled={!arquivos.length}
        >
          {arquivos.map((a) => (
            <option key={a.importacao_id} value={a.importacao_id}>{rotuloArquivo(a)}</option>
          ))}
        </select>
        <form
          style={S.buscaForm}
          onSubmit={(e) => { e.preventDefault(); buscarNoArquivo(escolhido, busca); }}
        >
          <input
            style={S.busca}
            placeholder="Aluno, matrícula, acordo ou parcela"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            aria-label="Pesquisar no arquivo"
          />
          <button type="submit" style={S.botao}>Pesquisar</button>
        </form>
      </div>

      {!arquivos.length && !carregando && (
        <div style={S.aviso}>Nenhum arquivo de projeção importado ainda.</div>
      )}

      {arquivo && (
        <>
          <div style={S.resumoLinha}>
            <Bloco rot="Pagamentos no arquivo" val={contagem(arquivo.pagamentos)} />
            <Bloco rot="Valor total" val={dinheiro(arquivo.valor_total)} />
            {arquivo.com_suspeita_duplicidade > 0 && (
              <Bloco
                rot="Com suspeita de duplicidade"
                val={contagem(arquivo.com_suspeita_duplicidade)}
                tom="vermelho"
                /* Sinal, não categoria: o pagamento continua contado na
                   categoria dele, e por isso este número NÃO entra na soma. */
                nota="já contados na categoria de cada um"
              />
            )}
          </div>

          <div style={S.cards}>
            {resumo.map((c) => (
              <div key={c.chave} style={{ ...S.card, borderLeft: `3px solid ${COR[c.tom]}` }} title={c.ajuda}>
                <span style={{ ...S.cardVal, color: COR[c.tom] }}>{contagem(c.qtd)}</span>
                <span style={S.cardRot}>{c.rotulo}</span>
                {c.valor != null && <span style={S.cardVlr}>{dinheiro(c.valor)}</span>}
              </div>
            ))}
          </div>

          {/* O fechamento das contas, dito na tela. Se não fechar, a tela avisa
              em vez de mostrar número que não soma. */}
          <div style={conta.fecha ? S.fecha : S.naoFecha}>
            {conta.fecha
              ? `As categorias fecham com o arquivo: ${contagem(conta.qtdTotal)} pagamentos e ${dinheiro(conta.valorTotal)}.`
              : `ATENÇÃO: as categorias somam ${contagem(conta.qtdSoma)} de ${contagem(conta.qtdTotal)} pagamentos ` +
                `e ${dinheiro(conta.valorSoma)} de ${dinheiro(conta.valorTotal)}. Não confira por esta tela até isso ser investigado.`}
          </div>

          {/* ITEM 9: pendência histórica que este arquivo reencostou. Fica
              destacada e FORA das contagens acima -- em produção são 115 linhas
              cuja fila aponta para um arquivo e cujo pagamento é de outro. */}
          {arquivo.pendencias_historicas_relacionadas > 0 && (
            <div style={S.historicas}>
              <strong>{contagem(arquivo.pendencias_historicas_relacionadas)}</strong>{" "}
              pendência(s) de <strong>outros arquivos</strong> foram reencostadas por este.
              Não entram nos números acima, que são só deste arquivo.
            </div>
          )}

          <div style={S.tabelaWrap}>
            <table style={S.tabela}>
              <thead>
                <tr>
                  <th style={S.th}>Categoria</th>
                  <th style={S.th}>Aluno</th>
                  <th style={S.th}>Matrícula</th>
                  <th style={S.th}>Acordo</th>
                  <th style={S.th}>Parcela</th>
                  <th style={S.thNum}>Valor pago</th>
                  <th style={S.thNum}>Honorário</th>
                  <th style={S.th}>Origem do pagamento</th>
                  <th style={S.th}>Motivo</th>
                  <th style={S.th}>Evidência da baixa</th>
                </tr>
              </thead>
              <tbody>
                {linhas.map((l) => (
                  <tr key={l.pagamento_id}>
                    <td style={S.td}>
                      <span style={{ ...S.tag, background: FUNDO[tomDe(l.categoria)], color: COR[tomDe(l.categoria)] }}>
                        {rotuloCategoria(l.categoria)}
                      </span>
                      {l.tem_suspeita_duplicidade && <span style={S.dup} title="Suspeita de duplicidade">dup</span>}
                      {l.fila_de_outro_arquivo && (
                        <span style={S.outro} title="A pendência foi detectada por outro arquivo">outro arquivo</span>
                      )}
                    </td>
                    <td style={S.td}>{l.aluno_nome || "—"}</td>
                    <td style={S.td}>{l.matricula || "—"}</td>
                    <td style={S.td}>{l.titulo_numero || "—"}</td>
                    <td style={S.td}>{l.numero_parcela_completo || "—"}</td>
                    <td style={S.tdNum}>{dinheiro(l.valor_pago)}</td>
                    <td style={S.tdNum}>{dinheiro(l.valor_honorario)}</td>
                    <td style={S.td}>{l.origem_vinculo || "—"}</td>
                    <td style={S.td}>{motivoDaLinha(l)}</td>
                    <td style={S.td}>{evidenciaDaLinha(l) || "—"}</td>
                  </tr>
                ))}
                {!linhas.length && !carregando && (
                  <tr>
                    <td style={S.td} colSpan={10}>
                      {busca
                        ? "Nenhum pagamento deste arquivo bate com a pesquisa."
                        : "Este arquivo não gerou nenhum pagamento novo — todas as linhas já existiam."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {carregando && <div style={S.aviso}>Carregando…</div>}
    </div>
  );
}

function Bloco({ rot, val, tom, nota }) {
  return (
    <div style={S.bloco}>
      <span style={{ ...S.blocoVal, color: tom ? COR[tom] : "var(--rv-tinta)" }}>{val}</span>
      <span style={S.blocoRot}>{rot}</span>
      {nota && <span style={S.blocoNota}>{nota}</span>}
    </div>
  );
}

const tomDe = (categoria) => ({
  DIVERGENCIA: "vermelho",
  SEM_VINCULO: "ambar",
  BAIXA_PENDENTE: "azul",
  BAIXA_REGISTRADA_CRM: "verde",
  FORA_DA_JANELA: "cinza",
  NAO_CLASSIFICADO: "vermelho",
}[categoria] || "cinza");

const COR = {
  verde: "var(--rv-verde-texto)",
  azul: "var(--rv-azul-texto)",
  ambar: "var(--rv-ambar-texto)",
  vermelho: "var(--rv-vermelho)",
  cinza: "var(--rv-texto-suave)",
};
const FUNDO = {
  verde: "var(--rv-verde-fundo)",
  azul: "var(--rv-azul-fundo)",
  ambar: "var(--rv-ambar-fundo)",
  vermelho: "var(--rv-vermelho-fundo)",
  cinza: "var(--rv-fundo-suave)",
};

const S = {
  wrap: { display: "flex", flexDirection: "column", gap: 12, paddingTop: 8 },
  topo: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" },
  rot: { fontSize: 12, fontWeight: 700, color: "var(--rv-texto-suave)" },
  select: { flex: "1 1 320px", minWidth: 240, padding: "7px 9px", borderRadius: 8, border: "1px solid var(--rv-borda)", background: "var(--rv-fundo-cartao)", color: "var(--rv-texto)", fontSize: 13 },
  buscaForm: { display: "flex", gap: 6 },
  busca: { padding: "7px 9px", borderRadius: 8, border: "1px solid var(--rv-borda)", background: "var(--rv-fundo-cartao)", color: "var(--rv-texto)", fontSize: 13, minWidth: 220 },
  botao: { padding: "7px 14px", borderRadius: 8, border: "1px solid var(--rv-borda)", background: "var(--rv-fundo-suave)", color: "var(--rv-texto)", fontSize: 13, cursor: "pointer", fontWeight: 600 },
  resumoLinha: { display: "flex", gap: 10, flexWrap: "wrap" },
  bloco: { background: "var(--rv-fundo-cartao)", borderRadius: 10, padding: "10px 14px", display: "flex", flexDirection: "column", gap: 2, minWidth: 160 },
  blocoVal: { fontSize: 20, fontWeight: 800, lineHeight: 1.1 },
  blocoRot: { fontSize: 12, color: "var(--rv-texto-suave)", fontWeight: 600 },
  blocoNota: { fontSize: 11, color: "var(--rv-texto-suave)", fontStyle: "italic" },
  cards: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8 },
  card: { background: "var(--rv-fundo-cartao)", borderRadius: 10, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 2 },
  cardVal: { fontSize: 19, fontWeight: 800, lineHeight: 1.1 },
  cardRot: { fontSize: 12, color: "var(--rv-texto-suave)", fontWeight: 600 },
  cardVlr: { fontSize: 12, color: "var(--rv-texto)" },
  fecha: { fontSize: 12, color: "var(--rv-texto-suave)", padding: "6px 2px" },
  naoFecha: { fontSize: 13, fontWeight: 700, color: "var(--rv-vermelho)", background: "var(--rv-vermelho-fundo)", borderRadius: 8, padding: "9px 12px" },
  historicas: { fontSize: 13, color: "var(--rv-ambar-texto)", background: "var(--rv-ambar-fundo)", borderRadius: 8, padding: "9px 12px" },
  tabelaWrap: { overflowX: "auto" },
  tabela: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", padding: "8px 10px", borderBottom: "1px solid var(--rv-borda)", color: "var(--rv-texto-suave)", fontSize: 12, whiteSpace: "nowrap" },
  thNum: { textAlign: "right", padding: "8px 10px", borderBottom: "1px solid var(--rv-borda)", color: "var(--rv-texto-suave)", fontSize: 12, whiteSpace: "nowrap" },
  td: { padding: "8px 10px", borderBottom: "1px solid var(--rv-borda-suave)", verticalAlign: "top" },
  tdNum: { padding: "8px 10px", borderBottom: "1px solid var(--rv-borda-suave)", textAlign: "right", whiteSpace: "nowrap" },
  tag: { borderRadius: 999, padding: "2px 9px", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" },
  dup: { marginLeft: 6, borderRadius: 999, padding: "2px 7px", fontSize: 10, fontWeight: 700, background: "var(--rv-vermelho-fundo)", color: "var(--rv-vermelho)" },
  outro: { marginLeft: 6, borderRadius: 999, padding: "2px 7px", fontSize: 10, fontWeight: 700, background: "var(--rv-ambar-fundo)", color: "var(--rv-ambar-texto)" },
  aviso: { fontSize: 13, color: "var(--rv-texto-suave)", padding: "10px 2px" },
};
