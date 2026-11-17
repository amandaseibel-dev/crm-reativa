// ===========================================================================
// Histórico ULBRA na Central — porta de tela e regra de quem vê o botão.
//
// HISTORICO_DISPONIVEL: a tela só monta o botão "Histórico" quando a função
// ação `historico_ler` da `ulbra-conversa` estiver publicada com ULBRA_HISTORICO_HABILITADO=true.
// Enquanto for `false`, nada muda na Central (nem botão, nem chamada). Ligar é
// uma PR de uma linha, depois da publicação — ordem do pacote
// `docs/integracoes/pacote-historico-e-resposta-2026-11-11.md`.
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
