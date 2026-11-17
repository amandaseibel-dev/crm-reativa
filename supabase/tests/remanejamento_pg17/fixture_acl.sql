-- ACL de producao das funcoes do remanejamento (lida em 17/11/2026):
-- execute para postgres, authenticated e service_role; NENHUM para PUBLIC/anon.
-- A fixture recria os corpos, mas nao as permissoes; isto as reproduz.
revoke all on function public.carteira_geral_previa(uuid[], text, text, boolean, jsonb, uuid[]) from public, anon;
revoke all on function public.carteira_geral_mover(uuid, text) from public, anon;
revoke all on function public.calibragem_executar_simulacao(uuid) from public, anon;
revoke all on function public.carteira_geral_definir_recebimento(text, boolean, text) from public, anon;
revoke all on function public.liberar_casos_fidelizacao_vencida(integer) from public, anon;
