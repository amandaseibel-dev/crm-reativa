import { linhaMovimentacao } from "../utils/movimentacoes";

// Linha de movimentacao usada na ficha (Aluno.jsx) e na aba Historico da
// ficha unificada. Antes cada tela repetia os mesmos quatro estilos; agora
// existe um lugar so, para as duas nao divergirem de novo.
//
// Regra de altura: UMA linha quando o texto couber, DUAS no maximo quando
// nao couber (tela estreita ou descricao longa). Nao usa `nowrap` + ellipsis,
// que cortava a frase ja na primeira linha; usa line-clamp de 2, que deixa o
// texto quebrar e corta no fim da segunda. Data e operador seguem em uma
// linha so, alinhados pela base da primeira linha do texto.
//
// O texto integral continua no `title` (tooltip) e no historico completo --
// nada de registro escondido, e a exportacao em PDF nao passa por aqui.
// Nao exportado de proposito: um arquivo que exporta componente e objeto
// junto quebra o react-refresh/only-export-components e sobe a catraca.
const estilosLinhaMovimentacao = {
  linha: {
    display: "flex",
    alignItems: "baseline",
    gap: 8,
    borderLeft: "3px solid var(--rv-borda)",
    padding: "3px 0 3px 8px",
    minWidth: 0,
  },
  data: {
    fontSize: 11.5,
    lineHeight: 1.35,
    color: "var(--rv-texto-fraco)",
    whiteSpace: "nowrap",
    fontVariantNumeric: "tabular-nums",
  },
  texto: {
    flex: 1,
    minWidth: 0,
    fontSize: 12.5,
    lineHeight: 1.35,
    color: "var(--rv-texto)",
    display: "-webkit-box",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: 2,
    overflow: "hidden",
    overflowWrap: "break-word",
  },
  operador: {
    fontSize: 11.5,
    lineHeight: 1.35,
    color: "var(--rv-texto-fraco)",
    whiteSpace: "nowrap",
  },
};

export default function LinhaMovimentacao({
  mov,
  traduzir,
  formatarCompleta,
  corBorda,
  larguraBorda = 3,
  children = null,
}) {
  const linha = linhaMovimentacao(mov, traduzir, formatarCompleta);
  return (
    <div
      title={linha.titulo}
      style={{
        ...estilosLinhaMovimentacao.linha,
        borderLeftWidth: larguraBorda,
        ...(corBorda ? { borderLeftColor: corBorda } : null),
      }}
    >
      <span style={estilosLinhaMovimentacao.data}>{linha.data}</span>
      <span style={estilosLinhaMovimentacao.texto}>{linha.texto}</span>
      {children}
      {linha.operador && (
        <span style={estilosLinhaMovimentacao.operador}>{linha.operador}</span>
      )}
    </div>
  );
}
