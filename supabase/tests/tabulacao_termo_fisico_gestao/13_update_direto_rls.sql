-- Prova a TRIGGER isoladamente (login BYPASSRLS, descartável). UPDATE direto que alcança a trigger. Como authenticated não tem policy de UPDATE (RLS filtra a zero linhas
-- antes da trigger), este teste roda como app_teste_rls: LOGIN com BYPASSRLS, não é postgres nem supabase_admin
-- (portanto NÃO tem o bypass de manutenção). Zero linhas NÃO conta como prova: exigimos o erro específico.
\set ON_ERROR_STOP on
create or replace function pg_temp.negado(p_sql text) returns text language plpgsql as $$
declare v_state text; v_msg text;
begin
  execute p_sql; return 'SEM_ERRO';
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  return v_state || '|' || v_msg;
end $$;
select set_config('request.jwt.claims', '{"email":"amanda.seibel@aelbra.com.br","role":"authenticated"}', false);
do $$
declare r text; v_antes text; v_depois text;
begin
  select status_novo into v_antes from public.aluno_movimentacoes where aluno_id = 'c1' and tipo = 'REGISTRO_ADMINISTRATIVO' limit 1;
  r := pg_temp.negado($sql$update public.aluno_movimentacoes set status_novo = 'TERMO_FISICO_EM_ANDAMENTO' where aluno_id = 'c1' and tipo = 'REGISTRO_ADMINISTRATIVO'$sql$);
  if r not like '42501|Registro de termo físico suspenso pela gestão (contenção). Nada foi gravado.%' then
    raise exception 'FALHOU UPDATE direto (gestão, contenção): %', r; end if;
  select status_novo into v_depois from public.aluno_movimentacoes where aluno_id = 'c1' and tipo = 'REGISTRO_ADMINISTRATIVO' limit 1;
  if v_antes is distinct from v_depois then raise exception 'FALHOU: UPDATE recusado alterou a linha'; end if;
end $$;
select 'OK 13_update_direto_rls (contenção)' as resultado;
