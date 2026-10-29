// FORMATO E CATÁLOGO DAS SEIS LINHAS — só dado, nenhum componente.
//
// Separado de `SituacoesDaSafra.jsx` por exigência da regra
// `react-refresh/only-export-components`: um arquivo que exporta componentes
// não pode exportar constantes e funções junto, senão o fast refresh para de
// funcionar. A regra é da casa e a catraca do lint reprova.

export const moeda = (v) =>
  Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 2 });
export const num = (v) => Number(v || 0).toLocaleString("pt-BR");
// "1 alunos · 1 títulos" é o tipo de detalhe que faz a diretoria desconfiar do
// resto dos números. Plural só quando é plural.
export const plural = (n, um, muitos) => num(n) + " " + (Number(n) === 1 ? um : muitos);
export const dataCurta = (v) =>
  v ? new Date(v.length === 10 ? v + "T12:00:00" : v).toLocaleDateString("pt-BR") : "—";

// Cores por PAPEL, sempre em token: o tema escuro troca o valor de cada token e
// a tela acompanha sem mudar JSX.
export const AZUL = "var(--rv-azul)", VERDE = "var(--rv-verde-ok)", VERMELHO = "var(--rv-vermelho)",
             AMBAR = "var(--rv-ambar)", CINZA = "var(--rv-texto-suave)";

// A ordem é a da gestão: Entrou é a base, as quatro situações vêm depois, e
// Pendente fecha, separado por uma linha, porque NÃO é uma quinta situação — é
// o que ainda não foi classificado.
//
// "valor efetivamente recebido" saiu de propósito: parte do Pago vem de rateio
// do acordo, e o rodapé diz quanto. Prometer atribuição exata onde há rateio é
// o tipo de frase que derruba a confiança no painel inteiro.
export const SITUACOES = [
  { k: "pago",      r: "Pago",      cor: VERDE,    ajuda: "recebido atribuído ao título" },
  { k: "negociado", r: "Negociado", cor: AZUL,     ajuda: "saldo ainda não pago de acordo ativo" },
  { k: "cancelado", r: "Cancelado", cor: CINZA,    ajuda: "cobrança do título cancelada" },
  { k: "em_aberto", r: "Em aberto", cor: VERMELHO, ajuda: "saldo sem acordo ativo" },
];
export const PENDENTE = { k: "pendente", r: "Pendente de classificação", cor: AMBAR,
                          ajuda: "em conferência e ajuste acadêmico, à parte de propósito" };

export function vazio() { return { alunos: 0, titulos: 0, valor: 0 }; }

export const S = {
  cabecalho: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12,
               flexWrap: "wrap", marginBottom: 12 },
  h2: { margin: 0, fontSize: 12.5, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase",
        color: "var(--rv-texto-fraco)" },
  apoio: { fontSize: 12, color: "var(--rv-texto-fraco)", fontVariantNumeric: "tabular-nums" },

  // auto-fit com mínimo de 320px: em telas largas os cartões ficam lado a lado
  // e em 375px cada um ocupa a largura inteira, sem rolagem horizontal.
  grade: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 },

  cartao: { background: "var(--rv-superficie)", border: "1px solid var(--rv-borda-suave)", borderRadius: 16,
            padding: "16px 18px 18px", boxShadow: "var(--rv-sombra)", display: "flex", flexDirection: "column" },
  cartaoTopo: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10,
                flexWrap: "wrap", paddingBottom: 10, borderBottom: "1px solid var(--rv-borda-suave)" },
  mesNome: { fontSize: 16, fontWeight: 800, letterSpacing: "-0.01em",
             fontFamily: "'Sora', Inter, sans-serif" },
  mesApoio: { fontSize: 11.5, color: "var(--rv-texto-fraco)", fontVariantNumeric: "tabular-nums" },

  entrou: { display: "flex", flexDirection: "column", gap: 2, padding: "12px 0 10px" },
  entrouRotulo: { fontSize: 11.5, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase",
                  color: "var(--rv-texto-fraco)" },
  entrouValor: { fontSize: 24, fontWeight: 800, lineHeight: 1.1, letterSpacing: "-0.03em",
                 fontFamily: "'Sora', Inter, sans-serif", fontVariantNumeric: "tabular-nums" },
  entrouApoio: { fontSize: 12, color: "var(--rv-texto-suave)", fontVariantNumeric: "tabular-nums" },

  linha: { padding: "9px 0" },
  linhaTopo: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto auto", alignItems: "baseline",
               columnGap: 10 },
  linhaRotulo: { fontSize: 13.5, fontWeight: 600, minWidth: 0 },
  linhaValor: { fontSize: 13.5, fontWeight: 700, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" },
  linhaPct: { fontSize: 13, fontWeight: 700, minWidth: 52, textAlign: "right",
              fontVariantNumeric: "tabular-nums" },
  linhaApoio: { display: "block", fontSize: 11.5, color: "var(--rv-texto-fraco)", marginTop: 3,
                fontVariantNumeric: "tabular-nums" },
  ponto: { display: "inline-block", width: 9, height: 9, borderRadius: 3, marginRight: 8 },
  trilho: { background: "var(--rv-fundo-suave)", borderRadius: 999, height: 6, overflow: "hidden", marginTop: 7 },
  barra: { height: "100%", borderRadius: 999 },
  separador: { height: 1, background: "var(--rv-borda-suave)", margin: "4px 0" },

  composicao: { display: "flex", flexWrap: "wrap", columnGap: 14, rowGap: 2, marginTop: 4,
                fontSize: 11.5, color: "var(--rv-texto-suave)", fontVariantNumeric: "tabular-nums" },

  statusBloco: { marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--rv-borda-suave)" },
  statusTitulo: { fontSize: 11, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase",
                  color: "var(--rv-texto-fraco)" },
  statusLista: { listStyle: "none", margin: "8px 0 0", padding: 0, display: "flex",
                 flexDirection: "column", gap: 4 },
  statusItem: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10,
                fontSize: 12.5 },
  statusNome: { color: "var(--rv-texto-suave)", minWidth: 0 },
  statusQtd: { fontWeight: 700, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" },

  rodape: { fontSize: 12, color: "var(--rv-texto-fraco)", lineHeight: 1.6, margin: "12px 0 0" },
  discreto: { fontSize: 12.5, color: "var(--rv-texto-fraco)", lineHeight: 1.6 },
  erro: { color: "var(--rv-vermelho-texto)", fontSize: 13, margin: "10px 0" },
};
