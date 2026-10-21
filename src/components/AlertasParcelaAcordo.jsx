// Card de alerta de parcela de acordo (Minha Carteira). Puro: recebe os alertas
// e o callback de abrir a ficha.
//
// Fonte unica do D-2 (RPC acordo_alertas_do_operador); substitui o card antigo
// de lembrete por data_retorno.
//
// POR QUE EXISTE LIMITE, desde 21/10/2026. A M2 (20261021092408) passou a
// devolver tambem as parcelas VENCIDAS de ate 30 dias -- medido: 1.022 no total,
// cerca de 144 por operador, contra 23 alertas em TODA a base antes dela. O card
// renderizava uma linha por alerta, sem teto, e a tela do operador ficou longa
// demais: o que importa ficava abaixo de quatro blocos e de duas linhas de KPI.
// Agora o card abre COMPACTO (contagem + total + as `limite` mais urgentes) e
// expande sob clique. Nenhuma informacao foi removida -- so deixou de ser
// despejada de uma vez.
import { useState } from "react";
import { ordenarAlertas, chaveAlerta, descricaoAlerta, formatarDataBR, formatarValorBRL } from "../utils/alertasParcela";
import { situacaoAcionamento, textoVencimento, ordenarPorAcionamento, PRIORIDADE } from "../utils/acionamentoAlerta";

