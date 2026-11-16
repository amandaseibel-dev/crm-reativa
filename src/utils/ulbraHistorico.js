// ===========================================================================
// Histórico ULBRA na Central — porta de tela e regra de quem vê o botão.
//
// HISTORICO_DISPONIVEL: a tela só monta o botão "Histórico" quando a função
// ação `historico_ler` da `ulbra-conversa` estiver publicada com ULBRA_HISTORICO_HABILITADO=true.
// Enquanto for `false`, nada muda na Central (nem botão, nem chamada). Ligar é
// uma PR de uma linha, depois da publicação — ordem do pacote
// `docs/integracoes/pacote-historico-isolado.md`.
//
// podeVerHistorico: só conversa com CPF confirmado (`aluno_id`) e só quem a
// função também aceita — gestão (perfil amplo) ou o responsável da linha
// (`minha`). A função reconfere tudo no servidor; aqui é só para não oferecer
// um clique que seria negado.
// ===========================================================================
export const HISTORICO_DISPONIVEL = false;

export function podeVerHistorico(linha, ehGestao = false) {
  if (!linha || !linha.aluno_id) return false;
  if (ehGestao === true) return true;
  return linha.minha === true;
}
