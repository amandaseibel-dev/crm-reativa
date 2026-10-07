import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../services/supabase";
import { S, moeda, num } from "./situacoesDaSafraFormato";

// PENDENCIAS DE VALIDACAO — o resumo. O tratamento e na Fila Unica.
//
// "Pendente de classificacao" era uma caixa-preta: um total de alguns milhoes
// sem dizer por que aqueles valores estao pendentes. A abertura por submotivo
// ja existia dentro do banco (`pendente_detalhe`) e aparecia como um paragrafo
// corrido no rodape das seis linhas. Aqui ela vira tabela, com alunos, titulos,
// valor e participacao no total pendente.
//
// ESTA TELA NAO CORRIGE CASO, de proposito. A Efetividade e analise; quem trata
// e a Fila Unica de Confirmacao, e cada linha daqui leva para lá, filtrada pelo
// motivo — e assim que o valor exibido chega ao registro individual.
//
// NENHUM MOTIVO NOVO. Os submotivos, os rotulos e a acao de cada um vem de
// `carteira_pendencias_por_motivo`, que por sua vez usa o catalogo em SQL
// (`carteira_pendencia_rotulo` / `carteira_pendencia_acao`). O front nao tem
// catalogo proprio: dois catalogos divergiriam na primeira correcao.
//
// SUBMOTIVO SEM ACAO SEGURA APARECE MESMO ASSIM, marcado como tal. Esconde-lo
// faria o total nao fechar; inventar uma acao generica para ele seria pior.

