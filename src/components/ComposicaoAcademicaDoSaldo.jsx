import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";
import { S, moeda, num, dataCurta } from "./situacoesDaSafraFormato";

// QUEM COMPOE O SALDO EM ABERTO — composicao FINANCEIRA por status academico.
//
// Pedido da gestao em 07/10/2026: a analise academica da Efetividade era
// quantitativa (quantos alunos em cada status) e nao respondia a pergunta que a
// Diretoria faz: "quantos alunos formados estao inadimplentes e qual o saldo
// deles?". Este bloco troca a contagem pela composicao do saldo.
//
// SUBSTITUI DOIS BLOCOS QUE DIZIAM A MESMA COISA: "Alunos por status" (dentro
// das seis linhas) e o card "Status academico por safra". Os dois listavam as
// mesmas categorias da mesma importacao, so com contagem de aluno. Esta tabela
// traz alunos, titulos, saldo e percentual — ou seja, tudo o que eles traziam e
// mais o que faltava — entao eles sairam.
//
// NENHUMA CONTA ACONTECE AQUI. `carteira_em_aberto_por_status_academico` soma,
// agrupa e CONFERE; o front desenha. O unico percentual calculado no desenho e
// o share de cada linha sobre o total que a propria RPC devolveu — a mesma
// conta que as seis linhas ja fazem para a barra de cada situacao.
//
// AS CATEGORIAS SAO AS DA BASE, por rotulo exato. Nada e agrupado, nada vira
// "Outros", e "(sem situação importada)" e uma categoria como as outras: e
// justamente ela que mede o buraco de cobertura academica de 2024, e por isso
// ganha um aviso proprio quando pesa no saldo.
//
// A SITUACAO ACADEMICA E FOTOGRAFIA. O rodape sempre diz a data da importacao
// que alimenta estes status — nunca sugere consulta ao Prime de hoje. O dado
// FINANCEIRO, ao contrario, e lido ao vivo a cada abertura e a cada "Atualizar
// dados" (e o que `recarga` provoca).

const pct = (parte, todo) => {
  if (!(Number(todo) > 0)) return "—";
  const v = (100 * Number(parte)) / Number(todo);
  // Uma casa nunca, duas sempre: a coluna e de participacao no saldo e a
  // gestao compara linhas proximas. Categoria com saldo de verdade nao vira
  // "0,00%" — abaixo de 0,005% o card diz "<0,01%".
  if (v > 0 && v < 0.005) return "<0,01%";
  return v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + "%";
};

const SEM_SITUACAO = "(sem situação importada)";

