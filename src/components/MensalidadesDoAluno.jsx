// Detalhamento das mensalidades em aberto de UM aluno, dentro da tabela da
// Minha Carteira. Puro: recebe as mensalidades que a propria tela ja carregou
// (consolidarFinanceiro) e so as mostra.
//
// POR QUE EXISTE (relato da operacao, 22/10/2026: "a caixinha das mensalidades
// nao abre ao clicar"). A coluna "Valor aberto" mostrava "Mensalidades: R$ X" e
// a quantidade de titulos, mas nao havia como ver QUAIS mensalidades formavam
// aquele numero: os textos da caixa eram <div> sem clique nenhum, e o clique
// subia para o <tr>, que abre o atendimento inteiro. Para conferir uma
// competencia o operador tinha de abrir a ficha e rolar ate o bloco dos
// borderos.
//
// NAO RECALCULA NADA. O `valor` de cada linha e o MESMO numero que
// consolidarFinanceiro somou em `fa.mensalidades`, e o total exibido no painel e
// o proprio `fa.mensalidades`, recebido por prop. Nenhuma regra financeira nova,
// nenhuma soma repetida: o painel so decompoe o numero que a linha ja mostra.

import { ordenarMensalidades, situacaoMensalidade } from "../utils/mensalidadesCarteira";

// Mesmos formatadores da tela que hospeda o painel (PainelCarteira), copiados
// aqui para o componente nao depender dela -- e o que MinhaCarteira.jsx e
// FinanceiroAluno.jsx tambem fazem com `moeda`.
function moeda(valor) {
  const n = Number(valor) || 0;
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function dataBR(iso) {
  const s = String(iso ?? "").slice(0, 10);
  const p = s.split("-");
  return p.length === 3 && p[0].length === 4 ? `${p[2]}/${p[1]}/${p[0]}` : "-";
}

const S = {
  botao: {
    background: "none",
    border: "none",
    padding: 0,
    margin: 0,
    font: "inherit",
    fontSize: 11,
    color: "var(--rv-azul-texto)",
    cursor: "pointer",
    textAlign: "right",
    textDecoration: "underline dotted",
    textUnderlineOffset: 2,
  },
  celulaDetalhe: {
    padding: "0 14px 14px",
    borderBottom: "1px solid var(--rv-borda-suave)",
    verticalAlign: "top",
  },
  painel: {
    border: "1px solid var(--rv-borda)",
    borderLeft: "3px solid var(--rv-azul-texto)",
    borderRadius: 10,
    background: "var(--rv-fundo-cartao)",
    padding: "10px 12px",
    textAlign: "left",
    whiteSpace: "normal",
  },
  cabeca: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    gap: 10,
    flexWrap: "wrap",
    marginBottom: 6,
  },
  titulo: { fontSize: 12, fontWeight: 800, color: "var(--rv-texto-forte)" },
  total: { fontSize: 12, fontWeight: 700, color: "var(--rv-texto-suave)" },
  cabecalhoGrade: {
    fontSize: 10,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    color: "var(--rv-texto-fraco)",
  },
  linha: {
    display: "grid",
    gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1.1fr)",
    columnGap: 10,
    alignItems: "baseline",
    padding: "4px 0",
    borderTop: "1px solid var(--rv-borda-suave)",
    fontSize: 12,
  },
  valor: { fontWeight: 700, color: "var(--rv-texto)" },
  nota: { fontSize: 11, color: "var(--rv-texto-fraco)", marginTop: 6 },
};

// Inline style nao faz media query, e esta linha vive DENTRO da tabela que o
// celular transforma em cards (`.pc-tabela`). Duas coisas precisam de CSS:
// (1) a celula do painel nao tem data-label, entao o `display:flex` que o
// celular aplica em toda <td> a deixaria sem largura -- volta para `block`;
// (2) a grade de 4 colunas num aparelho de 375px daria ~80px por coluna, logo
// ela empilha em 2 colunas, com o rotulo de cada valor vindo do ::before.
const CSS_MENSALIDADES = `
  @media (max-width: 640px) {
    .pc-tabela td.pcm-celula { display: block !important; padding: 0 0 4px !important; }
    .pcm-cabecalho { display: none !important; }
    .pcm-linha { grid-template-columns: 1fr 1fr !important; row-gap: 2px; }
    .pcm-linha > span::before {
      content: attr(data-rotulo) ": ";
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--rv-texto-fraco);
    }
  }
`;

