// Critério de quem pode CONFERIR um envio em aberto (decisão administrativa).
// Fonte do perfil: perfil_do_usuario_atual(), chamada com o JWT do próprio conferidor.
// Qualquer valor fora desta lista, ou ausente, nega. Nunca concede por padrão.
export const PERFIS_CONFERENCIA: readonly string[] = ["supervisor", "gerencia", "administrativo"];

export function podeConferir(perfil: unknown): boolean {
  return typeof perfil === "string" && PERFIS_CONFERENCIA.includes(perfil);
}
