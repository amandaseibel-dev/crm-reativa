// ACESSO À TELA DO PREVENTIVO (espelho do portão do banco).
//
// O portão de verdade é `public.preventivo_e_gestao()` (RLS das 11 tabelas
// `prev_*`, todas as RPCs `preventivo_*` e a Edge `prev-sincronizar`): três
// e-mails E cadastro ativo em `public.usuarios`. Esta lista é só o espelho do
// lado da tela, para não mostrar o que o banco vai recusar. Se divergir, o
// banco manda. Não abre a tela para nenhum outro perfil de diretoria.
export const EMAILS_PREVENTIVO = [
  "amanda.seibel@aelbra.com.br",
  "angela.ferreira@aelbra.com.br", // diretoria, liberada no banco em 08/10/2026
  "gustavo.ene@aelbra.com.br", //     diretoria, liberado no banco em 08/10/2026
];

export function podeVerPreventivo(email) {
  const e = String(email || "").toLowerCase().trim();
  return e !== "" && EMAILS_PREVENTIVO.includes(e);
}