// O clique NAO pode subir: a <tr> inteira abre o atendimento (abrirModal). Era
// exatamente isso que acontecia com quem clicava na caixa das mensalidades --
// em vez de abrir o detalhamento, abria a ficha. `stopPropagation` e o conserto.
export function BotaoMensalidades({ qtd, valorRotulo, aberto, onAlternar, idPainel }) {
  return (
    <button
      type="button"
      style={S.botao}
      data-testid="botao-mensalidades"
      aria-expanded={aberto}
      aria-controls={idPainel}
      // A contagem e das mensalidades que somam ESTE valor, nesta ficha. Nao e
      // a linha "Titulos em aberto", que vem da view por CPF e pode contar
      // tambem titulos de outra ficha da mesma pessoa.
      title={
        aberto
          ? "Fechar o detalhamento das mensalidades"
          : `Ver as ${qtd} mensalidades que somam este valor`
      }
      onClick={(e) => {
        e.stopPropagation();
        onAlternar();
      }}
    >
      Mensalidades: {valorRotulo} ({qtd}) {aberto ? "▾" : "▸"}
    </button>
  );
}

// Linha extra da tabela, logo abaixo da linha do aluno. Fica numa <tr> propria,
// e nao dentro da celula de valor, porque a celula e estreita e `nowrap`: a
// grade de competencias precisa da largura toda.
export function LinhaMensalidades({ id, colSpan, nome, itens, totalRotulo }) {
  const lista = ordenarMensalidades(itens);
  return (
    <tr data-testid="linha-mensalidades">
      <td id={id} colSpan={colSpan} className="pcm-celula" style={S.celulaDetalhe}>
        <style>{CSS_MENSALIDADES}</style>
        <div style={S.painel}>
          <div style={S.cabeca}>
            <span style={S.titulo}>Mensalidades em aberto{nome ? ` — ${nome}` : ""}</span>
            <span style={S.total} data-testid="mensalidades-total">
              Total: {totalRotulo}
            </span>
          </div>

          {lista.length === 0 ? (
            <div style={S.nota}>Nenhuma mensalidade em aberto para detalhar.</div>
          ) : (
            <>
              <div style={{ ...S.linha, borderTop: "none" }} className="pcm-cabecalho">
                <span style={S.cabecalhoGrade}>Competência</span>
                <span style={S.cabecalhoGrade}>Vencimento</span>
                <span style={S.cabecalhoGrade}>Valor</span>
                <span style={S.cabecalhoGrade}>Situação</span>
              </div>
              {lista.map((m, i) => {
                const sit = situacaoMensalidade(m);
                return (
                  <div
                    key={m.documento || `${m.vencimento}-${i}`}
                    style={S.linha}
                    className="pcm-linha"
                    data-testid="mensalidade-item"
                  >
                    <span data-rotulo="Competência">{m.competencia || "—"}</span>
                    <span data-rotulo="Vencimento">{dataBR(m.vencimento)}</span>
                    <span data-rotulo="Valor" style={S.valor}>
                      {moeda(m.valor)}
                    </span>
                    <span data-rotulo="Situação" style={{ color: sit.cor, fontWeight: 700 }}>
                      {sit.texto}
                      {m.documento ? (
                        <span style={{ color: "var(--rv-texto-fraco)", fontWeight: 400 }}>
                          {" "}
                          · título {m.documento}
                        </span>
                      ) : null}
                    </span>
                  </div>
                );
              })}
              <div style={S.nota}>
                O total acima é o mesmo valor que a linha “Mensalidades” já mostra na coluna
                “Valor aberto”: estas são as mensalidades que o compõem. Mensalidades já
                vinculadas a acordo ficam fora desta lista — elas continuam na linha
                “Negociadas em acordo”, e a dívida delas já está contada em “Acordos”.
              </div>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}
