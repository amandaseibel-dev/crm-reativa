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
import { ordenarAlertas, chaveAlerta, descricaoAlerta, rotuloDiasRestantes, formatarDataBR, formatarValorBRL } from "../utils/alertasParcela";

const S = {
  painel: { border: "1px solid var(--rv-borda)", borderRadius: 12, padding: "10px 12px", margin: "0 0 10px", background: "var(--rv-card)" },
  cabeca: { display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", justifyContent: "space-between" },
  titulo: { margin: 0, fontSize: 14, fontWeight: 800, color: "var(--rv-azul-texto)" },
  resumo: { fontSize: 12.5, color: "var(--rv-texto-suave)", fontWeight: 600 },
  item: { display: "flex", alignItems: "center", gap: 12, justifyContent: "space-between", padding: "6px 0", borderTop: "1px solid var(--rv-borda)" },
  nome: { background: "none", border: "none", padding: 0, fontWeight: 700, color: "var(--rv-texto)", cursor: "pointer", textAlign: "left" },
  meta: { fontSize: 12, color: "var(--rv-texto-suave)", marginTop: 1 },
  botao: { border: "1px solid var(--rv-borda)", borderRadius: 8, padding: "5px 9px", background: "var(--rv-fundo)", color: "var(--rv-texto)", cursor: "pointer", fontWeight: 700, whiteSpace: "nowrap" },
  verTodas: { marginTop: 6, border: "1px dashed var(--rv-borda)", borderRadius: 8, padding: "6px 10px", background: "transparent", color: "var(--rv-azul-texto)", cursor: "pointer", fontWeight: 700, fontSize: 12.5, width: "100%" },
};

// Inline style nao faz media query. No celular a linha precisa EMPILHAR: com o
// botao ao lado, a descricao fica com ~240px e quebra em 5 ou 6 linhas -- medido
// em 21/10/2026, 245px por linha num iPhone de 375px. Empilhado, a descricao usa
// a largura toda e a linha cai para cerca de um terco disso.
const CSS_ALERTAS = `
  @media (max-width: 640px) {
    .apa-item { flex-wrap: wrap; row-gap: 6px; }
    .apa-item .apa-acao { width: 100%; text-align: center; }
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
}) {
  const [expandido, setExpandido] = useState(false);
  const lista = ordenarAlertas(alertas);
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
          <div style={{ minWidth: 0, flex: "1 1 200px" }}>
            <button type="button" style={S.nome} onClick={() => onAbrirFicha && onAbrirFicha(a)} title="Abrir ficha do aluno">
              {a.aluno_nome || "Aluno"}
            </button>
            <div style={S.meta}>
              {descricaoAlerta(a)} · {formatarValorBRL(a.valor)} · vence em {formatarDataBR(a.vencimento)} · <strong>{rotuloDiasRestantes(a.dias_restantes)}</strong>
              {mostrarResponsavel ? ` · responsável: ${a.responsavel_email || "sem responsável"}` : ""}
            </div>
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
