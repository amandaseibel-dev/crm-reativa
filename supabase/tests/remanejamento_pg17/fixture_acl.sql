-- ACL de producao das funcoes do remanejamento (lida em 17/11/2026):
-- execute para postgres, authenticated e service_role; NENHUM para PUBLIC/anon.
-- A fixture recria os corpos, mas nao as permissoes; isto as reproduz.
revoke all on function public.carteira_geral_previa(uuid[], text, text, boolean, jsonb, uuid[]) from public, anon;
revoke all on function public.carteira_geral_mover(uuid, text) from public, anon;
revoke all on function public.calibragem_executar_simulacao(uuid) from public, anon;
revoke all on function public.carteira_geral_definir_recebimento(text, boolean, text) from public, anon;
revoke all on function public.liberar_casos_fidelizacao_vencida(integer) from public, anon;
-- funcoes do adendo da #936 (ACL de producao: postgres, authenticated, service_role)
revoke all on function public.assumir_caso_livre(uuid) from public, anon;
revoke all on function public.casos_risco_perder(text) from public, anon;
revoke all on function public.usuario_e_gestao() from public, anon;
revoke all on function public.liberar_fidelizacao_caso(uuid, text, text) from public, anon;
revoke all on function public.trg_impor_teto_operador() from public, anon;
-- producao: EXECUTE para authenticated e service_role (postgres e dono)
grant execute on function public.carteira_geral_previa(uuid[], text, text, boolean, jsonb, uuid[]) to authenticated, service_role;
grant execute on function public.carteira_geral_mover(uuid, text) to authenticated, service_role;
grant execute on function public.calibragem_executar_simulacao(uuid) to authenticated, service_role;
grant execute on function public.carteira_geral_definir_recebimento(text, boolean, text) to authenticated, service_role;
grant execute on function public.liberar_casos_fidelizacao_vencida(integer) to authenticated, service_role;
grant execute on function public.assumir_caso_livre(uuid) to authenticated, service_role;
grant execute on function public.casos_risco_perder(text) to authenticated, service_role;
grant execute on function public.usuario_e_gestao() to authenticated, service_role;
grant execute on function public.liberar_fidelizacao_caso(uuid, text, text) to authenticated, service_role;
grant execute on function public.trg_impor_teto_operador() to authenticated, service_role;
