// ============================================================
// src/ui/blocos.jsx
// Bloco dobravel — padrao unico de "abre e fecha" do CRM.
//
// POR QUE EXISTE: cada tela tinha o seu jeito de dobrar uma secao. Em umas o
// marcador era o triangulo nativo do navegador (que muda de forma entre
// Chrome, Firefox e Safari), em outras nao havia marcador nenhum e o operador
// nao sabia que dava para clicar. Padding, cor e tamanho do titulo mudavam de
// aba para aba. Agora: uma linha clicavel inteira, seta a esquerda que gira ao
// abrir, e o mesmo espacamento em todo lugar.
//
// COMO USAR
//   <Dobra titulo="E-mails" contador={3}>...</Dobra>
//   <Dobra titulo="Acadêmico" resumo="2026/2 · Matriculado">...</Dobra>
//   <Dobra titulo="Link de pagamento" aberto={x === "link"} onAlternar={...}>
//
// Sem `aberto`, o bloco cuida do proprio estado. Passando `aberto` +
// `onAlternar`, quem manda e a tela (usado na ficha, onde abrir um bloco
// fecha os outros).
// ============================================================
import { cor, raio } from "./cards";

const TEMA = {
  claro: {
    caixa: {
      background: cor.superficieClara,
      border: `1px solid ${cor.bordaClaraInterna}`,
      borderRadius: raio.md,
    },
    // A cor vai no <summary>, nao so no titulo: a seta herda daqui. Sem isto
    // ela ficava invisivel no tema escuro (texto escuro em fundo escuro).
    sumario: { color: "#0f172a" },
    titulo: { color: "#0f172a" },
    resumo: { color: cor.rotulo },
    contador: { background: "#eef2f6", color: "#475569" },
    corpo: { borderTop: `1px solid ${cor.bordaClaraInterna}` },
  },
  escuro: {
    caixa: {
      background: cor.superficieEscura,
      border: `1px solid ${cor.bordaEscura}`,
      borderRadius: raio.md,
    },
    sumario: { color: cor.textoEscuro },
    titulo: { color: cor.textoEscuro },
    resumo: { color: "#9ca3af" },
    contador: { background: "#1f2937", color: "#d1d5db" },
    corpo: { borderTop: `1px solid ${cor.bordaEscuraSuave}` },
  },
  // Sem moldura: para dobrar um pedaco DENTRO de um cartao que ja tem borda.
  embutido: {
    caixa: { background: "transparent", border: "none", borderRadius: 0 },
    sumario: { color: "#334155" },
    titulo: { color: "#334155" },
    resumo: { color: cor.rotulo },
    contador: { background: "#eef2f6", color: "#475569" },
    corpo: { borderTop: "none" },
  },
};

const base = {
  sumario: { padding: "8px 12px", fontSize: 13, fontWeight: 700, margin: 0 },
  titulo: { fontSize: 13, fontWeight: 700, whiteSpace: "nowrap" },
  resumo: {
    fontSize: 12.5,
    fontWeight: 500,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  contador: {
    flex: "none",
    fontSize: 11,
    fontWeight: 700,
    borderRadius: 999,
    padding: "1px 8px",
  },
  corpo: { padding: "10px 12px" },
};

export default function Dobra({
  titulo,
  resumo,          // texto curto que fica visivel com o bloco FECHADO
  contador,        // numero no titulo: fechado com "(3)" ninguem perde o conteudo
  aberto,          // controlado (opcional)
  onAlternar,      // (proximoEstado: boolean) => void
  tema = "claro",
  refBloco,
  style,
  estiloSumario,
  extraNoResumo,   // nó livre à direita do titulo (ex.: chips de semestre)
  children,
}) {
  const t = TEMA[tema] || TEMA.claro;
  const controlado = typeof aberto === "boolean";

  function aoAlternar(evento) {
    if (!onAlternar) return;
    onAlternar(evento.currentTarget.open);
  }

  return (
    <details
      className="rv-dobra"
      ref={refBloco}
      {...(controlado ? { open: aberto } : {})}
      onToggle={aoAlternar}
      style={{ ...t.caixa, ...style }}
    >
      <summary style={{ ...base.sumario, ...t.sumario, ...estiloSumario }}>
        <span className="rv-dobra-seta" aria-hidden="true">▶</span>
        <span style={{ ...base.titulo, ...t.titulo }}>{titulo}</span>
        {contador != null && contador !== "" ? (
          <span style={{ ...base.contador, ...t.contador }}>{contador}</span>
        ) : null}
        {extraNoResumo}
        {resumo ? <span style={{ ...base.resumo, ...t.resumo }}>{resumo}</span> : null}
      </summary>
      <div style={{ ...base.corpo, ...t.corpo }}>{children}</div>
    </details>
  );
}
