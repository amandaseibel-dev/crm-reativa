-- Fecha a ultima porta da mesma familia de 20260912130752.
--
-- O DEFEITO. acordo_reconstruir_cron() e security definer, tinha EXECUTE para
-- `authenticated`, nao tem portao de permissao proprio (so o disjuntor de
-- carga) e a primeira coisa que faz e:
--     perform set_config('reativa.fluxo_pagamentos','on', true);
--     return public.acordo_reconstruir_lote(200);
-- Ou seja: liga a chave que abre o portao da rotina que faz o trabalho e a
-- chama. Qualquer usuario logado reconstruia 200 acordos com um
-- supabase.rpc('acordo_reconstruir_cron').
--
-- VERIFICADO ANTES DE REVOGAR (12/09/2026, 14h UTC):
--   * cron.job com 'acordo_reconstruir' no comando ......... NENHUM (e orfa)
--   * outras funcoes do banco que a chamam ................. NENHUMA
--   * gatilhos que a usam .................................. NENHUM
--   * views/regras que a referenciam ....................... NENHUMA
--   * ocorrencias em src/ .................................. NENHUMA
--   * ocorrencias em supabase/functions/ ................... NENHUMA
--   * registro de execucao em auditoria .................... NENHUM
--   * ACL antes ............................................ postgres=X/postgres
--                                                            authenticated=X/postgres
--                                                            service_role=X/postgres
--
-- Nenhuma execucao da funcao foi feita nesta migration, nem para testar.
--
-- acordo_reconstruir_lote(integer) NAO e revogada: ela mantem EXECUTE para
-- `authenticated` mas tem portao proprio -- exige `reativa.fluxo_pagamentos=on`
-- OU service_role OU usuario_e_gestao(). Chamada direta por operador ja recebe
-- 42501. O problema era so o involucro sem portao.

revoke all on function public.acordo_reconstruir_cron() from public, anon, authenticated;

comment on function public.acordo_reconstruir_cron() is
  'Involucro que liga reativa.fluxo_pagamentos e chama acordo_reconstruir_lote(200). NAO tem portao proprio -- por isso EXECUTE fica restrito ao dono e ao service_role. Se algum dia precisar de botao na tela, crie uma RPC com portao usuario_e_gestao() que chame esta por dentro, em vez de conceder EXECUTE a authenticated.';

do $$
declare v_auth boolean; v_anon boolean; v_pub boolean; v_dono boolean; v_srv boolean;
begin
  select has_function_privilege('authenticated', p.oid, 'EXECUTE'),
         has_function_privilege('anon',          p.oid, 'EXECUTE'),
         has_function_privilege('public',        p.oid, 'EXECUTE'),
         has_function_privilege('postgres',      p.oid, 'EXECUTE'),
         has_function_privilege('service_role',  p.oid, 'EXECUTE')
    into v_auth, v_anon, v_pub, v_dono, v_srv
    from pg_proc p where p.proname = 'acordo_reconstruir_cron';

  if v_auth or v_anon or v_pub then
    raise exception 'acordo_reconstruir_cron segue exposta: authenticated=% anon=% public=%',
      v_auth, v_anon, v_pub;
  end if;
  if not v_dono then
    raise exception 'acordo_reconstruir_cron perdeu o EXECUTE do dono';
  end if;
  if not v_srv then
    raise exception 'acordo_reconstruir_cron perdeu o EXECUTE de service_role';
  end if;

  -- a varredura que originou esta migration nao pode sobrar com resultado:
  -- involucro que liga a chave, sem portao, chamavel por authenticated.
  if exists (
    select 1 from pg_proc p
     where p.prosrc like '%set_config%'
       and p.prosrc like '%reativa.fluxo_pagamentos%'
       and p.prosrc not like '%usuario_e_gestao%'
       and pg_get_function_result(p.oid) <> 'trigger'
       and has_function_privilege('authenticated', p.oid, 'EXECUTE')
  ) then
    raise exception 'ainda existe involucro sem portao chamavel por authenticated';
  end if;

  raise notice 'acordo_reconstruir_cron fechada; varredura da familia sem sobra';
end $$;
