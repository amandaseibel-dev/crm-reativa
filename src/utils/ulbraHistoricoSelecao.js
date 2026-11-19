// Leitura do histórico da conversa selecionada na Central, SOB CLIQUE.
//
// Regras:
// - Nada é lido ao selecionar ou abrir a Central.
// - Conversa sem vínculo (sem aluno_id) nunca é lida.
// - Ao trocar de seleção, o histórico anterior some e respostas atrasadas são ignoradas.
// A permissão continua no servidor (ação historico_ler da ulbra-conversa); aqui só controlamos a chamada.
import { lerHistorico as lerPadrao, mapearHistorico } from "./ulbraHistoricoCliente";
import { HISTORICO_DISPONIVEL } from "./ulbraHistorico";

export function historicoInicial() {
  return { estado: "indisponivel", mensagens: [] };
}

/**
 * Pode a Central ler o histórico deste item? Só com a porta HISTORICO_DISPONIVEL ligada,
 * e só para resposta de aluno com vínculo. Com a porta desligada, nem botão nem chamada.
 */
export function podeLerHistoricoNaCentral(item) {
  return HISTORICO_DISPONIVEL === true && conversaParaLer(item) !== null;
}

/** Id da conversa a ler, ou null. Só respostas de aluno com vínculo confirmado. */
export function conversaParaLer(item) {
  if (!item || item.tipo !== "resposta" || !item.alunoId) return null;
  return item.bruto && item.bruto.conversa_id ? item.bruto.conversa_id : null;
}

/**
 * Controle de leitura de uma tela. `ver` lê só quando chamado (clique).
 * `cancelar` deve ser chamado ao trocar de seleção: qualquer resposta pendente
 * deixa de ser entregue.
 */
export function criarLeituraHistorico(leitor = lerPadrao) {
  let atual = 0;
  return {
    cancelar() {
      atual += 1;
    },
    async ver(conversaId, onResultado) {
      atual += 1;
      const meu = atual;
      onResultado({ estado: "carregando", mensagens: [] });
      try {
        const resp = await leitor(conversaId);
        if (meu === atual) onResultado(mapearHistorico(resp));
      } catch {
        if (meu === atual) {
          onResultado({ estado: "erro", mensagens: [], erro: "não foi possível carregar o histórico" });
        }
      }
    },
  };
}
