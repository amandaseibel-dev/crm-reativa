// ===========================================================================
// Histórico ULBRA na Central — porta de tela e regra de quem vê o botão.
//
// HISTORICO_DISPONIVEL = true é a PORTA DE TELA que acompanha o merge. Ela NÃO é o portão de
// leitura: quem decide é o SERVIDOR. Com ULBRA_HISTORICO_HABILITADO ausente ou fora da lista do piloto,
// `historico_capacidade` responde HISTORICO_DESLIGADO (pode=false) e `historico_ler` nega antes da
// Mensageria; a linha da lista só recebe capacidade_historico=true quando o servidor concede.
// Por isso, com o piloto desligado, a lista não mostra o botão e a conversa, se pedir, recebe negativa
// do servidor sem nenhuma chamada à Mensageria.
// Ordem de implantação: docs/integracoes/pacote-historico-e-resposta-2026-11-11.md (passo 9)
// e docs/integracoes/piloto-token-pessoal-2026-11-17.md.
//
// podeVerHistorico: só mostra o botão quando o servidor marca a linha com
// capacidade_historico === true. Esse campo é o contrato da lista: a RPC
// ulbra_central_conversas_periodo AINDA NÃO o produz (migration pendente), então
// hoje a lista fica fechada. A conversa usa historico_capacidade do servidor.
// A função reconfere tudo no servidor; aqui é só para não oferecer um clique negado.
// ===========================================================================
export const HISTORICO_DISPONIVEL = true;

// Visibilidade vem do SERVIDOR, não de lista de perfil nem de regra de responsável duplicada aqui.
export function podeVerHistorico(linha) {
  return Boolean(linha) && linha.capacidade_historico === true;
}
