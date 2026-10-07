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
// que alimenta estes status — nunca sugere consulta ao Prime de hoje.
//
// A REGUA (ajuste de 07/10/2026). Em 2024/2025 este bloco decompoe o SALDO EM
// ABERTO ATUAL pela regua historica oficial — a mesma de
// `carteira_saldo_historico_por_ano().aberto` —, e NAO o balde "em aberto" das
// seis linhas, que e mais amplo (R$ 4,99 mi contra R$ 3,67 mi em 2024, medido
// em producao). As duas reguas respondem perguntas diferentes e as duas valem;
// a tela diz qual e qual e nao tenta iguala-las:
//   Universo recebido     -> regua das seis linhas (o que entrou em cobranca)
//   Saldo em aberto atual -> regua historica oficial (exposicao de hoje)
//   este bloco            -> decomposicao do saldo em aberto atual
//
// NAO BUSCA NADA. O payload vem da pagina, que o le de
// `carteira_efetividade_ler('composicao_academica', ...)` — fotografia, nao a
// consulta viva: em 2026/1 a consulta viva custa ~21 s e o teto do papel
// `authenticated` e 8 s. O MESMO payload alimenta o indicador "Saldo em aberto
// atual" do resumo, no topo da pagina, para o cartao e a tabela nunca
// divergirem.

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

export default function ComposicaoAcademicaDoSaldo({ dados, erro = "", carregando = false }) {
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
  // Fotografia ainda não tirada é diferente de "não há composição", e a tela
  // tem de dizer qual dos dois é.
  if (dados.sem_snapshot) {
    return (
      <section style={{ marginTop: 22 }}>
        <div style={S.cabecalho}>
          <h2 style={S.h2}>Quem compõe o saldo em aberto</h2>
        </div>
        <p style={{ ...S.rodape, color: "var(--rv-ambar-texto)" }}>
          <strong>Este bloco ainda não tem fotografia de {dados.recorte}.</strong> A rotina da hora
          reconstrói; assim que ela rodar, a composição aparece. Os demais blocos desta tela não dependem
          dela.
        </p>
      </section>
    );
  }

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
          {dados.regua ? " · régua: " + dados.regua : ""}
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
          : "O universo é o Saldo em aberto atual, pela régua histórica oficial — a mesma de "
            + "“carteira_saldo_historico_por_ano”. Não é o balde “Em aberto” das seis linhas, que é mais "
            + "amplo: ele mede o saldo sem acordo ativo sobre tudo o que entrou em cobrança, enquanto a "
            + "régua oficial mede a exposição de hoje e exclui o que não é mais cobrável por nós "
            + "(outro portador, liquidado na Prime após o vencimento, CPF no portador 166 sem acordo "
            + "ativo, confirmação pendente, caso cancelado ou jurídico, e aluno cujos pagamentos desde "
            + "julho/2026 já cobrem todo o aberto). As duas valem; esta tela não as iguala."}
      </p>
      <p style={S.rodape}>
        <strong>O status acadêmico é fotografia, não consulta de hoje.</strong>{" "}
        {fonte
          ? "Vem do relatório acadêmico importado em " + dataCurta(fonte) + "."
          : "A base não registra a data da importação para este recorte."}{" "}
        As categorias são as que a base tem — não há “Evadido” entre elas.
      </p>
      <p style={S.rodape}>
        <strong>Esta composição é lida de fotografia.</strong>{" "}
        {dados.snapshot?.gerado_em
          ? "Reconstruída em " + dataCurta(dados.snapshot.gerado_em) + " pela rotina da hora."
          : "A rotina da hora reconstrói."}{" "}
        O cálculo ao vivo custa acima do teto de 8s do papel da aplicação em 2026/1, então ele roda fora da
        requisição da tela — a fonte viva segue sendo a origem da verdade, e “Atualizar dados” refaz a
        leitura da fotografia disponível, sem disparar reconstrução pesada.
      </p>
      {conf ? (
        <p style={S.rodape}>
          Conferência da composição: {moeda(conf.total_valor)} de saldo em aberto contra{" "}
          {moeda(conf.soma_das_linhas)} somados nos status — diferença de {moeda(conf.diferenca)}.{" "}
          {num(conf.titulos_total)} títulos no total contra {num(conf.titulos_soma)} somados nas linhas
          {conf.alunos_total != null
            ? ", e " + num(conf.alunos_total) + " alunos contra " + num(conf.alunos_soma) + " somados"
            : ""}.
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
