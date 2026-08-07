-- RPC em lote para a Fila de Baixas: dado um conjunto de aluno_ids, retorna
-- apenas os que AINDA têm saldo em aberto. Só-leitura, sem PII (retorna uuids).
-- Gate: restrita à gestão financeira (mesmos 3 e-mails da fila). Fail-closed.
-- Aplicada em PROD em 2026-08-06 (nome aplicado: 20260806130000_fila_baixas_alunos_com_saldo).
create or replace function public.fila_baixas_alunos_com_saldo(p_aluno_ids uuid[])
returns setof uuid
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if not public.usuario_e_gestao() then
    raise exception 'PERMISSAO_NEGADA: apenas gestao financeira';
  end if;

  return query
  select t.id
  from unnest(coalesce(p_aluno_ids, array[]::uuid[])) as t(id)
  where t.id is not null
    and public.aluno_tem_saldo_pendente(t.id);
end;
$function$;

revoke all on function public.fila_baixas_alunos_com_saldo(uuid[]) from public;
revoke all on function public.fila_baixas_alunos_com_saldo(uuid[]) from anon;
grant execute on function public.fila_baixas_alunos_com_saldo(uuid[]) to authenticated;
