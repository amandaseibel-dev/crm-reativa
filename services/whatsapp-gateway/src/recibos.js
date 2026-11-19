// RECIBOS DE ENTREGA E DE LEITURA — do vocabulário do WhatsApp para o do CRM.
//
// O CRM conhece três estados de uma mensagem que saiu:
//   ENVIADO  = entrou na nossa fila (gravado no eco da mensagem)
//   ENTREGUE = chegou ao aparelho do aluno   (dois tracinhos)
//   LIDO     = o aluno abriu a conversa      (dois tracinhos azuis)
//
// Este módulo só TRADUZ. Quem decide que o status não regride (um "entregue"
// atrasado não apaga um "lido") é o banco, na função
// `whatsapp_mensagem_atualizar_status` — a regra mora num lugar só.
//
// O que NÃO vira status: PENDING e SERVER_ACK (o servidor do WhatsApp aceitou,
// mas isso ainda não é o aluno) e ERROR (a falha de envio já tem caminho
// próprio; um ack de erro solto não pode pintar a mensagem de "falhou").

export const ENTREGUE = "ENTREGUE";
export const LIDO = "LIDO";

// Enum `proto.WebMessageInfo.Status` do Baileys:
//   0 ERROR · 1 PENDING · 2 SERVER_ACK · 3 DELIVERY_ACK · 4 READ · 5 PLAYED
// PLAYED (áudio ouvido) implica que a conversa foi aberta: conta como LIDO.
export function statusDoAck(statusBruto) {
  const n = Number(statusBruto);
  if (statusBruto === null || statusBruto === undefined || !Number.isInteger(n)) return null;
  if (n === 3) return ENTREGUE;
  if (n === 4 || n === 5) return LIDO;
  return null;
}

// `message-receipt.update` (o caminho dos grupos e de alguns aparelhos) traz
// carimbos de hora em vez de enum. Leitura ganha de entrega quando vêm juntos.
export function statusDoRecibo(recibo) {
  if (!recibo) return null;
  if (recibo.readTimestamp || recibo.playedTimestamp) return LIDO;
  if (recibo.receiptTimestamp) return ENTREGUE;
  return null;
}

// Monta o evento que vai para a fila do CRM, ou null quando não há o que
// avisar. Correlação exclusivamente por `wamid`: é a única chave estável
// entre o envio e o recibo. Telefone não entra — o CRM não precisa dele aqui.
export function eventoDeStatus({ sessao, wamid, status }) {
  if (!sessao || !wamid || !status) return null;
  return { sessao, wamid: String(wamid), status };
}