export default function PendenciasDeValidacao({ ano, semestre = null, recarga = 0 }) {
  const navegar = useNavigate();
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState("");
  const [carregando, setCarregando] = useState(true);

  useEffect(() => {
    let ativo = true;
    (async () => {
      setCarregando(true);
      setErro("");
      const { data, error } = await supabase.rpc("carteira_pendencias_por_motivo",
        { p_ano: ano, p_semestre: semestre });
      if (!ativo) return;
      if (error) { setErro(error.message || "falha ao consultar"); setDados(null); }
      else { setDados(data || null); }
      setCarregando(false);
    })();
    return () => { ativo = false; };
  }, [ano, semestre, recarga]);

  if (carregando) return <p style={S.discreto}>Abrindo as pendências pelos motivos reais…</p>;
  if (erro) {
    return (
      <p style={S.erro}>
        Não foi possível abrir as pendências por motivo: {erro}. Os demais números desta tela não dependem
        desta consulta e seguem válidos.
      </p>
    );
  }
  if (!dados) return null;

  const motivos = dados.motivos || [];
  const total = dados.total || {};
  const base = Number(total.valor || 0);
  const conf = dados.conferencia || null;
  const somaveis = dados.contagens_somaveis !== false;

  if (!motivos.length) {
    return (
      <section style={{ marginTop: 22 }}>
        <div style={S.cabecalho}>
          <h2 style={S.h2}>Pendências de validação</h2>
        </div>
        <p style={S.discreto}>Nenhuma pendência de validação nesta safra.</p>
      </section>
    );
  }

  const pct = (v) =>
    base > 0
      ? ((100 * Number(v)) / base).toLocaleString("pt-BR",
          { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + "%"
      : "—";

  function abrirFila(motivo) {
    const q = new URLSearchParams({ motivo, ano, ...(semestre ? { semestre } : {}) });
    navegar("/fila-unica-confirmacao?" + q.toString());
  }

  return (
    <section style={{ marginTop: 22 }}>
      <div style={S.cabecalho}>
        <h2 style={S.h2}>Pendências de validação</h2>
        <span style={S.apoio}>{dados.recorte} · {moeda(base)} pendentes</span>
      </div>

      {conf && conf.fecha === false ? (
        <p style={S.erro}>
          ⚠️ A soma dos motivos difere do total pendente em {moeda(conf.diferenca)}. Os números estão como
          vieram do banco — nada foi ajustado para fechar.
        </p>
      ) : null}

      <div style={{ ...S.cartao, overflowX: "auto" }}>
        <table style={E.tabela}>
          <thead>
            <tr>
              <th style={{ ...E.th, textAlign: "left" }}>Motivo da pendência</th>
              <th style={E.th}>Alunos</th>
              <th style={E.th}>Títulos</th>
              <th style={E.th}>Valor</th>
              <th style={E.th}>% do pendente</th>
              <th style={{ ...E.th, textAlign: "left" }}>Onde se trata</th>
            </tr>
          </thead>
          <tbody>
            {motivos.map((m) => {
              const temAcao = m.acao === "CONFERENCIA_PRIME";
              return (
                <tr key={m.chave}>
                  <td style={E.tdMotivo}>{m.rotulo}</td>
                  <td style={E.tdNum}>{num(m.alunos)}</td>
                  <td style={E.tdNum}>{num(m.titulos)}</td>
                  <td style={E.tdValor}>{moeda(m.valor)}</td>
                  <td style={E.tdPct}>{pct(m.valor)}</td>
                  <td style={E.tdAcao}>
                    <button type="button" style={E.botao} onClick={() => abrirFila(m.chave)}>
                      {temAcao ? "Tratar na Fila Única" : "Ver na Fila Única"}
                    </button>
                    {!temAcao ? (
                      <span style={E.selo} title="Não há regra de resolução por caso para este motivo. Entra na fila com motivo e evidência, para análise humana.">
                        sem ação automática segura
                      </span>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td style={E.tdTotalRotulo}>Total pendente</td>
              <td style={E.tdTotal}>{somaveis ? num(total.alunos) : "—"}</td>
              <td style={E.tdTotal}>{somaveis ? num(total.titulos) : "—"}</td>
              <td style={E.tdTotal}>{moeda(base)}</td>
              <td style={E.tdTotal}>100,00%</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>

      <p style={S.rodape}>
        <strong>Os valores dos motivos são disjuntos e somam o total pendente</strong> — é isso que a
        conferência mede a cada chamada.{" "}
        {somaveis
          ? "Nesta safra cada título cai em um motivo só, então as contagens também somam."
          : "Nesta safra o mesmo título pode ter valor em mais de um motivo, então as contagens de aluno e de título não devem ser somadas entre motivos — por isso o total delas aparece como “—”."}
      </p>
      <p style={S.rodape}>
        <strong>Esta tela é análise, não tratamento.</strong> Nenhum caso é corrigido aqui: cada motivo leva
        à Fila Única de Confirmação, onde o caso aparece com aluno, CPF, título, valor, evidência e
        responsável. Motivo marcado como <em>sem ação automática segura</em> não ganha botão de resolução —
        não existe regra de resolução por caso para ele, e inventar uma seria pior que não ter.
      </p>
    </section>
  );
}

const E = {
  tabela: { width: "100%", borderCollapse: "collapse", fontVariantNumeric: "tabular-nums" },
  th: { fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase",
        color: "var(--rv-texto-fraco)", padding: "0 10px 7px", textAlign: "right",
        borderBottom: "1px solid var(--rv-borda-suave)", whiteSpace: "nowrap" },
  tdMotivo: { fontSize: 13, padding: "8px 10px 8px 0", color: "var(--rv-tinta)",
              borderBottom: "1px solid var(--rv-borda-suave)" },
  tdNum: { fontSize: 13, padding: "8px 10px", textAlign: "right", whiteSpace: "nowrap",
           borderBottom: "1px solid var(--rv-borda-suave)" },
  tdValor: { fontSize: 13, fontWeight: 700, padding: "8px 10px", textAlign: "right",
             whiteSpace: "nowrap", borderBottom: "1px solid var(--rv-borda-suave)" },
  tdPct: { fontSize: 12.5, padding: "8px 10px", textAlign: "right", whiteSpace: "nowrap",
           color: "var(--rv-texto-suave)", borderBottom: "1px solid var(--rv-borda-suave)" },
  tdAcao: { fontSize: 12, padding: "8px 0 8px 10px", borderBottom: "1px solid var(--rv-borda-suave)",
            display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" },
  botao: { background: "var(--rv-superficie)", color: "var(--rv-texto)",
           border: "1px solid var(--rv-borda-forte)", borderRadius: 8, padding: "4px 10px",
           fontSize: 12, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" },
  selo: { fontSize: 10.5, fontWeight: 700, letterSpacing: "0.02em", color: "var(--rv-ambar-texto)",
          border: "1px solid var(--rv-borda-suave)", borderRadius: 999, padding: "2px 8px" },
  tdTotalRotulo: { fontSize: 12.5, fontWeight: 700, padding: "10px 10px 0 0" },
  tdTotal: { fontSize: 13, fontWeight: 800, padding: "10px 10px 0", textAlign: "right",
             whiteSpace: "nowrap" },
};
