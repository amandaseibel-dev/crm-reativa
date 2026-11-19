// Quais ações exigem qual configuração de ambiente (decisão pura, testada).
// O fluxo OAuth (iniciar/concluir) exige client_id e redirect_uri. As demais exigem só a chave de cifra.
// No PILOTO com token pessoal, ULBRA_OAUTH_CLIENT_ID e ULBRA_OAUTH_REDIRECT_URI NÃO são configuradas:
// então conexao_iniciar e conexao_concluir respondem 503 antes de qualquer troca de código.
// Isso mantém o caminho que gera grant OAuth indisponível no piloto.

const ACOES_OAUTH = ["conexao_iniciar", "conexao_concluir"] as const;
const ACOES_CHAVE = [
  "conexao_token_pessoal", "conexao_desconectar", "conexao_estado",
  "envio_previa", "envio_confirmar", "envio_capacidade", "historico_ler", "historico_capacidade",
] as const;

export function precisaOauth(acao: string): boolean {
  return (ACOES_OAUTH as readonly string[]).includes(acao);
}

export function precisaChave(acao: string): boolean {
  return (ACOES_CHAVE as readonly string[]).includes(acao);
}

/** true = a ação deve ser recusada por configuração ausente (503 CONEXAO_NAO_CONFIGURADA). */
export function configuracaoFaltando(acao: string, c: { clientId: string | undefined; redirectUri: string | undefined; chave: string | undefined }): boolean {
  if (precisaOauth(acao) && (!c.clientId || !c.redirectUri || !c.chave)) return true;
  if (precisaChave(acao) && !c.chave) return true;
  return false;
}
