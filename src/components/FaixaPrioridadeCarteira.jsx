// Faixa de prioridade da Minha Carteira. Puro: recebe as contagens prontas, a
// faixa selecionada e o callback -- nao conta, nao filtra e nao fala com o
// banco.
//
// POR QUE EXISTE (relato da operacao, 22/10/2026: "nao aparecem todos os casos
// classificados como Perdendo o caso, Critico, Urgente e Atencao"). A
// classificacao do backend (`alunos.nivel_criticidade`) so existia como selo
// solto em cada linha: nao dava para contar, nao dava para filtrar, e
// "Urgente" nao tinha recorte nenhum na tela. O unico filtro com essas
// palavras era o de PRAZO (dias sem acionamento), que responde outra pergunta
// -- medido em producao no mesmo dia: dos 2.336 casos ATENCAO, ZERO caiam no
// filtro "Atencao". Ver FAIXAS_PRIORIDADE em utils/carteiraFila.js.
//
// A CONTAGEM E PROMESSA. O numero de cada chip e o numero de linhas que o
// clique abre -- quem calcula e a tela, sobre o mesmo recorte, de proposito.
// Card que promete 89 e abre vazio ja aconteceu aqui (Joao, 27/08/2026).
import { FAIXAS_PRIORIDADE, PRIORIDADE_LABEL } from "../utils/carteiraFila";

const S = {
  barra: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 },
  titulo: {
    fontSize: 10.5, fontWeight: 800, textTransform: "uppercase",
    letterSpacing: "0.06em", color: "var(--rv-texto-fraco)", marginRight: 2,
  },
  chip: {
    display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer",
    background: "var(--rv-fundo-cartao)", color: "var(--rv-texto)",
    border: "1px solid var(--rv-borda)", borderRadius: 999,
    padding: "6px 12px", fontSize: 11.5, fontWeight: 700, whiteSpace: "nowrap",
  },
  // Selecionado: contorno, nao cor nova -- a cor do chip e a da faixa e nao
  // pode mudar de significado quando ele esta ligado.
  chipAtivo: { outline: "2px solid var(--rv-azul)", outlineOffset: 1 },
};

// Inline style nao faz media query. Seis faixas mais "Todos" nao cabem em
// 375px sem virar sete linhas empilhadas: no celular a faixa rola na
// horizontal, como uma barra de filtro de app.
const CSS_FAIXA = `
  @media (max-width: 640px) {
    .pc-prioridades { flex-wrap: nowrap !important; overflow-x: auto; padding-bottom: 4px; }
    .pc-prioridades > button { flex: 0 0 auto; }
  }
`;

export default function FaixaPrioridadeCarteira({ contagens, selecionada = "TODAS", onSelecionar, cores = {} }) {
  const n = (chave) => Number(contagens?.[chave] ?? 0);
  return (
    <div style={S.barra} className="pc-prioridades" data-testid="faixa-prioridade" role="group" aria-label="Filtrar por prioridade">
      <style>{CSS_FAIXA}</style>
      <span style={S.titulo}>Prioridade</span>
      <button
        type="button"
        onClick={() => onSelecionar("TODAS")}
        style={{ ...S.chip, ...(selecionada === "TODAS" ? S.chipAtivo : {}) }}
        aria-pressed={selecionada === "TODAS"}
        data-testid="chip-prioridade-TODAS"
        title="Mostra a carteira inteira, sem recorte por classificação"
      >
        Todos <b>{n("TODOS")}</b>
      </button>
      {FAIXAS_PRIORIDADE.map((faixa) => {
        const cor = cores[faixa] || {};
        const ativo = selecionada === faixa;
        return (
          <button
            key={faixa}
            type="button"
            // Clicar de novo na faixa ligada volta para "Todos": sair do
            // recorte nao pode exigir procurar outro botao.
            onClick={() => onSelecionar(ativo ? "TODAS" : faixa)}
            aria-pressed={ativo}
            data-testid={`chip-prioridade-${faixa}`}
            style={{ ...S.chip, background: cor.bg, color: cor.cor, ...(ativo ? S.chipAtivo : {}) }}
          >
            {PRIORIDADE_LABEL[faixa]} <b>{n(faixa)}</b>
          </button>
        );
      })}
    </div>
  );
}