export default function ComposicaoAcademicaDoSaldo({ ano, semestre = null, recarga = 0 }) {
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState("");
  const [carregando, setCarregando] = useState(true);

  useEffect(() => {
    let ativo = true;
    // O reset entra DENTRO da funcao assincrona: setState no corpo do efeito
    // cascateia render e a regra `react-hooks/set-state-in-effect` reprova na
    // catraca do lint.
    (async () => {
      setCarregando(true);
      setErro("");
      const { data, error } = await supabase.rpc("carteira_em_aberto_por_status_academico",
        { p_ano: ano, p_semestre: semestre });
      if (!ativo) return;
      if (error) { setErro(error.message || "falha ao consultar"); setDados(null); }
      else { setDados(data || null); }
      setCarregando(false);
    })();
    return () => { ativo = false; };
  }, [ano, semestre, recarga]);

  if (carregando) return <p style={S.discreto}>Compondo o saldo em aberto por status acadêmico…</p>;
  if (erro) {
    return (
      <p style={S.erro}>
        Não foi possível compor o saldo por status acadêmico: {erro}. Os demais números desta tela não
        dependem desta consulta e seguem válidos.
      </p>
    );
  }
  if (!dados) return null;

  const linhas = dados.linhas || [];
  const total = dados.total || {};
  const base = Number(total.valor || 0);
  const conf = dados.conferencia || null;
  const semSituacao = linhas.find((l) => l.status === SEM_SITUACAO) || null;
  const fonte = dados.fonte_academica?.importacao_atualizada_em || null;

  if (!linhas.length) {
    return <p style={S.discreto}>Sem saldo em aberto para compor nesta safra.</p>;
  }

  return (
    <section style={{ marginTop: 22 }}>
      <div style={S.cabecalho}>
        <h2 style={S.h2}>Quem compõe o saldo em aberto</h2>
        <span style={S.apoio}>
          {linhas.length} {linhas.length === 1 ? "status" : "status"} · {moeda(base)}
        </span>
      </div>

      {/* Conta e registra, nao corrige: se a soma das linhas deixar de bater com
          o total, o aviso sobe e nenhum numero e ajustado por conta propria. */}
      {conf && conf.fecha === false ? (
        <p style={S.erro}>
          ⚠️ A soma dos status difere do saldo em aberto em {moeda(conf.diferenca)}. Os números estão como
          vieram do banco — nada foi ajustado para fechar.
        </p>
      ) : null}

      <div style={{ ...S.cartao, overflowX: "auto" }}>
        <table style={E.tabela}>
          <thead>
            <tr>
              <th style={{ ...E.th, textAlign: "left" }}>Status acadêmico</th>
              <th style={E.th}>Alunos inadimplentes</th>
              <th style={E.th}>Títulos em aberto</th>
              <th style={E.th}>Saldo em aberto</th>
              <th style={E.th}>% do saldo</th>
            </tr>
          </thead>
          <tbody>
            {linhas.map((l) => (
              <tr key={l.status}>
                <td style={E.tdStatus}>{l.status}</td>
                <td style={E.tdNum}>{num(l.alunos)}</td>
                <td style={E.tdNum}>{num(l.titulos)}</td>
                <td style={E.tdValor}>{moeda(l.valor)}</td>
                <td style={E.tdPct}>{pct(l.valor, base)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td style={E.tdTotalRotulo}>Total em aberto</td>
              <td style={E.tdTotal}>{num(total.alunos)}</td>
              <td style={E.tdTotal}>{num(total.titulos)}</td>
              <td style={E.tdTotal}>{moeda(base)}</td>
              <td style={E.tdTotal}>100,00%</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* O buraco de cobertura de 2024 nao se esconde: ele ganha uma linha
          propria na tabela E um aviso discreto com o percentual medido. */}
      {semSituacao && Number(semSituacao.valor) > 0 ? (
        <p style={{ ...S.rodape, color: "var(--rv-ambar-texto)" }}>
          {pct(semSituacao.valor, base)} do saldo de {dados.recorte} está sem situação acadêmica importada.
        </p>
      ) : null}

      <p style={S.rodape}>
        <strong>Cada título entra em um único status</strong> — o do aluno daquele título — e aluno sem
        situação importada fica em “{SEM_SITUACAO}”, nunca descartado. Por isso a coluna de títulos e a de
        saldo fecham com o total; as de alunos também, porque um aluno tem um status só.{" "}
        {dados.universo_em_aberto === "inadimplencia + em_validacao"
          ? "Em 2026/1 o universo em aberto inclui o que está em validação, pela regra da safra."
          : "O universo é o saldo sem acordo ativo — o mesmo da linha “Em aberto” das seis linhas."}
      </p>
      <p style={S.rodape}>
        <strong>O status acadêmico é fotografia, não consulta de hoje.</strong>{" "}
        {fonte
          ? "Vem do relatório acadêmico importado em " + dataCurta(fonte) + "."
          : "A base não registra a data da importação para este recorte."}{" "}
        Os valores financeiros, ao contrário, são lidos ao vivo a cada abertura da tela e a cada “Atualizar
        dados”. As categorias são as que a base tem — não há “Evadido” entre elas.
      </p>
      {conf ? (
        <p style={S.rodape}>
          Conferência da composição: {moeda(conf.total_valor)} de saldo em aberto contra{" "}
          {moeda(conf.soma_das_linhas)} somados nos status — diferença de {moeda(conf.diferenca)}.{" "}
          {num(conf.titulos_total)} títulos no total contra {num(conf.titulos_soma)} somados nas linhas.
          Medida a cada chamada; conta e registra, não corrige.
        </p>
      ) : null}
    </section>
  );
}

const E = {
  tabela: { width: "100%", borderCollapse: "collapse", fontVariantNumeric: "tabular-nums" },
  th: { fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase",
        color: "var(--rv-texto-fraco)", padding: "0 10px 7px", textAlign: "right",
        borderBottom: "1px solid var(--rv-borda-suave)", whiteSpace: "nowrap" },
  tdStatus: { fontSize: 13, padding: "8px 10px 8px 0", color: "var(--rv-tinta)",
              borderBottom: "1px solid var(--rv-borda-suave)" },
  tdNum: { fontSize: 13, padding: "8px 10px", textAlign: "right", whiteSpace: "nowrap",
           borderBottom: "1px solid var(--rv-borda-suave)" },
  tdValor: { fontSize: 13, fontWeight: 700, padding: "8px 10px", textAlign: "right",
             whiteSpace: "nowrap", borderBottom: "1px solid var(--rv-borda-suave)" },
  tdPct: { fontSize: 12.5, padding: "8px 10px", textAlign: "right", whiteSpace: "nowrap",
           color: "var(--rv-texto-suave)", borderBottom: "1px solid var(--rv-borda-suave)" },
  tdTotalRotulo: { fontSize: 12.5, fontWeight: 700, padding: "10px 10px 0 0" },
  tdTotal: { fontSize: 13, fontWeight: 800, padding: "10px 10px 0", textAlign: "right",
             whiteSpace: "nowrap" },
};
