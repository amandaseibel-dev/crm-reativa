// Rótulos pt-BR dos motivos de indisponibilidade das Ações Massivas (códigos do banco).
const ROTULO_MOTIVO = {
  quitado: "Quitado",
  liquidado_prime: "Já consta liquidado no Prime",
  encerrado_operacional: "Caso encerrado",
  confirmacao_pendente: "Aguardando confirmação financeira",
  fora_tipo_cobranca: "Fora do tipo de cobrança",
  retorno_futuro: "Retorno futuro",
  outro_responsavel: "Fora do responsável selecionado",
  acao_massiva_recente: "Ação massiva recente neste canal",
  contato_indisponivel: "Sem contato válido para o canal",
  valor_fora_da_faixa: "Valor fora da faixa",
};
export const rotuloMotivo = (m) => ROTULO_MOTIVO[m] || m;

