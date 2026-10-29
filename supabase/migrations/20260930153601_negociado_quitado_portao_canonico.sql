-- ============================================================================
-- O portao da RPC de reconciliacao passa a ser o portao CANONICO da casa.
-- ============================================================================
-- A RPC nasceu (hoje) com um portao proprio: auth.role()='service_role' ou
-- usuario_e_gestao(). Isso a deixava INCOMPATIVEL com o resto do sistema:
--
--   . sem JWT (cron/backend), auth.role() e null -> a RPC recusava;
--   . para passar, seria preciso setar request.jwt.claims -- e ai auth.jwt()
--     deixa de ser null, o que faz `crm_usuario_pode_quitar_baixar()` cair no
--     ramo de E-MAIL e recusar la embaixo, na cadeia
--     titulo_reavaliar -> _trg_auto_quitar_titulo -> _talvez_quitar_aluno
--     -> sincronizar_alunos_unificados -> bloquear_alteracoes_restritas_aluno.
--
-- `crm_usuario_pode_quitar_baixar()` ja e O portao de quitar/baixar deste CRM,
-- e esta operacao e exatamente uma quitacao. Ele ja trata os dois mundos:
--   . com JWT  -> so as tres pessoas da gestao financeira;
--   . sem JWT  -> so os papeis de backend (postgres/supabase_admin/service_role);
--   . e nega sempre o executor de responsavel.
--
-- Usar o mesmo portao NAO AFROUXA nada: troca um portao proprio e mais estreito
-- num ponto e mais largo noutro por aquele que o sistema ja aplica a toda
-- quitacao. E evita forjar identidade de pessoa so para executar rotina.
-- ============================================================================

do $do$
declare
  v_def text;
  v_novo text;
  v_ancora text := 'if coalesce(auth.role(),'''') <> ''service_role'' and not public.usuario_e_gestao() then';
  v_troca  text := 'if not public.crm_usuario_pode_quitar_baixar() then';
  v_vezes int;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'mensalidade_reconciliar_negociado_quitado';

  if v_def is null then
    raise exception 'ABORTA: mensalidade_reconciliar_negociado_quitado nao existe';
  end if;

  if position(v_troca in v_def) > 0 then
    raise notice 'JA AJUSTADA: o portao canonico ja esta no corpo';
    return;
  end if;

  v_vezes := (length(v_def) - length(replace(v_def, v_ancora, ''))) / length(v_ancora);
  if v_vezes <> 1 then
    raise exception 'ABORTA: ancora encontrada % vezes, esperado 1', v_vezes;
  end if;

  v_novo := replace(v_def, v_ancora, v_troca);

  if position(v_troca in v_novo) = 0 then
    raise exception 'ABORTA: a troca nao entrou';
  end if;
  if position(v_ancora in v_novo) <> 0 then
    raise exception 'ABORTA: a ancora sobreviveu';
  end if;

  execute v_novo;
  raise notice 'AJUSTADA: portao canonico crm_usuario_pode_quitar_baixar()';
end
$do$;