-- Volta o gatilho ao texto anterior (sem a chamada de identificacao) e remove a funcao nova.
-- Nao desfaz o backfill: cpf/aluno_id ja preenchidos sao identificacao correta, nao precisam reverter.
create or replace function public._pagamento_conciliar()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
begin
  perform public.pagamento_conciliar_um(new.id, true);
  return null;
end;
$fn$;

revoke all on function public._pagamento_conciliar() from public, anon, authenticated;

drop function if exists public.pagamentos_resolver_identificacao(uuid);