const S = {
  painel: { border: "1px solid var(--rv-borda)", borderRadius: 12, padding: "10px 12px", margin: "0 0 10px", background: "var(--rv-card)" },
  cabeca: { display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", justifyContent: "space-between" },
  titulo: { margin: 0, fontSize: 14, fontWeight: 800, color: "var(--rv-azul-texto)" },
  resumo: { fontSize: 12.5, color: "var(--rv-texto-suave)", fontWeight: 600 },
  // Grade em vez de frase corrida: as colunas alinham entre as linhas, entao o
  // olho percorre uma coluna so em vez de reler a frase inteira a cada linha.
  item: {
    display: "grid",
    gridTemplateColumns: "minmax(0,1.6fr) minmax(0,0.9fr) minmax(0,0.8fr) minmax(0,1.5fr) auto",
    alignItems: "center", columnGap: 10, padding: "5px 0",
    borderTop: "1px solid var(--rv-borda)",
  },
  nome: { background: "none", border: "none", padding: 0, fontWeight: 700, color: "var(--rv-texto)", cursor: "pointer", textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  col: { fontSize: 12, color: "var(--rv-texto-suave)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  valor: { fontSize: 12.5, fontWeight: 700, color: "var(--rv-texto)", textAlign: "right" },
  ref: { fontSize: 11, color: "var(--rv-texto-fraco)", marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  selo: { fontSize: 11.5, fontWeight: 700, borderRadius: 999, padding: "2px 8px", display: "inline-block", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  botao: { border: "1px solid var(--rv-borda)", borderRadius: 8, padding: "5px 9px", background: "var(--rv-fundo)", color: "var(--rv-texto)", cursor: "pointer", fontWeight: 700, whiteSpace: "nowrap" },
  verTodas: { marginTop: 6, border: "1px dashed var(--rv-borda)", borderRadius: 8, padding: "6px 10px", background: "transparent", color: "var(--rv-azul-texto)", cursor: "pointer", fontWeight: 700, fontSize: 12.5, width: "100%" },
};

// Inline style nao faz media query. No celular a linha precisa EMPILHAR: com o
// botao ao lado, a descricao fica com ~240px e quebra em 5 ou 6 linhas -- medido
// em 21/10/2026, 245px por linha num iPhone de 375px. Empilhado, a descricao usa
// a largura toda e a linha cai para cerca de um terco disso.
const CSS_ALERTAS = `
  @media (max-width: 760px) {
    .apa-item { grid-template-columns: 1fr auto !important; row-gap: 2px; }
    .apa-item .apa-nome  { grid-column: 1; }
    .apa-item .apa-acao  { grid-column: 2; grid-row: 1 / span 2; align-self: start; }
    /* Vencimento e valor na MESMA linha: no celular cada um sozinho desperdica
       altura, e o valor alinhado a direita ficava solto. */
    .apa-item .apa-venc  { grid-column: 1; text-align: left; }
    .apa-item .apa-valor { grid-column: 2; text-align: right; align-self: center; }
    .apa-item .apa-selo  { grid-column: 1 / -1; text-align: left; }
    /* O texto da situacao e o ponto da linha: no estreito ele QUEBRA em vez de
       ser cortado com reticencias. "Sem aviso especifico identific..." nao
       informa nada. */
    .apa-item .apa-selo > span { white-space: normal; overflow: visible; }
  }
`;

function somar(lista) {
  return lista.reduce((t, a) => t + (Number(a.valor) || 0), 0);
}

// `titulo` existe porque a mesma lista serve a mais de um recorte: o D-2
// classico, o alerta que o bloco "Meu dia" nao mostra e, desde a M2, as
// parcelas vencidas de ate 30 dias.
//
// `limite` null (o padrao) mantem o comportamento antigo: lista inteira aberta.
// Passar um numero faz o card abrir compacto, com expansao sob clique.
export default function AlertasParcelaAcordo({
  alertas,
  onAbrirFicha,
  mostrarResponsavel = false,
  titulo,
  limite = null,
  rotuloExpandir,
  acionamentoPorAluno = null,
  hoje,
}) {
  const [expandido, setExpandido] = useState(false);
  const base = ordenarAlertas(alertas);
  // Quem NAO tem aviso comprovado sobe no recorte compacto. A prioridade
  // operacional de sempre (dias_restantes) continua ordenando dentro de cada
  // grupo -- nada e reordenado contra ela.
  const lista = acionamentoPorAluno ? ordenarPorAcionamento(base, acionamentoPorAluno, hoje) : base;
  if (lista.length === 0) return null;

  const corta = limite != null && lista.length > limite && !expandido;
  const visiveis = corta ? lista.slice(0, limite) : lista;
  const ocultas = lista.length - visiveis.length;

  return (
    <section style={S.painel} aria-label="Parcela de acordo próxima do vencimento" data-testid="alertas-parcela-acordo">
      <style>{CSS_ALERTAS}</style>
      <div style={S.cabeca}>
        <h3 style={S.titulo}>{titulo || "🔔 Parcela de acordo próxima do vencimento"} ({lista.length})</h3>
        <span style={S.resumo} data-testid="alertas-parcela-total">{formatarValorBRL(somar(lista))}</span>
      </div>
      {visiveis.map((a) => (
        <div key={chaveAlerta(a)} style={S.item} className="apa-item" data-testid="alerta-parcela-item">
          <div className="apa-nome" style={{ minWidth: 0 }}>
            <button type="button" style={S.nome} onClick={() => onAbrirFicha && onAbrirFicha(a)} title="Abrir ficha do aluno">
              {a.aluno_nome || "Aluno"}
            </button>
            <div style={S.ref}>
              {descricaoAlerta(a)}
              {mostrarResponsavel ? ` · ${a.responsavel_email || "sem responsável"}` : ""}
            </div>
          </div>
          <div className="apa-venc" style={S.col} title={`vencimento ${formatarDataBR(a.vencimento)}`}>
            {textoVencimento(a, hoje)}
          </div>
          <div className="apa-valor" style={S.valor}>{formatarValorBRL(a.valor)}</div>
          {/* Sem o indice a tela NAO consultou nada -- entao nao afirma nada,
              nem o neutro: "sem aviso identificado" sugeriria que procuramos. */}
          <div className="apa-selo" style={{ minWidth: 0 }}>
            {acionamentoPorAluno && (() => {
              const info = acionamentoPorAluno.get ? acionamentoPorAluno.get(String(a.aluno_id)) : null;
              const s = situacaoAcionamento({ dua: info?.dua, vencimento: a.vencimento, hoje, temCaso: Boolean(info) });
              const cor =
                s.prioridade <= PRIORIDADE.NAO_ACIONADO
                  ? { background: "var(--rv-vermelho-fundo, #fee2e2)", color: "var(--rv-vermelho, #b91c1c)" }
                  : s.prioridade === PRIORIDADE.SO_ANTES
                    ? { background: "var(--rv-ambar-fundo, #fef3c7)", color: "var(--rv-ambar-texto, #92400e)" }
                    : { background: "var(--rv-fundo-cartao, #f1f5f9)", color: "var(--rv-texto-suave, #475569)" };
              return (
                <span style={{ ...S.selo, ...cor }} title={s.texto} data-testid="alerta-parcela-acionamento">
                  {s.texto}
                </span>
              );
            })()}
          </div>
          <button type="button" style={S.botao} className="apa-acao" onClick={() => onAbrirFicha && onAbrirFicha(a)}>
            Abrir ficha
          </button>
        </div>
      ))}
      {limite != null && lista.length > limite && (
        <button
          type="button"
          style={S.verTodas}
          data-testid="alertas-parcela-expandir"
          aria-expanded={expandido}
          onClick={() => setExpandido((v) => !v)}
        >
          {expandido ? "Recolher" : `${rotuloExpandir || "Ver todas"} (${ocultas} a mais)`}
        </button>
      )}
    </section>
  );
}
